/**
 * Protocol tests for SmtpSession (RFC 5321 / 2920 / 4954 / 3207 / 1870).
 *
 * The session is driven over a real loopback TCP connection on an ephemeral port.
 * All SmtpHandlers are in-memory fakes — no database, Redis or MinIO.
 *
 * Run (from the repository root, Node >= 22.15):
 *   node --experimental-transform-types --import ./packages/smtp-server/src/test-hooks.mjs \
 *        --test packages/smtp-server/src/core/session.test.ts
 */
import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { SmtpSession } from './session.js';
import { selfSignedTestCert } from '../test-cert.js';
import type { AuthUser, EsmtpExtensions, MessageMeta, SmtpSessionConfig } from './types.js';

// ─── Test harness ────────────────────────────────────────────────────────────

interface Reply {
  code: number;
  lines: string[];
  text: string;
}

class SmtpClient {
  private buffer = '';
  private wake: (() => void) | null = null;
  private readonly socket: net.Socket;
  closed = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.wake?.();
    });
    socket.on('close', () => {
      this.closed = true;
      this.wake?.();
    });
    socket.on('error', () => { /* surfaced through closed */ });
  }

  write(raw: string): void {
    this.socket.write(raw, 'latin1');
  }

  private takeLine(): string | null {
    const idx = this.buffer.indexOf('\r\n');
    if (idx === -1) return null;
    const line = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 2);
    return line;
  }

  async readLine(timeoutMs = 2000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = this.takeLine();
      if (line !== null) return line;
      if (this.closed) throw new Error('connection closed while waiting for a line');
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timeout waiting for a line (buffered: ${JSON.stringify(this.buffer)})`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  }

  /** Reads one complete (possibly multi-line) SMTP reply. */
  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        return { code: parseInt(line.slice(0, 3), 10), lines, text: lines.join('\n') };
      }
    }
  }

  async cmd(line: string): Promise<Reply> {
    this.write(`${line}\r\n`);
    return this.reply();
  }

  /** Waits `ms` and returns every complete line received so far. */
  async drain(ms = 150): Promise<string[]> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    const lines: string[] = [];
    for (let line = this.takeLine(); line !== null; line = this.takeLine()) lines.push(line);
    return lines;
  }

  async waitForClose(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return this.closed;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

interface Recorded {
  mailFrom: string[];
  rcptTo: string[];
  credentials: Array<{ username: string; password: string }>;
  messages: Array<{ raw: Buffer; from: string; to: string[]; authUser: AuthUser | null; meta?: MessageMeta }>;
}

interface Harness {
  client: SmtpClient;
  recorded: Recorded;
}

interface HarnessOptions {
  config?: Partial<SmtpSessionConfig>;
  /** Enables AUTH with exactly one valid account: user@example.test / secret */
  auth?: boolean;
  handlerDelayMs?: number;
  onRcptTo?: (to: string) => Promise<string | null>;
  onMessage?: () => Promise<void>;
}

const VALID_USER: AuthUser = { id: 'u1', email: 'user@example.test' };
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
let cachedCert: { cert: Buffer; key: Buffer } | null = null;
const testCert = (): { cert: Buffer; key: Buffer } => (cachedCert ??= selfSignedTestCert());

/** Starts a one-connection SMTP server on loopback and returns a connected client (greeting NOT yet read). */
async function connect(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const recorded: Recorded = { mailFrom: [], rcptTo: [], credentials: [], messages: [] };
  const wait = options.handlerDelayMs ?? 0;

  const config: SmtpSessionConfig = {
    hostname: 'mx.example.test',
    maxSize: 1024,
    maxRcpt: 3,
    requireAuth: false,
    handlers: {
      onConnect: async () => true,
      onMailFrom: async (from) => {
        if (wait) await delay(wait);
        recorded.mailFrom.push(from);
        return null;
      },
      onRcptTo: async (to) => {
        if (wait) await delay(wait);
        recorded.rcptTo.push(to);
        return options.onRcptTo ? options.onRcptTo(to) : null;
      },
      onMessage: async (raw, from, to, authUser, _ip, meta) => {
        recorded.messages.push({ raw, from, to, authUser, ...(meta ? { meta } : {}) });
        if (options.onMessage) await options.onMessage();
      },
    },
    ...(options.auth
      ? {
          verifyCredentials: async (username: string, password: string) => {
            recorded.credentials.push({ username, password });
            return username === VALID_USER.email && password === 'secret' ? VALID_USER : null;
          },
        }
      : {}),
    ...options.config,
  };

  // v7: AUTH is only offered on encrypted connections, so the AUTH harness
  // runs over implicit TLS (the port 465 configuration).
  const server = options.auth
    ? tls.createServer({ ...testCert() }, (socket) => new SmtpSession(socket, config).start())
    : net.createServer((socket) => new SmtpSession(socket, config).start());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  const socket = options.auth
    ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false })
    : net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once(options.auth ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });
  const client = new SmtpClient(socket);
  t.after(() => {
    client.destroy();
    server.close();
  });
  return { client, recorded };
}

/** Connects and completes greeting + EHLO. */
async function connectReady(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const harness = await connect(t, options);
  await harness.client.reply();
  await harness.client.cmd('EHLO client.example.test');
  return harness;
}

/** Connects and opens a transaction with one accepted recipient. */
async function connectWithRecipient(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const harness = await connectReady(t, options);
  await harness.client.cmd('MAIL FROM:<alice@example.test>');
  await harness.client.cmd('RCPT TO:<bob@example.test>');
  return harness;
}

/** Extension flags with SMTPUTF8, DSN and CHUNKING switched off (pre-8.1 behaviour). */
const EXT_OFF: EsmtpExtensions = {
  starttls: true, authPlain: true, authLogin: true, authCramMd5: false, pipelining: true, size: true,
  bit8mime: true, enhancedStatus: true, smtputf8: false, dsn: false, chunking: false,
};

function ehloKeywords(reply: Reply): string[] {
  return reply.lines.slice(1).map((line) => (line.slice(4).split(' ')[0] ?? '').toUpperCase());
}

// ─── Greeting ────────────────────────────────────────────────────────────────

describe('greeting (RFC 5321 §4.2)', () => {
  test('sends 220 with the server hostname first', async (t) => {
    const { client } = await connect(t);

    const greeting = await client.reply();

    assert.equal(greeting.text, '220 mx.example.test ESMTP CoreMail');
  });

  test('uses the configured banner text instead of the default', async (t) => {
    const { client } = await connect(t, { config: { bannerText: '  mail.example.test ready  ' } });

    const greeting = await client.reply();

    assert.equal(greeting.text, '220 mail.example.test ready');
  });
});

// ─── EHLO / HELO ─────────────────────────────────────────────────────────────

describe('EHLO / HELO (RFC 5321 §4.1.1.1)', () => {
  test('EHLO answers with a multi-line 250 reply whose last line uses a space separator', async (t) => {
    const { client } = await connect(t);
    await client.reply();

    const reply = await client.cmd('EHLO client.example.test');

    assert.equal(reply.code, 250);
    assert.ok(reply.lines.length > 1);
    assert.ok(reply.lines.slice(0, -1).every((line) => line.startsWith('250-')));
    assert.match(reply.lines.at(-1) ?? '', /^250 /);
  });

  test('EHLO advertises exactly the implemented extensions', async (t) => {
    const { client } = await connect(t, { auth: true });
    await client.reply();

    const reply = await client.cmd('EHLO client.example.test');

    assert.deepEqual(ehloKeywords(reply).sort(), [
      '8BITMIME', 'AUTH', 'BINARYMIME', 'CHUNKING', 'DSN', 'ENHANCEDSTATUSCODES', 'PIPELINING', 'SIZE', 'SMTPUTF8',
    ]);
  });

  test('EHLO keyword order follows Exchange 2019 (SIZE … SMTPUTF8)', async (t) => {
    const { client } = await connect(t, { config: { tls: testCert() } });
    await client.reply();

    const reply = await client.cmd('EHLO client.example.test');

    assert.deepEqual(ehloKeywords(reply), [
      'SIZE', 'PIPELINING', 'DSN', 'ENHANCEDSTATUSCODES', 'STARTTLS', '8BITMIME', 'BINARYMIME', 'CHUNKING', 'SMTPUTF8',
    ]);
  });

  test('EHLO advertises the configured maximum message size (RFC 1870)', async (t) => {
    const { client } = await connect(t);
    await client.reply();

    const reply = await client.cmd('EHLO client.example.test');

    assert.ok(reply.lines.includes('250-SIZE 1024') || reply.lines.includes('250 SIZE 1024'));
  });

  test('EHLO advertises only AUTH PLAIN and LOGIN', async (t) => {
    const { client } = await connect(t, { auth: true });
    await client.reply();

    const reply = await client.cmd('EHLO client.example.test');

    assert.ok(reply.lines.some((line) => line.slice(4) === 'AUTH PLAIN LOGIN'));
  });

  test('EHLO never advertises CRAM-MD5 even if the settings flag is on', async (t) => {
    const everythingOn: EsmtpExtensions = {
      starttls: true, authPlain: true, authLogin: true, authCramMd5: true, pipelining: true, size: true,
      bit8mime: true, enhancedStatus: true, smtputf8: true, dsn: true, chunking: true,
    };
    const { client } = await connect(t, { auth: true, config: { esmtp: everythingOn } });
    await client.reply();

    const reply = await client.cmd('EHLO client.example.test');

    assert.doesNotMatch(reply.text, /CRAM-MD5/);
  });

  test('switched-off SMTPUTF8, DSN and CHUNKING are neither advertised nor accepted', async (t) => {
    const { client } = await connectReady(t, { config: { esmtp: EXT_OFF } });

    assert.equal((await client.cmd('EHLO client.example.test')).text.match(/SMTPUTF8|CHUNKING|\bDSN\b|BINARYMIME/), null);
    assert.equal((await client.cmd('MAIL FROM:<a@example.test> SMTPUTF8')).code, 555);
    assert.equal((await client.cmd('MAIL FROM:<a@example.test> RET=HDRS')).code, 555);
    assert.equal((await client.cmd('MAIL FROM:<a@example.test> BODY=BINARYMIME')).code, 555);
    assert.equal((await client.cmd('MAIL FROM:<a@example.test>')).code, 250);
    assert.equal((await client.cmd('RCPT TO:<b@example.test> NOTIFY=SUCCESS')).code, 555);
    assert.equal((await client.cmd('BDAT 5 LAST')).code, 500);
  });

  test('EHLO does not advertise AUTH when no credential verifier is configured', async (t) => {
    const { client } = await connect(t);
    await client.reply();

    const reply = await client.cmd('EHLO client.example.test');

    assert.ok(!ehloKeywords(reply).includes('AUTH'));
  });

  test('EHLO does not advertise STARTTLS when no certificate is configured', async (t) => {
    const { client } = await connect(t);
    await client.reply();

    const reply = await client.cmd('EHLO client.example.test');

    assert.ok(!ehloKeywords(reply).includes('STARTTLS'));
  });

  test('STARTTLS without a certificate is refused with 502', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('STARTTLS');

    assert.equal(reply.code, 502);
  });

  test('HELO answers with a single-line 250', async (t) => {
    const { client } = await connect(t);
    await client.reply();

    const reply = await client.cmd('HELO client.example.test');

    assert.deepEqual(reply.lines, ['250 mx.example.test']);
  });

  test('EHLO without a domain argument is a syntax error (501)', async (t) => {
    // RFC 5321 §4.1.1.1: ehlo = "EHLO" SP ( Domain / address-literal ) CRLF — the argument is mandatory.
    const { client } = await connect(t);
    await client.reply();

    const reply = await client.cmd('EHLO');

    assert.equal(reply.code, 501);
  });

  test('command verbs are case-insensitive (RFC 5321 §2.4)', async (t) => {
    const { client, recorded } = await connect(t);
    await client.reply();

    await client.cmd('ehlo client.example.test');
    const reply = await client.cmd('mail from:<alice@example.test>');

    assert.equal(reply.code, 250);
    assert.deepEqual(recorded.mailFrom, ['alice@example.test']);
  });
});

// ─── Command sequencing ──────────────────────────────────────────────────────

describe('command sequence (RFC 5321 §4.1.4)', () => {
  test('MAIL before EHLO/HELO is rejected with 503', async (t) => {
    const { client } = await connect(t);
    await client.reply();

    const reply = await client.cmd('MAIL FROM:<alice@example.test>');

    assert.equal(reply.code, 503);
  });

  test('RCPT before MAIL is rejected with 503', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('RCPT TO:<bob@example.test>');

    assert.equal(reply.code, 503);
  });

  test('DATA without an accepted recipient is rejected with 503', async (t) => {
    const { client } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test>');

    const reply = await client.cmd('DATA');

    assert.equal(reply.code, 503);
  });

  test('a second MAIL inside an open transaction is rejected with 503', async (t) => {
    const { client } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test>');

    const reply = await client.cmd('MAIL FROM:<carol@example.test>');

    assert.equal(reply.code, 503);
  });

  test('RSET aborts the open transaction', async (t) => {
    const { client } = await connectWithRecipient(t);

    const rset = await client.cmd('RSET');
    const rcptAfterReset = await client.cmd('RCPT TO:<carol@example.test>');

    assert.equal(rset.code, 250);
    assert.equal(rcptAfterReset.code, 503);
  });

  test('EHLO inside a transaction resets it like RSET', async (t) => {
    const { client } = await connectWithRecipient(t);

    await client.cmd('EHLO client.example.test');
    const reply = await client.cmd('DATA');

    assert.equal(reply.code, 503);
  });

  test('an unknown command is answered with 500', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('FROBNICATE now');

    assert.equal(reply.code, 500);
  });

  test('BDAT without an open transaction is a bad sequence (503); its chunk is consumed', async (t) => {
    const { client } = await connectReady(t);

    client.write('BDAT 6 LAST\r\nNOOP\r\n');
    const reply = await client.reply();

    assert.equal(reply.code, 503);
    assert.equal((await client.cmd('NOOP')).code, 250, 'the chunk "NOOP\\r\\n" was not run as a command');
  });

  test('NOOP is answered with 250 and ignores its argument', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('NOOP ignored');

    assert.equal(reply.code, 250);
  });

  test('VRFY is answered with 252 (cannot verify, will accept), never 502', async (t) => {
    // Changed from "502": VRFY is part of the minimum implementation (RFC 5321 §4.5.1); a server that
    // does not verify addresses MUST answer 252 rather than a code that looks like a failure (§3.5.3, §7.3).
    const { client } = await connectReady(t);

    const reply = await client.cmd('VRFY bob');
    const bare = await client.cmd('VRFY');

    assert.equal(reply.code, 252);
    assert.equal(bare.code, 501);
  });

  test('QUIT answers 221 and closes the connection', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('QUIT');
    const closed = await client.waitForClose();

    assert.equal(reply.code, 221);
    assert.equal(closed, true);
  });

  test('a command line longer than 1000 octets is answered with 500 and the session survives', async (t) => {
    const { client } = await connectReady(t);

    const tooLong = await client.cmd(`NOOP ${'x'.repeat(1100)}`);
    const next = await client.cmd('NOOP');

    assert.equal(tooLong.code, 500);
    assert.equal(next.code, 250);
  });
});

// ─── MAIL FROM / RCPT TO argument parsing ────────────────────────────────────

describe('MAIL FROM / RCPT TO parsing (RFC 5321 §4.1.1.2–3)', () => {
  test('the null reverse-path <> is accepted', async (t) => {
    const { client, recorded } = await connectReady(t);

    const reply = await client.cmd('MAIL FROM:<>');

    assert.equal(reply.code, 250);
    assert.deepEqual(recorded.mailFrom, ['']);
  });

  test('the reverse-path keeps the case of its local-part; only the domain is lower-cased', async (t) => {
    // Changed from "lower case": RFC 5321 §2.4 — the local-part MUST be treated as case sensitive and its
    // case MUST be preserved when relaying. Handlers normalize for their own (case-insensitive) lookups.
    const { client, recorded } = await connectReady(t);

    await client.cmd('MAIL FROM:<Alice@Example.TEST>');
    await client.cmd('RCPT TO:<Bob.Smith@Example.TEST>');

    assert.deepEqual(recorded.mailFrom, ['Alice@example.test']);
    assert.deepEqual(recorded.rcptTo, ['Bob.Smith@example.test']);
  });

  test('a reverse-path without angle brackets is a syntax error (501)', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('MAIL FROM:alice@example.test');

    assert.equal(reply.code, 501);
  });

  test('a reverse-path without a domain is a syntax error (501)', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('MAIL FROM:<alice>');

    assert.equal(reply.code, 501);
  });

  test('MAIL with the wrong keyword "TO:" is a syntax error (501)', async (t) => {
    // RFC 5321 §4.1.1.2: mail = "MAIL FROM:" Reverse-path [SP Mail-parameters] CRLF
    const { client } = await connectReady(t);

    const reply = await client.cmd('MAIL TO:<alice@example.test>');

    assert.equal(reply.code, 501);
  });

  test('RCPT with the wrong keyword "FROM:" is a syntax error (501)', async (t) => {
    // RFC 5321 §4.1.1.3: rcpt = "RCPT TO:" ( "<Postmaster@" Domain ">" / "<Postmaster>" / Forward-path ) ...
    const { client } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test>');

    const reply = await client.cmd('RCPT FROM:<bob@example.test>');

    assert.equal(reply.code, 501);
  });

  test('a declared SIZE above the limit is rejected with 552 before any data is sent (RFC 1870 §6.1)', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('MAIL FROM:<alice@example.test> SIZE=999999');

    assert.equal(reply.code, 552);
  });

  test('a declared SIZE within the limit is accepted', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('MAIL FROM:<alice@example.test> SIZE=512');

    assert.equal(reply.code, 250);
  });

  test('the BODY=8BITMIME parameter is accepted (RFC 6152)', async (t) => {
    const { client, recorded } = await connectReady(t);

    const reply = await client.cmd('MAIL FROM:<alice@example.test> BODY=8BITMIME');

    assert.equal(reply.code, 250);
    assert.deepEqual(recorded.mailFrom, ['alice@example.test']);
  });

  test('an unrecognized MAIL parameter is rejected with 555', async (t) => {
    // RFC 5321 §4.1.1.11: "If the server SMTP does not recognize or cannot implement one or more of
    // the parameters associated with a particular MAIL FROM or RCPT TO command, it will return code 555."
    const { client } = await connectReady(t);

    const reply = await client.cmd('MAIL FROM:<alice@example.test> XUNKNOWN=1');

    assert.equal(reply.code, 555);
  });

  test('an empty forward-path <> is a syntax error (501)', async (t) => {
    const { client } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test>');

    const reply = await client.cmd('RCPT TO:<>');

    assert.equal(reply.code, 501);
  });

  test('the domain-less <Postmaster> recipient is accepted', async (t) => {
    // RFC 5321 §4.1.1.3: 'servers MUST recognize the special case "RCPT TO:<Postmaster>"'
    const { client } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test>');

    const reply = await client.cmd('RCPT TO:<Postmaster>');

    assert.equal(reply.code, 250);
  });

  test('recipients beyond the configured maximum are refused with 452', async (t) => {
    const { client } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test>');
    await client.cmd('RCPT TO:<r1@example.test>');
    await client.cmd('RCPT TO:<r2@example.test>');
    await client.cmd('RCPT TO:<r3@example.test>');

    const reply = await client.cmd('RCPT TO:<r4@example.test>');

    assert.equal(reply.code, 452);
  });

  test('a recipient rejected by the handler gets 550 and is not part of the transaction', async (t) => {
    const { client } = await connectReady(t, { onRcptTo: async () => '5.1.1 User unknown' });
    await client.cmd('MAIL FROM:<alice@example.test>');

    const rcpt = await client.cmd('RCPT TO:<nobody@example.test>');
    const data = await client.cmd('DATA');

    assert.equal(rcpt.text, '550 5.1.1 User unknown');
    assert.equal(data.code, 503);
  });

  test('a transient handler rejection ("4.3.0 …") is sent with a 4yz reply code', async (t) => {
    // inbound/handler.ts onRcptTo returns '4.3.0 Temporary failure' when the recipient lookup throws.
    // RFC 2034 §4 / RFC 3463 §2: the class of the enhanced status code must match the reply code class;
    // RFC 5321 §4.2.1: 5yz tells the sender NOT to retry, i.e. the mail bounces on a temporary DB error.
    const { client } = await connectReady(t, { onRcptTo: async () => '4.3.0 Temporary failure' });
    await client.cmd('MAIL FROM:<alice@example.test>');

    const reply = await client.cmd('RCPT TO:<bob@example.test>');

    assert.equal(Math.floor(reply.code / 100), 4, `got: ${reply.text}`);
  });

  test('a handler that throws results in a temporary 451', async (t) => {
    const { client } = await connectReady(t, { onRcptTo: async () => { throw new Error('db down'); } });
    await client.cmd('MAIL FROM:<alice@example.test>');

    const reply = await client.cmd('RCPT TO:<bob@example.test>');

    assert.equal(reply.code, 451);
  });
});

// ─── PIPELINING ──────────────────────────────────────────────────────────────

describe('PIPELINING (RFC 2920)', () => {
  test('MAIL, RCPT, RCPT, DATA sent in one packet are processed in order despite slow handlers', async (t) => {
    const { client } = await connectReady(t, { handlerDelayMs: 30 });

    client.write(
      'MAIL FROM:<alice@example.test>\r\nRCPT TO:<bob@example.test>\r\nRCPT TO:<carol@example.test>\r\nDATA\r\n',
    );
    const codes = [
      (await client.reply()).code,
      (await client.reply()).code,
      (await client.reply()).code,
      (await client.reply()).code,
    ];

    assert.deepEqual(codes, [250, 250, 250, 354]);
  });

  test('a pipelined DATA after a rejected recipient is refused instead of swallowing commands as body', async (t) => {
    const { client } = await connectReady(t, { handlerDelayMs: 10, onRcptTo: async () => '5.1.1 User unknown' });

    client.write('MAIL FROM:<alice@example.test>\r\nRCPT TO:<nobody@example.test>\r\nDATA\r\n');
    const codes = [(await client.reply()).code, (await client.reply()).code, (await client.reply()).code];
    const noop = await client.cmd('NOOP');

    assert.deepEqual(codes, [250, 550, 503]);
    assert.equal(noop.code, 250);
  });

  test('message content, terminator and QUIT in one packet yield 250 then 221', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');

    client.write('Subject: x\r\n\r\nbody\r\n.\r\nQUIT\r\n');
    const accepted = await client.reply();
    const bye = await client.reply();

    assert.equal(accepted.code, 250);
    assert.equal(bye.code, 221);
    assert.equal(recorded.messages.length, 1);
  });
});

// ─── DATA ────────────────────────────────────────────────────────────────────

describe('DATA (RFC 5321 §4.1.1.4, §4.5.2)', () => {
  test('DATA with a recipient is answered with 354', async (t) => {
    const { client } = await connectWithRecipient(t);

    const reply = await client.cmd('DATA');

    assert.equal(reply.code, 354);
  });

  test('the handler receives envelope and content exactly as sent', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');

    const reply = await client.cmd('Subject: hi\r\n\r\nline one\r\nline two\r\n.');

    assert.equal(reply.code, 250);
    assert.equal(recorded.messages.length, 1);
    assert.equal(recorded.messages[0]?.from, 'alice@example.test');
    assert.deepEqual(recorded.messages[0]?.to, ['bob@example.test']);
    assert.equal(recorded.messages[0]?.raw.toString('latin1'), 'Subject: hi\r\n\r\nline one\r\nline two\r\n');
  });

  test('a leading dot added by the client is removed again (dot-stuffing)', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');

    await client.cmd('..leading dot\r\n...two dots\r\n..\r\n.');

    assert.equal(recorded.messages[0]?.raw.toString('latin1'), '.leading dot\r\n..two dots\r\n.\r\n');
  });

  test('a dot followed by other characters does not terminate the message', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');

    client.write('. \r\n.x\r\n');
    const premature = await client.drain();
    await client.cmd('.');

    assert.deepEqual(premature, []);
    assert.equal(recorded.messages.length, 1);
  });

  test('a bare-LF "<LF>.<LF>" sequence does not terminate the message (SMTP smuggling)', async (t) => {
    // RFC 5321 §4.1.1.4: only <CRLF>.<CRLF> ends the mail data; §2.3.8: bare LF must not be treated as line end.
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');

    client.write('first\n.\nMAIL FROM:<evil@example.test>\r\n');
    const premature = await client.drain();
    await client.cmd('.');

    assert.deepEqual(premature, []);
    assert.equal(recorded.messages.length, 1);
    assert.deepEqual(recorded.mailFrom, ['alice@example.test']);
  });

  test('8-bit octets in the content are preserved byte for byte (8BITMIME)', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');
    const utf8Body = Buffer.from('Grüße – ✓\r\n', 'utf8');

    await client.cmd(`${utf8Body.toString('latin1')}.`);

    assert.deepEqual(recorded.messages[0]?.raw, utf8Body);
  });

  test('the transaction is closed after the message: RCPT needs a new MAIL', async (t) => {
    const { client } = await connectWithRecipient(t);
    await client.cmd('DATA');
    await client.cmd('x\r\n.');

    const rcpt = await client.cmd('RCPT TO:<carol@example.test>');
    const mail = await client.cmd('MAIL FROM:<alice@example.test>');

    assert.equal(rcpt.code, 503);
    assert.equal(mail.code, 250);
  });

  test('content above the size limit is rejected with 552 and not delivered', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');

    client.write(`${'x'.repeat(900)}\r\n${'y'.repeat(900)}\r\n.\r\n`);
    const reply = await client.reply();

    assert.equal(reply.code, 552);
    assert.equal(recorded.messages.length, 0);
  });

  test('oversized content is consumed up to the terminator and never interpreted as commands', async (t) => {
    // RFC 5321 §4.1.1.4: after 354 the server treats ALL following lines as mail data until <CRLF>.<CRLF>
    // and sends exactly ONE reply after the terminator. Answering mid-stream and switching back to command
    // mode makes the rest of the message body executable as SMTP commands.
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');

    client.write(
      `${'x'.repeat(900)}\r\n${'y'.repeat(900)}\r\n` +
      'MAIL FROM:<injected@example.test>\r\nRCPT TO:<victim@example.test>\r\n' +
      '.\r\n',
    );
    const replies = await client.drain(300);

    assert.equal(replies.length, 1, `expected a single 552 reply, got: ${JSON.stringify(replies)}`);
    assert.deepEqual(recorded.mailFrom, ['alice@example.test']);
  });

  test('a permanent error thrown by the message handler ("550 …") is passed through', async (t) => {
    const { client } = await connectWithRecipient(t, {
      onMessage: async () => { throw new Error('550 5.7.1 Message rejected'); },
    });
    await client.cmd('DATA');

    const reply = await client.cmd('x\r\n.');

    assert.equal(reply.text, '550 5.7.1 Message rejected');
  });

  test('an unexpected handler error becomes a temporary 451', async (t) => {
    const { client } = await connectWithRecipient(t, {
      onMessage: async () => { throw new Error('MinIO unreachable'); },
    });
    await client.cmd('DATA');

    const reply = await client.cmd('x\r\n.');

    assert.equal(reply.code, 451);
  });

  test('a transient error thrown with its own code ("452 …") is passed through unchanged', async (t) => {
    // A reply line must carry exactly one reply code (RFC 5321 §4.2); "451 4.3.0 452 4.2.2 …" is malformed.
    const { client } = await connectWithRecipient(t, {
      onMessage: async () => { throw new Error('452 4.2.2 Mailbox full'); },
    });
    await client.cmd('DATA');

    const reply = await client.cmd('x\r\n.');

    assert.equal(reply.text, '452 4.2.2 Mailbox full');
  });
});

// ─── AUTH ────────────────────────────────────────────────────────────────────

describe('AUTH (RFC 4954)', () => {
  test('AUTH PLAIN with an initial response authenticates with 235', async (t) => {
    const { client } = await connectReady(t, { auth: true });

    const reply = await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);

    assert.equal(reply.code, 235);
  });

  test('AUTH PLAIN uses authcid and password, not the authzid (RFC 4616)', async (t) => {
    const { client, recorded } = await connectReady(t, { auth: true });

    await client.cmd(`AUTH PLAIN ${b64('admin@example.test\0user@example.test\0secret')}`);

    assert.deepEqual(recorded.credentials, [{ username: 'user@example.test', password: 'secret' }]);
  });

  test('AUTH PLAIN without an initial response sends an empty 334 challenge first', async (t) => {
    const { client } = await connectReady(t, { auth: true });

    const challenge = await client.cmd('AUTH PLAIN');
    const result = await client.cmd(b64('\0user@example.test\0secret'));

    assert.equal(challenge.text, '334 ');
    assert.equal(result.code, 235);
  });

  test('AUTH LOGIN prompts for username and password in base64', async (t) => {
    const { client } = await connectReady(t, { auth: true });

    const userPrompt = await client.cmd('AUTH LOGIN');
    const passPrompt = await client.cmd(b64('user@example.test'));
    const result = await client.cmd(b64('secret'));

    assert.equal(userPrompt.text, `334 ${b64('Username:')}`);
    assert.equal(passPrompt.text, `334 ${b64('Password:')}`);
    assert.equal(result.code, 235);
  });

  test('AUTH LOGIN with the username as initial response continues with the password prompt', async (t) => {
    // Interoperability (not an RFC): many clients send "AUTH LOGIN <base64 username>"; a server that ignores
    // the initial response and asks for the username again takes the password as the username.
    const { client } = await connectReady(t, { auth: true });

    const prompt = await client.cmd(`AUTH LOGIN ${b64('user@example.test')}`);

    assert.equal(prompt.text, `334 ${b64('Password:')}`);
  });

  test('the username is normalized to lower case before verification', async (t) => {
    const { client, recorded } = await connectReady(t, { auth: true });

    await client.cmd(`AUTH PLAIN ${b64('\0User@Example.TEST\0secret')}`);

    assert.equal(recorded.credentials[0]?.username, 'user@example.test');
  });

  test('wrong credentials are rejected with 535', async (t) => {
    const { client } = await connectReady(t, { auth: true });

    const reply = await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0wrong')}`);

    assert.equal(reply.code, 535);
  });

  test('the session stays usable after a failed AUTH', async (t) => {
    const { client } = await connectReady(t, { auth: true });
    await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0wrong')}`);

    const retry = await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);

    assert.equal(retry.code, 235);
  });

  test('a client can cancel the exchange with "*" and gets 501', async (t) => {
    const { client } = await connectReady(t, { auth: true });
    await client.cmd('AUTH LOGIN');

    const reply = await client.cmd('*');

    assert.equal(reply.code, 501);
  });

  test('an unsupported mechanism is rejected with 504', async (t) => {
    const { client } = await connectReady(t, { auth: true });

    const reply = await client.cmd('AUTH CRAM-MD5');

    assert.equal(reply.code, 504);
  });

  test('a second AUTH after success is rejected with 503', async (t) => {
    const { client } = await connectReady(t, { auth: true });
    await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);

    const reply = await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);

    assert.equal(reply.code, 503);
  });

  test('AUTH inside a mail transaction is rejected with 503', async (t) => {
    const { client } = await connectReady(t, { auth: true });
    await client.cmd('MAIL FROM:<alice@example.test>');

    const reply = await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);

    assert.equal(reply.code, 503);
  });

  test('AUTH before EHLO is rejected with 503', async (t) => {
    const { client } = await connect(t, { auth: true });
    await client.reply();

    const reply = await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);

    assert.equal(reply.code, 503);
  });

  test('MAIL without authentication is rejected with 530 when authentication is required', async (t) => {
    const { client } = await connectReady(t, { auth: true, config: { requireAuth: true } });

    const reply = await client.cmd('MAIL FROM:<alice@example.test>');

    assert.equal(reply.code, 530);
  });

  test('the authenticated user is handed to the message handler', async (t) => {
    const { client, recorded } = await connectReady(t, { auth: true, config: { requireAuth: true } });
    await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);
    await client.cmd('MAIL FROM:<user@example.test>');
    await client.cmd('RCPT TO:<bob@example.test>');
    await client.cmd('DATA');

    await client.cmd('x\r\n.');

    assert.deepEqual(recorded.messages[0]?.authUser, VALID_USER);
  });

  test('RSET keeps the authenticated state', async (t) => {
    const { client } = await connectReady(t, { auth: true, config: { requireAuth: true } });
    await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);

    await client.cmd('RSET');
    const reply = await client.cmd('MAIL FROM:<user@example.test>');

    assert.equal(reply.code, 250);
  });
});

