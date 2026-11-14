/**
 * Protocol tests for POP3Session (RFC 1939, RFC 2449).
 *
 * The session is driven over a real loopback TCP connection on an ephemeral port.
 * Prisma and verifyPassword are replaced by in-memory fakes through test-hooks.mjs —
 * no database, Redis or MinIO. A password P matches the hash "hash:P".
 *
 * Run (from the repository root, Node >= 22.15):
 *   node --experimental-transform-types --import ./packages/pop3-server/src/test-hooks.mjs \
 *        --test packages/pop3-server/src/session.test.ts
 */
import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { POP3Session } from './session.js';
import { selfSignedTestCert } from './test-cert.js';

let cachedCert: { cert: Buffer; key: Buffer } | null = null;
const testCert = (): { cert: Buffer; key: Buffer } => (cachedCert ??= selfSignedTestCert());

// ─── In-memory database fake ─────────────────────────────────────────────────

interface FakeMessage {
  id: string;
  uid: number;
  rawSize: number;
  fromAddr: string;
  toAddrs: string[];
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
  storagePath: string | null;
  deletedAt: Date | null;
}

interface FakeUser {
  id: string;
  email: string;
  active: boolean;
  passwordHash: string | null;
}

interface FakeDb {
  users: FakeUser[];
  appPasswords: Array<{ id: string; userId: string; hash: string }>;
  messages: FakeMessage[];
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function message(n: number, overrides: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id: `msg-${n}`,
    uid: n,
    rawSize: 100 * n,
    fromAddr: 'alice@example.test',
    toAddrs: ['bob@example.test'],
    subject: `Message ${n}`,
    date: '2026-01-02T03:04:05Z',
    bodyText: `body of message ${n}`,
    bodyHtml: '',
    storagePath: null,
    deletedAt: null,
    ...overrides,
  };
}

function installFakeDb(messages: FakeMessage[]): FakeDb {
  const db: FakeDb = {
    users: [
      { id: 'u1', email: 'bob@example.test', active: true, passwordHash: 'hash:secret' },
      { id: 'u2', email: 'gone@example.test', active: false, passwordHash: 'hash:secret' },
    ],
    appPasswords: [{ id: 'ap1', userId: 'u1', hash: 'hash:app-password' }],
    messages,
  };
  const prisma = {
    domain: {
      findFirst: async () => { await tick(); return { name: 'example.test' }; },
    },
    user: {
      findUnique: async ({ where }: { where: { email: string } }) => {
        await tick();
        return db.users.find((u) => u.email === where.email) ?? null;
      },
      // v7: the shared credential check queries { email, active: true }
      findFirst: async ({ where }: { where: { email: string; active?: boolean } }) => {
        await tick();
        return db.users.find((u) => u.email === where.email && (where.active === undefined || u.active === where.active)) ?? null;
      },
    },
    appPassword: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        db.appPasswords.filter((ap) => ap.userId === where.userId),
      update: async () => ({}),
    },
    mailbox: {
      findFirst: async ({ where }: { where: { userId: string } }) => {
        await tick();
        if (where.userId !== 'u1') return null;
        const live = db.messages.filter((m) => m.deletedAt === null).sort((a, b) => a.uid - b.uid);
        return { id: 'mb1', folders: [{ messages: live.map(({ id, uid, rawSize }) => ({ id, uid, rawSize })) }] };
      },
      // message-store allocation (modSeq bump on expunge)
      update: async () => ({ uidNext: 1, highestModSeq: 1n }),
      updateMany: async () => ({ count: 0 }),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(prisma),
    message: {
      aggregate: async () => ({ _max: { modSeq: null, uid: null } }),
      findUnique: async ({ where }: { where: { id: string } }) => {
        await tick();
        return db.messages.find((m) => m.id === where.id) ?? null;
      },
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: { deletedAt: Date } }) => {
        for (const m of db.messages) if (where.id.in.includes(m.id)) m.deletedAt = data.deletedAt;
        return { count: where.id.in.length };
      },
    },
  };
  (globalThis as unknown as { __coremailTest: { prisma?: unknown } }).__coremailTest.prisma = prisma;
  return db;
}

