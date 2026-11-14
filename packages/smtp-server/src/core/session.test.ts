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
import { SmtpSession } from './session.js';
import type { AuthUser, EsmtpExtensions, SmtpSessionConfig } from './types.js';

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
  messages: Array<{ raw: Buffer; from: string; to: string[]; authUser: AuthUser | null }>;
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
      onMessage: async (raw, from, to, authUser) => {
        recorded.messages.push({ raw, from, to, authUser });
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

  const server = net.createServer((socket) => new SmtpSession(socket, config).start());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
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

    assert.deepEqual(ehloKeywords(reply).sort(), ['8BITMIME', 'AUTH', 'ENHANCEDSTATUSCODES', 'PIPELINING', 'SIZE']);
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

  test('EHLO never advertises CRAM-MD5, SMTPUTF8, CHUNKING or DSN even if the settings flags are on', async (t) => {
    const everythingOn: EsmtpExtensions = {
      starttls: true, authPlain: true, authLogin: true, authCramMd5: true, pipelining: true, size: true,
      bit8mime: true, enhancedStatus: true, smtputf8: true, dsn: true, chunking: true,
    };
    const { client } = await connect(t, { auth: true, config: { esmtp: everythingOn } });
    await client.reply();

    const reply = await client.cmd('EHLO client.example.test');

    assert.doesNotMatch(reply.text, /CRAM-MD5|SMTPUTF8|CHUNKING|\bDSN\b|BINARYMIME/);
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

  test('BDAT is not recognized because CHUNKING is not implemented', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('BDAT 5 LAST');

    assert.equal(reply.code, 500);
  });

  test('NOOP is answered with 250 and ignores its argument', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('NOOP ignored');

    assert.equal(reply.code, 250);
  });

  test('VRFY is declined with 502', async (t) => {
    const { client } = await connectReady(t);

    const reply = await client.cmd('VRFY bob');

    assert.equal(reply.code, 502);
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

  test('the reverse-path is passed to the handler in lower case', async (t) => {
    const { client, recorded } = await connectReady(t);

    await client.cmd('MAIL FROM:<Alice@Example.TEST>');

    assert.deepEqual(recorded.mailFrom, ['alice@example.test']);
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