// ─── Timeouts ────────────────────────────────────────────────────────────────

describe('timeouts (RFC 5321 §4.5.3.2)', () => {
  test('an idle session is closed with 421 after five minutes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client } = await connect(t);
    await client.reply();

    t.mock.timers.tick(5 * 60_000);
    const reply = await client.reply();

    assert.equal(reply.code, 421);
  });
});

// ─── Robustness (added with the oversize-DATA / line-cap fix) ────────────────

describe('input limits and reply codes', () => {
  test('an unterminated command line above 64 KiB closes the connection with 500', async (t) => {
    const { client } = await connectReady(t);

    client.write(`NOOP ${'x'.repeat(70 * 1024)}`);
    const reply = await client.reply();
    const closed = await client.waitForClose();

    assert.equal(reply.code, 500);
    assert.equal(closed, true);
  });

  test('an unterminated body line above the maximum message size closes the connection', async (t) => {
    const { client, recorded } = await connectWithRecipient(t, { config: { maxSize: 1024 } });
    await client.cmd('DATA');

    client.write('z'.repeat(70 * 1024));
    const reply = await client.reply();
    const closed = await client.waitForClose();

    assert.equal(reply.code, 500);
    assert.equal(closed, true);
    assert.equal(recorded.messages.length, 0);
  });

  test('after an oversized message the session accepts a new transaction', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');

    client.write(`${'x'.repeat(900)}\r\n${'y'.repeat(900)}\r\n.\r\n`);
    const rejected = await client.reply();
    const mail = await client.cmd('MAIL FROM:<carol@example.test>');
    await client.cmd('RCPT TO:<bob@example.test>');
    await client.cmd('DATA');
    const accepted = await client.cmd('small\r\n.');

    assert.equal(rejected.code, 552);
    assert.equal(mail.code, 250);
    assert.equal(accepted.code, 250);
    assert.equal(recorded.messages.length, 1);
  });

  test('a permanent handler rejection keeps 550, its own reply code is passed through', async (t) => {
    const { client } = await connectReady(t, {
      onRcptTo: async (to) => (to.startsWith('full') ? '452 4.2.2 Mailbox full' : '5.1.1 User unknown'),
    });
    await client.cmd('MAIL FROM:<alice@example.test>');

    const unknown = await client.cmd('RCPT TO:<nobody@example.test>');
    const full = await client.cmd('RCPT TO:<full@example.test>');

    assert.equal(unknown.text, '550 5.1.1 User unknown');
    assert.equal(full.text, '452 4.2.2 Mailbox full');
  });
});