// ─── Client ──────────────────────────────────────────────────────────────────

class Pop3Client {
  private buffer = '';
  private wake: (() => void) | null = null;
  private readonly socket: net.Socket;
  closed = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { this.buffer += chunk; this.wake?.(); });
    socket.on('close', () => { this.closed = true; this.wake?.(); });
    socket.on('error', () => { /* surfaced through closed */ });
  }

  write(raw: string): void {
    this.socket.write(raw, 'utf8');
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
      if (remaining <= 0) throw new Error(`timeout waiting for a line (buffered: ${JSON.stringify(this.buffer)})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  }

  /** Sends a command and returns its single status line. */
  async cmd(line: string): Promise<string> {
    this.write(`${line}\r\n`);
    return this.readLine();
  }

  /** Reads the lines of a multi-line response up to (excluding) the terminating "." line. */
  async readMultiline(): Promise<string[]> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line === '.') return lines;
      lines.push(line);
    }
  }

  /** Sends a command; returns status line and the multi-line payload (still byte-stuffed). */
  async multi(line: string): Promise<{ status: string; lines: string[] }> {
    const status = await this.cmd(line);
    if (!status.startsWith('+OK')) return { status, lines: [] };
    return { status, lines: await this.readMultiline() };
  }

  async waitForClose(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    return this.closed;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

interface Harness {
  client: Pop3Client;
  db: FakeDb;
  /** Opens a second connection to the same server (greeting already consumed). */
  connectAgain(): Promise<Pop3Client>;
}

const THREE_MESSAGES = (): FakeMessage[] => [message(1), message(2), message(3)];

/** Starts a POP3 server on loopback, connects and consumes the greeting. */
async function connect(t: TestContext, messages: FakeMessage[] = THREE_MESSAGES()): Promise<Harness & { greeting: string }> {
  const db = installFakeDb(messages);
  // v7: USER/PASS require TLS — the harness uses the implicit-TLS (port 995) configuration.
  const server = tls.createServer({ ...testCert() }, (socket) => new POP3Session(socket, true).start());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const clients: Pop3Client[] = [];

  const open = async (): Promise<Pop3Client> => {
    const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
    const client = new Pop3Client(socket);
    clients.push(client);
    return client;
  };

  t.after(() => {
    for (const c of clients) c.destroy();
    server.close();
  });

  const client = await open();
  const greeting = await client.readLine();
  return {
    client,
    db,
    greeting,
    connectAgain: async () => { const c = await open(); await c.readLine(); return c; },
  };
}

/** Connects and logs in as bob@example.test (TRANSACTION state). */
async function login(t: TestContext, messages: FakeMessage[] = THREE_MESSAGES()): Promise<Harness> {
  const harness = await connect(t, messages);
  await harness.client.cmd('USER bob@example.test');
  const pass = await harness.client.cmd('PASS secret');
  assert.match(pass, /^\+OK/, 'test setup: login must succeed');
  return harness;
}

// ─── AUTHORIZATION state ─────────────────────────────────────────────────────

describe('AUTHORIZATION state (RFC 1939 §4, §7)', () => {
  test('the server greets with a positive response', async (t) => {
    const { greeting } = await connect(t);

    assert.match(greeting, /^\+OK /);
  });

  test('USER with a mailbox name is accepted', async (t) => {
    const { client } = await connect(t);

    const reply = await client.cmd('USER bob@example.test');

    assert.match(reply, /^\+OK/);
  });

  test('USER without an argument is rejected', async (t) => {
    const { client } = await connect(t);

    const reply = await client.cmd('USER');

    assert.match(reply, /^-ERR/);
  });

  test('PASS before USER is rejected', async (t) => {
    const { client } = await connect(t);

    const reply = await client.cmd('PASS secret');

    assert.match(reply, /^-ERR/);
  });

  test('PASS with the correct password enters the TRANSACTION state', async (t) => {
    const { client } = await connect(t);
    await client.cmd('USER bob@example.test');

    const pass = await client.cmd('PASS secret');
    const stat = await client.cmd('STAT');

    assert.match(pass, /^\+OK/);
    assert.match(stat, /^\+OK/);
  });

  test('PASS with a wrong password is rejected and the session stays unauthenticated', async (t) => {
    const { client } = await connect(t);
    await client.cmd('USER bob@example.test');

    const pass = await client.cmd('PASS wrong');
    const stat = await client.cmd('STAT');

    assert.match(pass, /^-ERR/);
    assert.match(stat, /^-ERR/);
  });

  test('an unknown user and a wrong password produce the same error text', async (t) => {
    const { client } = await connect(t);
    await client.cmd('USER bob@example.test');
    const wrongPassword = await client.cmd('PASS wrong');
    await client.cmd('USER nobody@example.test');

    const unknownUser = await client.cmd('PASS secret');

    assert.equal(unknownUser, wrongPassword);
  });

  test('an inactive account cannot log in', async (t) => {
    const { client } = await connect(t);
    await client.cmd('USER gone@example.test');

    const reply = await client.cmd('PASS secret');

    assert.match(reply, /^-ERR/);
  });

  test('an app password is accepted instead of the account password', async (t) => {
    const { client } = await connect(t);
    await client.cmd('USER bob@example.test');

    const reply = await client.cmd('PASS app-password');

    assert.match(reply, /^\+OK/);
  });

  test('a bare user name is completed with the primary domain', async (t) => {
    const { client } = await connect(t);
    await client.cmd('USER bob');

    const reply = await client.cmd('PASS secret');

    assert.match(reply, /^\+OK/);
  });

  test('command keywords are case-insensitive (RFC 1939 §3)', async (t) => {
    const { client } = await connect(t);
    await client.cmd('user bob@example.test');

    const reply = await client.cmd('pass secret');

    assert.match(reply, /^\+OK/);
  });

  test('a password containing a space is compared as a whole', async (t) => {
    // RFC 1939 §7 PASS: "Since the PASS command has exactly one argument, a POP3 server may treat spaces
    // in the argument as part of the password, instead of as argument separators." Only the first word
    // being compared means accounts whose password contains a space can never log in via POP3.
    const { client, db } = await connect(t);
    db.users.push({ id: 'u3', email: 'carol@example.test', active: true, passwordHash: 'hash:two words' });
    await client.cmd('USER carol@example.test');

    const reply = await client.cmd('PASS two words');

    assert.match(reply, /^\+OK/);
  });

  test('transaction commands are rejected before authentication', async (t) => {
    const { client } = await connect(t);

    const replies = [await client.cmd('STAT'), await client.cmd('LIST'), await client.cmd('RETR 1'), await client.cmd('DELE 1')];

    assert.ok(replies.every((r) => r.startsWith('-ERR')), JSON.stringify(replies));
  });

  test('QUIT before authentication signs off and closes the connection', async (t) => {
    const { client } = await connect(t);

    const reply = await client.cmd('QUIT');
    const closed = await client.waitForClose();

    assert.match(reply, /^\+OK/);
    assert.equal(closed, true);
  });

  test('an overlong command line is answered with -ERR and the session survives', async (t) => {
    const { client } = await connect(t);

    const tooLong = await client.cmd(`USER ${'x'.repeat(600)}`);
    const next = await client.cmd('NOOP');

    assert.match(tooLong, /^-ERR/);
    assert.match(next, /^-ERR/); // NOOP is not valid in AUTHORIZATION, but the server still answers
  });

  test('a second session cannot open a maildrop that is already locked', async (t) => {
    // RFC 1939 §4: "the POP3 server then acquires an exclusive-access lock on the maildrop ...
    // If the lock is successfully acquired, the POP3 server responds with a positive status indicator."
    const { connectAgain } = await login(t);
    const second = await connectAgain();
    await second.cmd('USER bob@example.test');

    const reply = await second.cmd('PASS secret');

    assert.match(reply, /^-ERR/);
  });
});

// ─── CAPA ────────────────────────────────────────────────────────────────────

describe('CAPA (RFC 2449)', () => {
  test('CAPA is available before authentication and is terminated by a single dot', async (t) => {
    const { client } = await connect(t);

    const { status, lines } = await client.multi('CAPA');

    assert.match(status, /^\+OK/);
    assert.ok(lines.includes('USER') && lines.includes('UIDL') && lines.includes('TOP'), JSON.stringify(lines));
  });

  test('CAPA does not advertise STLS or SASL, which are not implemented', async (t) => {
    const { client } = await connect(t);

    const { lines } = await client.multi('CAPA');

    assert.ok(!lines.some((l) => /^(STLS|SASL)\b/.test(l)), JSON.stringify(lines));
  });
});

// ─── TRANSACTION state ───────────────────────────────────────────────────────

describe('TRANSACTION state (RFC 1939 §5)', () => {
  test('the login reply reports the number of messages', async (t) => {
    const { client } = await connect(t);
    await client.cmd('USER bob@example.test');

    const reply = await client.cmd('PASS secret');

    assert.match(reply, /^\+OK .*\b3\b/);
  });

  test('STAT returns message count and total size in octets', async (t) => {
    const { client } = await login(t);

    const reply = await client.cmd('STAT');

    assert.equal(reply, '+OK 3 600');
  });

  test('LIST returns one scan listing per message', async (t) => {
    const { client } = await login(t);

    const { lines } = await client.multi('LIST');

    assert.deepEqual(lines, ['1 100', '2 200', '3 300']);
  });

  test('LIST with a message number returns that scan listing on the status line', async (t) => {
    const { client } = await login(t);

    const reply = await client.cmd('LIST 2');

    assert.equal(reply, '+OK 2 200');
  });

  test('LIST with an unknown message number is rejected', async (t) => {
    const { client } = await login(t);

    const replies = [await client.cmd('LIST 4'), await client.cmd('LIST 0'), await client.cmd('LIST x')];

    assert.ok(replies.every((r) => r.startsWith('-ERR')), JSON.stringify(replies));
  });

  test('UIDL returns a unique id per message', async (t) => {
    const { client } = await login(t);

    const { lines } = await client.multi('UIDL');

    assert.deepEqual(lines, ['1 msg-1', '2 msg-2', '3 msg-3']);
  });

  test('UIDL with a message number returns that unique id on the status line', async (t) => {
    const { client } = await login(t);

    const reply = await client.cmd('UIDL 3');

    assert.equal(reply, '+OK 3 msg-3');
  });

  test('NOOP is answered positively', async (t) => {
    const { client } = await login(t);

    const reply = await client.cmd('NOOP');

    assert.match(reply, /^\+OK/);
  });

  test('an unknown command is rejected', async (t) => {
    const { client } = await login(t);

    const reply = await client.cmd('XYZZY');

    assert.match(reply, /^-ERR/);
  });

  test('USER is not valid in the TRANSACTION state', async (t) => {
    const { client } = await login(t);

    const reply = await client.cmd('USER bob@example.test');

    assert.match(reply, /^-ERR/);
  });
});

// ─── RETR / TOP ──────────────────────────────────────────────────────────────

describe('RETR and TOP (RFC 1939 §5, §7)', () => {
  test('RETR sends headers, a blank line and the body, terminated by a single dot', async (t) => {
    const { client } = await login(t);

    const { status, lines } = await client.multi('RETR 1');

    assert.match(status, /^\+OK/);
    assert.ok(lines.includes('Subject: Message 1'));
    assert.deepEqual(lines.slice(lines.indexOf('')), ['', 'body of message 1']);
  });

  test('RETR for an unknown message number is rejected', async (t) => {
    const { client } = await login(t);

    const replies = [await client.cmd('RETR 9'), await client.cmd('RETR 0'), await client.cmd('RETR'), await client.cmd('RETR abc')];

    assert.ok(replies.every((r) => r.startsWith('-ERR')), JSON.stringify(replies));
  });

  test('RETR byte-stuffs every line that starts with a dot (RFC 1939 §3)', async (t) => {
    const { client } = await login(t, [message(1, { bodyText: '.hidden\r\n.\r\n..two\r\nplain' })]);

    const { lines } = await client.multi('RETR 1');

    assert.deepEqual(lines.slice(lines.indexOf('') + 1), ['..hidden', '..', '...two', 'plain']);
  });

  test('RETR announces the size in octets, not in characters', async (t) => {
    const { client } = await login(t, [message(1, { bodyText: 'Grüße – ✓' })]);

    const { status, lines } = await client.multi('RETR 1');

    const sentOctets = Buffer.byteLength(lines.join('\r\n'), 'utf8');
    assert.equal(status, `+OK ${sentOctets} octets`);
  });

  test('the size reported by LIST equals the size of the message RETR sends', async (t) => {
    // RFC 1939 §5 (LIST): the octet count reported by LIST/STAT must be the size of the message as RETR sends it
    // ("... the exact size of the message in octets"). Clients preallocate / verify against this number.
    // Fixture: rawSize (100) stands for the size of the message as originally received and stored by
    // smtp-server; RETR sends a message re-synthesized from DB columns, so the two can only agree by chance.
    const stored = message(1);
    const { client } = await login(t, [stored]);

    const list = await client.cmd('LIST 1');
    const { lines } = await client.multi('RETR 1');

    const sentOctets = Buffer.byteLength(lines.join('\r\n') + '\r\n', 'utf8');
    assert.equal(list, `+OK 1 ${sentOctets}`);
  });

  test('an HTML-only message is not delivered as text/plain', async (t) => {
    // RETR must send "the message" (RFC 1939 §5). The server re-synthesizes it from DB columns and always
    // labels it text/plain, so HTML mail arrives as raw markup (and attachments are never included).
    const { client } = await login(t, [message(1, { bodyText: '', bodyHtml: '<p>Hello</p>' })]);

    const { lines } = await client.multi('RETR 1');

    const contentType = lines.find((l) => /^content-type:/i.test(l)) ?? '';
    assert.match(contentType, /text\/html|multipart\//i);
  });

  test('a large message stored in object storage is not delivered with an empty body', async (t) => {
    // smtp-server/src/handlers/message.ts stores messages > 256 KB in MinIO (storagePath) and saves
    // bodyText/bodyHtml as ''. A RETR that ignores storagePath sends headers only.
    // (When this is fixed the test needs an object-storage fake returning the raw message.)
    const large = message(1, { bodyText: '', bodyHtml: '', storagePath: 'raw/large-message', rawSize: 300_000 });
    const { client } = await login(t, [large]);

    const { lines } = await client.multi('RETR 1');

    const body = lines.slice(lines.indexOf('') + 1).join('\r\n');
    assert.notEqual(body, '', 'RETR sent an empty body for a 300 000 octet message');
  });

  test('TOP n 0 returns the headers followed by the separating blank line', async (t) => {
    // RFC 1939 §7 TOP: "the POP3 server sends the headers of the message, the blank line separating the
    // headers from the body, and then the number of lines of the indicated message's body"
    const { client } = await login(t);

    const { lines } = await client.multi('TOP 1 0');

    assert.equal(lines.at(-1), '');
    assert.ok(!lines.includes('body of message 1'));
  });

  test('TOP n 2 returns the headers and only the first two body lines', async (t) => {
    const { client } = await login(t, [message(1, { bodyText: 'one\r\ntwo\r\nthree\r\nfour' })]);

    const { lines } = await client.multi('TOP 1 2');

    assert.deepEqual(lines.slice(lines.indexOf('')), ['', 'one', 'two']);
  });

  test('TOP without the line count argument is rejected', async (t) => {
    // RFC 1939 §7 TOP msg n: "a non-negative number of lines (required)"
    const { client } = await login(t);

    const reply = await client.cmd('TOP 1');

    assert.match(reply, /^-ERR/);
  });

  test('TOP with a negative line count is rejected', async (t) => {
    const { client } = await login(t);

    const reply = await client.cmd('TOP 1 -1');

    assert.match(reply, /^-ERR/);
  });
});

// ─── DELE / RSET / UPDATE ────────────────────────────────────────────────────

describe('DELE, RSET and the UPDATE state (RFC 1939 §5, §6)', () => {
  test('DELE marks a message as deleted', async (t) => {
    const { client } = await login(t);

    const reply = await client.cmd('DELE 2');

    assert.match(reply, /^\+OK/);
  });

  test('a deleted message can no longer be addressed', async (t) => {
    const { client } = await login(t);
    await client.cmd('DELE 2');

    const replies = [
      await client.cmd('DELE 2'), await client.cmd('RETR 2'), await client.cmd('LIST 2'),
      await client.cmd('UIDL 2'), await client.cmd('TOP 2 0'),
    ];

    assert.ok(replies.every((r) => r.startsWith('-ERR')), JSON.stringify(replies));
  });

  test('STAT does not count deleted messages', async (t) => {
    const { client } = await login(t);
    await client.cmd('DELE 2');

    const reply = await client.cmd('STAT');

    assert.equal(reply, '+OK 2 400');
  });

  test('LIST omits deleted messages and keeps the numbers of the others', async (t) => {
    const { client } = await login(t);
    await client.cmd('DELE 2');

    const { lines } = await client.multi('LIST');

    assert.deepEqual(lines, ['1 100', '3 300']);
  });

  test('DELE for an unknown message number is rejected', async (t) => {
    const { client } = await login(t);

    const replies = [await client.cmd('DELE 9'), await client.cmd('DELE'), await client.cmd('DELE x')];

    assert.ok(replies.every((r) => r.startsWith('-ERR')), JSON.stringify(replies));
  });

  test('RSET unmarks all deleted messages', async (t) => {
    const { client } = await login(t);
    await client.cmd('DELE 1');
    await client.cmd('DELE 2');

    const rset = await client.cmd('RSET');
    const stat = await client.cmd('STAT');

    assert.match(rset, /^\+OK/);
    assert.equal(stat, '+OK 3 600');
  });

  test('QUIT removes exactly the messages marked as deleted', async (t) => {
    const { client, db } = await login(t);
    await client.cmd('DELE 1');
    await client.cmd('DELE 3');

    const reply = await client.cmd('QUIT');
    await client.waitForClose();

    assert.match(reply, /^\+OK/);
    assert.deepEqual(db.messages.filter((m) => m.deletedAt !== null).map((m) => m.id), ['msg-1', 'msg-3']);
  });

  test('QUIT after RSET removes nothing', async (t) => {
    const { client, db } = await login(t);
    await client.cmd('DELE 1');
    await client.cmd('RSET');

    await client.cmd('QUIT');
    await client.waitForClose();

    assert.equal(db.messages.filter((m) => m.deletedAt !== null).length, 0);
  });

  test('a connection dropped without QUIT removes nothing (RFC 1939 §6)', async (t) => {
    const { client, db } = await login(t);
    await client.cmd('DELE 1');

    client.destroy();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.equal(db.messages.filter((m) => m.deletedAt !== null).length, 0);
  });
});

// ─── PIPELINING ──────────────────────────────────────────────────────────────

describe('PIPELINING (RFC 2449 §6.6 — advertised by CAPA)', () => {
  test('CAPA advertises PIPELINING', async (t) => {
    const { client } = await connect(t);

    const { lines } = await client.multi('CAPA');

    assert.ok(lines.includes('PIPELINING'));
  });

  test('USER, PASS and STAT sent in one packet are executed in order', async (t) => {
    // RFC 2449 §6.6: "the server is capable of accepting multiple commands at a time; the client does not
    // have to wait for the response to a command before issuing a subsequent command."
    const { client } = await connect(t);

    client.write('USER bob@example.test\r\nPASS secret\r\nSTAT\r\n');
    const replies = [await client.readLine(), await client.readLine(), await client.readLine()];

    assert.match(replies[0] ?? '', /^\+OK/);
    assert.match(replies[1] ?? '', /^\+OK .*3/);
    assert.equal(replies[2], '+OK 3 600');
  });

  test('responses to pipelined RETR and NOOP arrive in command order', async (t) => {
    const { client } = await login(t);

    client.write('RETR 1\r\nNOOP\r\n');
    const first = await client.readLine();

    assert.match(first, /^\+OK \d+ octets$/, `first response line was: ${first}`);
  });

  test('pipelined DELE and QUIT delete the message before signing off', async (t) => {
    const { client, db } = await login(t);

    client.write('DELE 1\r\nQUIT\r\n');
    await client.waitForClose();

    assert.deepEqual(db.messages.filter((m) => m.deletedAt !== null).map((m) => m.id), ['msg-1']);
  });
});