// ─── v7.1 review fixes (RFC 5321 / 3207 / 4954 / 4616 conformance) ─────────────

/** Lets loopback I/O run without real timers (works with mocked setTimeout). */
async function flushIo(ms = 60): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('envelope parameters and syntax (review fixes)', () => {
  test('unknown RCPT parameters are refused with 555', async (t) => {
    const { client } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test>');

    const reply = await client.cmd('RCPT TO:<bob@example.test> FOO=BAR');

    assert.equal(reply.code, 555);
  });

  test('the MAIL AUTH= parameter (RFC 4954 §5) and SIZE+BODY together are accepted', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('MAIL FROM:<alice@example.test> SIZE=100 BODY=8BITMIME AUTH=<>');

    assert.equal(reply.code, 250);
  });

  test('a malformed parameter list is a syntax error (501)', async (t) => {
    const { client } = await connectReady(t);

    const glued = await client.cmd('MAIL FROM:<alice@example.test>SIZE=100');
    const badSize = await client.cmd('MAIL FROM:<alice@example.test> SIZE=abc');

    assert.equal(glued.code, 501);
    assert.equal(badSize.code, 501);
  });

  test('a recipient without local-part or domain is refused with 501 5.1.3 at RCPT', async (t) => {
    const { client, recorded } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test>');

    const noDomain = await client.cmd('RCPT TO:<a@>');
    const noLocal = await client.cmd('RCPT TO:<@example.test>');
    const badDomain = await client.cmd('RCPT TO:<a@exa mple.test>');

    assert.deepEqual([noDomain.code, noLocal.code, badDomain.code], [501, 501, 501]);
    assert.match(noDomain.text, /^501 5\.1\.3 /);
    assert.deepEqual(recorded.rcptTo, []);
  });

  test('a source route is accepted and ignored (RFC 5321 §4.1.1.3)', async (t) => {
    const { client, recorded } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test>');

    const reply = await client.cmd('RCPT TO:<@relay.example.test:bob@example.test>');

    assert.equal(reply.code, 250);
    assert.deepEqual(recorded.rcptTo, ['bob@example.test']);
  });

  test('<Postmaster> is passed to the handler as the bare "postmaster" recipient', async (t) => {
    const { client, recorded } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test>');

    await client.cmd('RCPT TO:<POSTMASTER>');

    assert.deepEqual(recorded.rcptTo, ['postmaster']);
  });

  test('HELO without a domain is a syntax error (501)', async (t) => {
    const { client } = await connect(t);
    await client.reply();

    const reply = await client.cmd('HELO');

    assert.equal(reply.code, 501);
  });
});

describe('DATA transparency and trace data (review fixes)', () => {
  test('the first period of any line starting with "." is removed (RFC 5321 §4.5.2)', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');

    await client.cmd('.x\r\n. y\r\nz\r\n.');

    assert.equal(recorded.messages[0]?.raw.toString('latin1'), 'x\r\n y\r\nz\r\n');
  });

  test('the message handler gets HELO name, protocol, host name and session id', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');

    await client.cmd('x\r\n.');

    const meta = recorded.messages[0]?.meta;
    assert.equal(meta?.helo, 'client.example.test');
    assert.equal(meta?.protocol, 'ESMTP');
    assert.equal(meta?.hostname, 'mx.example.test');
    assert.match(meta?.sessionId ?? '', /^[0-9A-F]{8}$/);
  });

  test('an internal handler error is answered with a fixed one-line 451 (no internals, no LF)', async (t) => {
    const { client } = await connectWithRecipient(t, {
      onMessage: async () => { throw new Error('PrismaClientKnownRequestError:\nInvalid `prisma.message.create()`\nsecret detail'); },
    });
    await client.cmd('DATA');

    const reply = await client.cmd('x\r\n.');
    const next = await client.cmd('NOOP');

    assert.deepEqual(reply.lines, ['451 4.3.0 Temporary local problem, try again later']);
    assert.equal(next.code, 250);
  });

  test('a reply error with an embedded line break stays a single reply line', async (t) => {
    const { client } = await connectWithRecipient(t, {
      onMessage: async () => { throw new Error('550 5.7.1 Rejected\r\n250 smuggled'); },
    });
    await client.cmd('DATA');

    const reply = await client.cmd('x\r\n.');
    const next = await client.cmd('NOOP');

    assert.deepEqual(reply.lines, ['550 5.7.1 Rejected 250 smuggled']);
    assert.equal(next.code, 250);
  });
});

describe('greeting (review fixes)', () => {
  test('a banner that does not start with a domain is prefixed with the host name', async (t) => {
    const { client } = await connect(t, { config: { bannerText: 'Welcome to our mail service' } });

    const greeting = await client.reply();

    assert.equal(greeting.text, '220 mx.example.test Welcome to our mail service');
  });
});

describe('AUTH response validation (review fixes, RFC 4954 §4 / RFC 4616 §2)', () => {
  test('a response that is not valid base64 is answered with 501', async (t) => {
    const { client, recorded } = await connectReady(t, { auth: true });

    const plain = await client.cmd('AUTH PLAIN not*base64!');
    await client.cmd('AUTH LOGIN');
    const login = await client.cmd('%%%');

    assert.equal(plain.code, 501);
    assert.equal(login.code, 501);
    assert.deepEqual(recorded.credentials, []);
  });

  test('a PLAIN message without the authzid field separator is malformed (535)', async (t) => {
    const { client, recorded } = await connectReady(t, { auth: true });

    const reply = await client.cmd(`AUTH PLAIN ${b64('user@example.test\0secret')}`);

    assert.equal(reply.code, 535);
    assert.deepEqual(recorded.credentials, []);
  });

  test('an authzid other than the authenticated user fails, the own identity succeeds', async (t) => {
    const { client } = await connectReady(t, { auth: true });

    const foreign = await client.cmd(`AUTH PLAIN ${b64('admin@example.test\0user@example.test\0secret')}`);
    const own = await client.cmd(`AUTH PLAIN ${b64('User@Example.test\0user@example.test\0secret')}`);

    assert.equal(foreign.code, 535);
    assert.equal(own.code, 235);
  });
});

describe('STARTTLS and timers (review fixes)', () => {
  test('STARTTLS with a parameter is a syntax error (501, RFC 3207 §4)', async (t) => {
    const { client } = await connectReady(t, { config: { tls: testCert() } });

    const reply = await client.cmd('STARTTLS now');

    assert.equal(reply.code, 501);
  });

  test('a client that never completes the TLS handshake is disconnected', async (t) => {
    await flushIo();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client } = await connectReady(t, { config: { tls: testCert() } });
    await client.cmd('STARTTLS');

    t.mock.timers.tick(60_000);
    await flushIo();

    assert.equal(client.closed, true);
  });

  test('the DATA timeout restarts with every received chunk (slow uploads succeed)', async (t) => {
    await flushIo();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');

    for (let i = 0; i < 3; i++) {
      client.write(`line ${i}\r\n`);
      await flushIo();
      t.mock.timers.tick(6 * 60_000); // 18 minutes in total, never 10 without data
    }
    const reply = await client.cmd('.');

    assert.equal(reply.code, 250);
    assert.equal(recorded.messages.length, 1);
  });

  test('a stalled DATA transfer still times out after ten minutes without data', async (t) => {
    // Let the sessions of earlier tests close first: their (mocked) timer ids
    // would otherwise collide with the ids of this test's mocked timers.
    await flushIo();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client } = await connectWithRecipient(t);
    await client.cmd('DATA');
    client.write('partial\r\n');
    await flushIo();

    t.mock.timers.tick(10 * 60_000);
    const reply = await client.reply();

    assert.equal(reply.code, 421);
  });
});

// ─── v8.1: CHUNKING / BINARYMIME (RFC 3030) ─────────────────────────────────

/** Sends UTF-8 text as octets (the harness writes latin1 strings byte for byte). */
const utf8 = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');

describe('BDAT (RFC 3030 CHUNKING)', () => {
  test('chunk boundaries inside a CRLF are reassembled byte-exact; no dot-unstuffing', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    const message = 'Subject: chunked\r\n\r\nline one\r\n.hidden dot line\r\n..two dots\r\nend\r\n';
    const cut = message.indexOf('\r\n.hidden') + 1; // first chunk ends with "\r", second starts with "\n"
    const first = message.slice(0, cut);
    const second = message.slice(cut);

    client.write(`BDAT ${first.length}\r\n${first}`);
    const r1 = await client.reply();
    client.write(`BDAT ${second.length} LAST\r\n${second}`);
    const r2 = await client.reply();

    assert.equal(r1.text, `250 2.0.0 ${first.length} octets received`);
    assert.equal(r2.text, '250 2.0.0 OK');
    assert.equal(recorded.messages[0]?.raw.toString('latin1'), message);
    assert.equal(recorded.messages[0]?.meta?.envelope?.chunking, true);
  });

  test('a chunk split over several TCP writes (and the command line itself) is read completely', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    const body = 'A'.repeat(300);

    client.write('BD');
    await delay(20);
    client.write(`AT ${body.length} LA`);
    await delay(20);
    client.write(`ST\r\n${body.slice(0, 100)}`);
    await delay(20);
    client.write(body.slice(100, 299));
    await delay(20);
    client.write(body.slice(299));
    const reply = await client.reply();

    assert.equal(reply.code, 250);
    assert.equal(recorded.messages[0]?.raw.toString('latin1'), body);
  });

  test('a binary chunk with NUL and all other octets is delivered unchanged (BODY=BINARYMIME)', async (t) => {
    const { client, recorded } = await connectReady(t);
    const bytes = Buffer.from(Array.from({ length: 256 }, (_v, i) => i));
    await client.cmd('MAIL FROM:<alice@example.test> BODY=BINARYMIME');
    await client.cmd('RCPT TO:<bob@example.test>');

    client.write(`BDAT ${bytes.length} LAST\r\n${bytes.toString('latin1')}`);
    const reply = await client.reply();

    assert.equal(reply.code, 250);
    assert.ok(recorded.messages[0]?.raw.equals(bytes));
    assert.equal(recorded.messages[0]?.meta?.envelope?.body, 'BINARYMIME');
  });

  test('a zero-length BDAT LAST ends the message', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);

    client.write('BDAT 4\r\nabcd');
    const r1 = await client.reply();
    const r2 = await client.cmd('BDAT 0 LAST');

    assert.equal(r1.code, 250);
    assert.equal(r2.text, '250 2.0.0 OK');
    assert.equal(recorded.messages[0]?.raw.toString('latin1'), 'abcd');
  });

  test('SIZE is enforced across chunks: 552, nothing delivered, the session stays usable', async (t) => {
    const { client, recorded } = await connectWithRecipient(t); // maxSize 1024

    client.write(`BDAT 600\r\n${'x'.repeat(600)}`);
    const r1 = await client.reply();
    client.write(`BDAT 600 LAST\r\n${'y'.repeat(600)}`);
    const r2 = await client.reply();
    const afterLast = await client.cmd('BDAT 0 LAST');
    const mail = await client.cmd('MAIL FROM:<alice@example.test>');

    assert.equal(r1.code, 250);
    assert.equal(r2.text, '552 5.3.4 Message exceeds size limit');
    assert.equal(afterLast.code, 503, 'the failed transaction is closed');
    assert.equal(mail.code, 250);
    assert.equal(recorded.messages.length, 0);
  });

  test('an oversized single chunk is consumed (never run as commands) and refused with 552', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    const payload = 'QUIT\r\n'.repeat(400); // 2400 octets of "commands"

    client.write(`BDAT ${payload.length} LAST\r\n${payload}`);
    const reply = await client.reply();
    const noop = await client.cmd('NOOP');

    assert.equal(reply.code, 552);
    assert.equal(noop.code, 250);
    assert.equal(client.closed, false);
    assert.equal(recorded.messages.length, 0);
  });

  test('MAIL, RCPT, two BDAT chunks and QUIT in one TCP write (PIPELINING)', async (t) => {
    const { client, recorded } = await connectReady(t, { handlerDelayMs: 20 });

    client.write('MAIL FROM:<alice@example.test>\r\nRCPT TO:<bob@example.test>\r\nBDAT 5\r\nHELLOBDAT 7 LAST\r\n, WORLDQUIT\r\n');
    const replies = [await client.reply(), await client.reply(), await client.reply(), await client.reply(), await client.reply()];

    assert.deepEqual(replies.map((r) => r.code), [250, 250, 250, 250, 221]);
    assert.equal(recorded.messages[0]?.raw.toString('latin1'), 'HELLO, WORLD');
  });

  test('BDAT works over TLS', async (t) => {
    const { client, recorded } = await connect(t, { auth: true });
    await client.reply();
    await client.cmd('EHLO client.example.test');
    await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);

    client.write('MAIL FROM:<user@example.test>\r\nRCPT TO:<bob@example.test>\r\nBDAT 3 LAST\r\nxyz');
    const replies = [await client.reply(), await client.reply(), await client.reply()];

    assert.deepEqual(replies.map((r) => r.code), [250, 250, 250]);
    assert.equal(recorded.messages[0]?.raw.toString('latin1'), 'xyz');
  });

  test('DATA after BDAT in the same transaction is refused with 503', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);

    client.write('BDAT 3\r\nabc');
    await client.reply();
    const data = await client.cmd('DATA');
    const last = await client.cmd('BDAT 0 LAST');

    assert.equal(data.code, 503);
    assert.equal(last.code, 250, 'the BDAT transaction continues');
    assert.equal(recorded.messages[0]?.raw.toString('latin1'), 'abc');
  });

  test('DATA is refused for BODY=BINARYMIME (RFC 3030 §3)', async (t) => {
    const { client } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test> BODY=BINARYMIME');
    await client.cmd('RCPT TO:<bob@example.test>');

    const reply = await client.cmd('DATA');

    assert.equal(reply.code, 503);
  });

  test('BDAT before RCPT is 503 and a BDAT after LAST is 503', async (t) => {
    const { client } = await connectReady(t);
    await client.cmd('MAIL FROM:<alice@example.test>');

    client.write('BDAT 2\r\nab');
    const early = await client.reply();
    await client.cmd('RCPT TO:<bob@example.test>');
    client.write('BDAT 2 LAST\r\nab');
    await client.reply();
    client.write('BDAT 2\r\ncd');
    const late = await client.reply();

    assert.equal(early.code, 503);
    assert.equal(late.code, 503);
  });

  test('a malformed BDAT size is a syntax error (501)', async (t) => {
    const { client } = await connectWithRecipient(t);

    assert.equal((await client.cmd('BDAT ten LAST')).code, 501);
    assert.equal((await client.cmd('BDAT')).code, 501);
  });

  test('BDAT LAST runs through the same message handler path as DATA (handler errors)', async (t) => {
    const { client } = await connectWithRecipient(t, { onMessage: async () => { throw new Error('550 5.7.1 Rejected by filter'); } });

    client.write('BDAT 1 LAST\r\nx');
    const reply = await client.reply();

    assert.equal(reply.text, '550 5.7.1 Rejected by filter');
  });
});

// ─── v8.1: DSN parameters (RFC 3461) ─────────────────────────────────────────

describe('DSN parameters (RFC 3461)', () => {
  test('RET, ENVID (xtext), NOTIFY and ORCPT are stored with the transaction and handed to onMessage', async (t) => {
    const { client, recorded } = await connectReady(t);

    assert.equal((await client.cmd('MAIL FROM:<alice@example.test> RET=HDRS ENVID=QQ+2B314')).code, 250);
    assert.equal((await client.cmd('RCPT TO:<Bob@example.test> NOTIFY=SUCCESS,DELAY ORCPT=rfc822;bob+2Bx@example.test')).code, 250);
    assert.equal((await client.cmd('RCPT TO:<carol@example.test> NOTIFY=NEVER')).code, 250);
    await client.cmd('DATA');
    await client.cmd('x\r\n.');

    assert.deepEqual(recorded.messages[0]?.meta?.envelope?.dsn, {
      ret: 'HDRS',
      envid: 'QQ+314',
      rcpts: {
        'bob@example.test': { notify: ['SUCCESS', 'DELAY'], orcpt: { type: 'rfc822', address: 'bob+x@example.test' } },
        'carol@example.test': { notify: [] },
      },
    });
  });

  test('a transaction without DSN parameters carries no DSN request', async (t) => {
    const { client, recorded } = await connectWithRecipient(t);
    await client.cmd('DATA');
    await client.cmd('x\r\n.');

    assert.equal(recorded.messages[0]?.meta?.envelope?.dsn, undefined);
  });

  test('malformed DSN parameters are refused with 501', async (t) => {
    const { client } = await connectReady(t);

    assert.equal((await client.cmd('MAIL FROM:<a@example.test> RET=BODY')).code, 501);
    assert.equal((await client.cmd('MAIL FROM:<a@example.test> ENVID=abc+zz')).code, 501);
    assert.equal((await client.cmd(`MAIL FROM:<a@example.test> ENVID=${'x'.repeat(101)}`)).code, 501);
    assert.equal((await client.cmd('MAIL FROM:<a@example.test> RET=FULL RET=HDRS')).code, 501);
    assert.equal((await client.cmd('MAIL FROM:<a@example.test> RET=full')).code, 250);
    assert.equal((await client.cmd('RCPT TO:<b@example.test> NOTIFY=NEVER,SUCCESS')).code, 501);
    assert.equal((await client.cmd('RCPT TO:<b@example.test> NOTIFY=SOMETIMES')).code, 501);
    assert.equal((await client.cmd('RCPT TO:<b@example.test> NOTIFY=FAILURE,FAILURE')).code, 501);
    assert.equal((await client.cmd('RCPT TO:<b@example.test> ORCPT=b@example.test')).code, 501);
    assert.equal((await client.cmd('RCPT TO:<b@example.test> ORCPT=rfc822;b+4')).code, 501);
    assert.equal((await client.cmd('RCPT TO:<b@example.test> NOTIFY=failure,delay')).code, 250);
  });
});

// ─── v8.1: SMTPUTF8 (RFC 6531) ───────────────────────────────────────────────

describe('SMTPUTF8 (RFC 6531)', () => {
  test('UTF-8 local-parts and U-label domains are accepted with MAIL … SMTPUTF8', async (t) => {
    const { client, recorded } = await connectReady(t);

    const mail = await client.cmd(utf8('MAIL FROM:<jörg@bücher.example> SMTPUTF8'));
    const rcpt = await client.cmd(utf8('RCPT TO:<用户@例子.example>'));
    await client.cmd('DATA');
    await client.cmd(utf8('Subject: Grüße\r\n\r\nHallo\r\n.'));

    assert.equal(mail.code, 250);
    assert.equal(rcpt.code, 250);
    assert.deepEqual(recorded.mailFrom, ['jörg@bücher.example']);
    assert.deepEqual(recorded.rcptTo, ['用户@例子.example']);
    assert.equal(recorded.messages[0]?.meta?.envelope?.smtputf8, true);
    assert.equal(recorded.messages[0]?.meta?.protocol, 'UTF8SMTP');
    assert.equal(recorded.messages[0]?.raw.toString('utf8'), 'Subject: Grüße\r\n\r\nHallo\r\n');
  });

  test('an IDN domain is normalised (case folding, NFC); an A-label domain stays ASCII', async (t) => {
    const { client, recorded } = await connectReady(t);
    await client.cmd('MAIL FROM:<a@example.test> SMTPUTF8');

    await client.cmd(utf8('RCPT TO:<User@BÜCHER.example>'));
    await client.cmd('RCPT TO:<user@XN--BCHER-KVA.example>');

    assert.deepEqual(recorded.rcptTo, ['User@bücher.example', 'user@xn--bcher-kva.example']);
  });

  test('a UTF-8 address without the SMTPUTF8 parameter is refused with 553 5.6.7', async (t) => {
    const { client } = await connectReady(t);

    const mail = await client.cmd(utf8('MAIL FROM:<jörg@example.test>'));
    await client.cmd('MAIL FROM:<a@example.test>');
    const rcpt = await client.cmd(utf8('RCPT TO:<bob@bücher.example>'));
    const orcpt = await client.cmd(utf8('RCPT TO:<bob@example.test> ORCPT=utf-8;bób@example.test'));

    assert.match(mail.text, /^553 5\.6\.7 /);
    assert.match(rcpt.text, /^553 5\.6\.7 /);
    assert.match(orcpt.text, /^553 5\.6\.7 /);
  });

  test('ill-formed UTF-8, invalid IDN domains, C1 controls and SMTPUTF8=value are refused', async (t) => {
    const { client } = await connectReady(t);

    assert.equal((await client.cmd('MAIL FROM:<j\xc3\x28rg@example.test> SMTPUTF8')).code, 501);
    assert.equal((await client.cmd('MAIL FROM:<a@example.test> SMTPUTF8=yes')).code, 501);
    assert.equal((await client.cmd(utf8('MAIL FROM:<a@bü_cher.example> SMTPUTF8'))).code, 501);
    assert.equal((await client.cmd(utf8('MAIL FROM:<a\u0085b@example.test> SMTPUTF8'))).code, 501);
    assert.equal((await client.cmd('MAIL FROM:<a@example.test> SMTPUTF8')).code, 250);
    assert.equal((await client.cmd(utf8('RCPT TO:<ok@bü_cher.example>'))).code, 501);
  });
});

describe('HELP (RFC 5321 §4.1.1.8)', () => {
  test('HELP answers 214 with enhanced codes and an RFC link, also with an argument', async (t) => {
    const { client } = await connectReady(t);

    const help = await client.cmd('HELP');
    const topic = await client.cmd('HELP MAIL');

    assert.equal(help.code, 214);
    assert.ok(help.lines.every((l) => /^214[- ]2\.0\.0 /.test(l)));
    assert.match(help.lines.at(-1) ?? '', /^214 2\.0\.0 .*https:\/\/www\.rfc-editor\.org\/rfc\/rfc5321/);
    assert.equal(topic.code, 214);
  });

  test('HELP works before EHLO and inside a transaction without changing its state', async (t) => {
    const { client } = await connect(t);
    await client.reply();
    assert.equal((await client.cmd('HELP')).code, 214);
    await client.cmd('EHLO client.example.test');
    await client.cmd('MAIL FROM:<alice@example.test>');
    assert.equal((await client.cmd('HELP')).code, 214);
    assert.equal((await client.cmd('RCPT TO:<bob@example.test>')).code, 250);
  });
});

describe('enhanced status codes on the new replies (RFC 2034)', () => {
  test('every 2yz/4yz/5yz reply of BDAT, DSN and SMTPUTF8 commands carries an enhanced code', async (t) => {
    const { client } = await connectReady(t);
    const replies: Reply[] = [];
    replies.push(await client.cmd('MAIL FROM:<a@example.test> RET=XX'));
    replies.push(await client.cmd(utf8('MAIL FROM:<ä@example.test>')));
    replies.push(await client.cmd('MAIL FROM:<a@example.test> SMTPUTF8 BODY=BINARYMIME'));
    replies.push(await client.cmd('RCPT TO:<b@example.test> NOTIFY=X'));
    replies.push(await client.cmd('RCPT TO:<b@example.test>'));
    replies.push(await client.cmd('DATA'));
    replies.push(await client.cmd('BDAT x'));
    client.write('BDAT 1\r\nz');
    replies.push(await client.reply());
    replies.push(await client.cmd('BDAT 0 LAST'));

    for (const r of replies) assert.match(r.text, /^\d{3} [245]\.\d{1,3}\.\d{1,3} /, r.text);
  });
});
