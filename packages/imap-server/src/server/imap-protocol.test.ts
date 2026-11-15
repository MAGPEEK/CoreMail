/**
 * Protocol tests for the IMAP server (RFC 3501 IMAP4rev1 / RFC 9051 IMAP4rev2 and the
 * extensions it advertises: IDLE, CONDSTORE, MOVE, UNSELECT, UIDPLUS, ID, STATUS=SIZE,
 * ENABLE, NAMESPACE, QUOTA, ESEARCH, LIST-STATUS, LITERAL+, SASL-IR).
 *
 * The real createImapServer() is started on a loopback ephemeral port. v7: authentication
 * requires TLS, so the harness uses the implicit-TLS ("port 993") configuration; tests that
 * look at the plaintext ("port 143") listener use connect(t, { plain: true }). Prisma, verifyPassword and Redis are replaced by
 * in-memory fakes through test-hooks.mjs — no database, Redis or MinIO.
 * A password P matches the hash "hash:P".
 *
 * Fixture: user bob@example.test, folders INBOX, Archive, Archive.2025, Sent, Work.
 *   INBOX: UID 5 (\Seen), UID 9 (\Seen), UID 12 (unseen)  — UIDs deliberately differ from
 *          the sequence numbers 1, 2, 3 so that UID and sequence addressing can be told apart.
 *   Work:  UID 1, UID 2 (sequence number == UID).
 *
 * Run (from the repository root, Node >= 22.15):
 *   node --experimental-transform-types --import ./packages/imap-server/src/test-hooks.mjs \
 *        --test packages/imap-server/src/server/imap-protocol.test.ts
 */
import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { createImapServer } from './index.js';
import { setIdlePollInterval } from '../commands/index.js';
import { selfSignedTestCert } from '../test-cert.js';

// ─── In-memory database fake ─────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface FakeMessage {
  id: string;
  uid: number;
  modSeq: bigint;
  folderId: string;
  flags: string[];
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  ccAddrs: string[];
  bccAddrs: string[];
  replyTo: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  date: Date;
  createdAt: Date;
  bodyText: string;
  bodyHtml: string;
  rawSize: number;
  storagePath: string | null;
  deletedAt: Date | null;
  attachments: Array<{ filename: string; mimeType: string; size: number }>;
}

interface FakeFolder { id: string; mailboxId: string; name: string; displayName: string }
interface FakeMailbox { id: string; uidNext: number; uidValidity: number; highestModSeq: bigint }

interface FakeDb {
  mailbox: FakeMailbox;
  folders: FakeFolder[];
  messages: FakeMessage[];
  /** Simulates delivery of a new message by the SMTP server. */
  deliver(folderId: string, overrides?: Partial<FakeMessage>): FakeMessage;
  byUid(uid: number): FakeMessage;
  /** Number of message.findMany calls (full folder reads). */
  messageReads: number;
  /** Runs at the start of every transaction (simulates a concurrent writer). */
  beforeTransaction?: (() => void) | undefined;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (key === 'NOT') return !matches(row, cond as Row);
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (typeof cond === 'object') {
      const c = cond as { has?: unknown; in?: unknown[]; gte?: number; lte?: number };
      if ('has' in c) return (value as unknown[]).includes(c.has);
      if ('in' in c) return (c.in ?? []).includes(value);
      if ('gte' in c || 'lte' in c) {
        return (c.gte === undefined || (value as number) >= c.gte) && (c.lte === undefined || (value as number) <= c.lte);
      }
      throw new Error(`fake prisma: unsupported condition on "${key}"`);
    }
    return value === cond;
  });
}

function sortByUid<T extends { uid: number }>(rows: T[], orderBy: { uid?: 'asc' | 'desc' } | undefined): T[] {
  const sorted = [...rows].sort((a, b) => a.uid - b.uid);
  return orderBy?.uid === 'desc' ? sorted.reverse() : sorted;
}

interface Increment { increment: number | bigint }
const isIncrement = (v: unknown): v is Increment => typeof v === 'object' && v !== null && 'increment' in v;

function applyData(target: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (isIncrement(value)) {
      const current = target[key];
      target[key] = typeof current === 'bigint' ? current + BigInt(value.increment) : (current as number) + Number(value.increment);
    } else {
      target[key] = value;
    }
  }
}

interface RedisFake {
  /** Simulates a publish on CHANNEL_MAIL_NEW. */
  emitNewMail(event: { userId: string; folderId: string; messageId: string; uid: number; subject: string }): void;
}

function installFakes(): { db: FakeDb; redis: RedisFake } {
  let nextId = 1;
  const baseMessage = (uid: number, folderId: string, overrides: Partial<FakeMessage>): FakeMessage => ({
    id: `m${nextId++}`,
    uid,
    modSeq: 10n,
    folderId,
    flags: [],
    subject: `Subject ${uid}`,
    fromAddr: 'alice@example.test',
    fromName: 'Alice',
    toAddrs: ['bob@example.test'],
    ccAddrs: [],
    bccAddrs: [],
    replyTo: null,
    messageId: `<msg-${uid}@example.test>`,
    inReplyTo: null,
    date: new Date('2026-02-03T10:20:30Z'),
    createdAt: new Date('2026-02-03T10:20:31Z'),
    bodyText: `Body of ${uid}`,
    bodyHtml: '',
    rawSize: 1000 + uid,
    storagePath: null,
    deletedAt: null,
    attachments: [],
    ...overrides,
  });

  const mailbox: FakeMailbox = { id: 'mb1', uidNext: 13, uidValidity: 777, highestModSeq: 10n };
  const folder = (id: string, name: string): FakeFolder => ({ id, mailboxId: 'mb1', name, displayName: name });
  const db: FakeDb = {
    mailbox,
    folders: [
      folder('f-inbox', 'INBOX'), folder('f-archive', 'Archive'), folder('f-archive-2025', 'Archive.2025'),
      folder('f-sent', 'Sent'), folder('f-work', 'Work'),
    ],
    messages: [
      baseMessage(5, 'f-inbox', { flags: ['\\Seen'] }),
      baseMessage(9, 'f-inbox', { flags: ['\\Seen'], ccAddrs: ['carol@example.test'] }),
      baseMessage(12, 'f-inbox', {}),
      baseMessage(1, 'f-work', { flags: ['\\Seen', '\\Flagged'] }),
      baseMessage(2, 'f-work', {}),
    ],
    deliver(folderId, overrides = {}) {
      const msg = baseMessage(mailbox.uidNext++, folderId, overrides);
      db.messages.push(msg);
      mailbox.highestModSeq++; // the message store bumps the mailbox counter on every write
      return msg;
    },
    byUid(uid) {
      const found = db.messages.find((m) => m.uid === uid);
      if (!found) throw new Error(`fixture: no message with UID ${uid}`);
      return found;
    },
    messageReads: 0,
  };

  const users = [{
    id: 'u1', email: 'bob@example.test', active: true, passwordHash: 'hash:secret', mailbox: { id: 'mb1' },
    quotaBytes: 1024n * 1024n,
  }];
  const withMailbox = (f: FakeFolder | undefined): (FakeFolder & { mailbox: FakeMailbox }) | null =>
    f ? { ...f, mailbox: { ...mailbox } } : null;
  const asRow = (v: unknown): Row => v as Row;

  const prisma = {
    domain: { findFirst: async () => ({ name: 'example.test' }) },
    user: {
      findFirst: async ({ where }: { where: Row }) => { await tick(); return users.find((u) => matches(asRow(u), where)) ?? null; },
    },
    appPassword: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        where.userId === 'u1' ? [{ id: 'ap1', userId: 'u1', hash: 'hash:app-password' }] : [],
      update: async () => ({}),
    },
    // Interactive transaction: the message-store primitives run against this same fake.
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => { db.beforeTransaction?.(); return fn(prisma); },
    mailbox: {
      update: async ({ data }: { data: Row }) => { await tick(); applyData(asRow(mailbox), data); return { ...mailbox }; },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const cond = { ...where } as Row;
        delete cond['highestModSeq']; delete cond['uidNext'];
        if (!matches(asRow(mailbox), cond)) return { count: 0 };
        const next = data as { highestModSeq?: bigint; uidNext?: number };
        if (next.highestModSeq !== undefined && mailbox.highestModSeq < next.highestModSeq) mailbox.highestModSeq = next.highestModSeq;
        if (next.uidNext !== undefined && mailbox.uidNext < next.uidNext) mailbox.uidNext = next.uidNext;
        return { count: 1 };
      },
    },
    folder: {
      findMany: async ({ where }: { where: Row }) => {
        await tick();
        return db.folders.filter((f) => matches(asRow(f), where)).sort((a, b) => a.name.localeCompare(b.name));
      },
      findFirst: async ({ where }: { where: Row }) => { await tick(); return withMailbox(db.folders.find((f) => matches(asRow(f), where))); },
      create: async ({ data }: { data: { mailboxId: string; name: string; displayName: string } }) => {
        const created = { id: `f-new-${nextId++}`, ...data };
        db.folders.push(created);
        return created;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const target = db.folders.find((f) => f.id === where.id);
        if (target) applyData(asRow(target), data);
        return target;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        db.folders = db.folders.filter((f) => f.id !== where.id);
        return {};
      },
    },
    message: {
      findMany: async ({ where, orderBy }: { where: Row; orderBy?: { uid?: 'asc' | 'desc' } }) => {
        db.messageReads++;
        await tick();
        return sortByUid(db.messages.filter((m) => matches(asRow(m), where)), orderBy).map((m) => ({ ...m, flags: [...m.flags] }));
      },
      count: async ({ where }: { where: Row }) => { await tick(); return db.messages.filter((m) => matches(asRow(m), where)).length; },
      // message-store counter floor check: { where: { folder: { mailboxId } }, _max: { modSeq, uid } }
      aggregate: async () => {
        await tick();
        const rows = db.messages;
        return {
          _max: {
            modSeq: rows.length ? rows.reduce((a, m) => (m.modSeq > a ? m.modSeq : a), 0n) : null,
            uid: rows.length ? Math.max(...rows.map((m) => m.uid)) : null,
          },
        };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        await tick();
        const target = db.messages.find((m) => m.id === where.id);
        if (!target) throw new Error('fake prisma: message not found');
        applyData(asRow(target), data);
        return { ...target };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        await tick();
        const targets = db.messages.filter((m) => matches(asRow(m), where));
        for (const target of targets) applyData(asRow(target), data);
        return { count: targets.length };
      },
      create: async ({ data }: { data: Row }) => {
        await tick();
        const created = { ...baseMessage(0, '', {}), ...data } as FakeMessage;
        db.messages.push(created);
        return created;
      },
    },
  };

  let onMessage: ((channel: string, message: string) => void) | null = null;
  const subscriber = {
    subscribe: async () => 1,
    on: (event: string, listener: (channel: string, message: string) => void) => { if (event === 'message') onMessage = listener; },
  };
  const redisClient = { duplicate: () => subscriber };
  const redis: RedisFake = {
    emitNewMail(event) {
      if (!onMessage) throw new Error('fixture: the server did not subscribe to new-mail events');
      onMessage('mail:new', JSON.stringify(event));
    },
  };

  const globals = (globalThis as unknown as { __coremailTest: { prisma?: unknown; redis?: unknown } }).__coremailTest;
  globals.prisma = prisma;
  globals.redis = redisClient;
  return { db, redis };
}

// ─── Client ──────────────────────────────────────────────────────────────────

interface Response {
  /** The tagged completion line, e.g. "A3 OK FETCH completed". */
  tagged: string;
  /** "OK" | "NO" | "BAD" */
  status: string;
  /** Every line received before the tagged line (untagged responses, continuation requests, literal data). */
  lines: string[];
  /** Raw octets of `lines` (CRLF-joined) for literal inspection. */
  raw: string;
}

class ImapClient {
  private buffer = '';
  private wake: (() => void) | null = null;
  private readonly socket: net.Socket;
  private tagCounter = 0;
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

  nextTag(): string {
    this.tagCounter += 1;
    return `A${this.tagCounter}`;
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

  /** Reads until the tagged completion for `tag`. */
  async completion(tag: string): Promise<Response> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) {
        return { tagged: line, status: line.split(' ')[1] ?? '', lines, raw: lines.map((l) => `${l}\r\n`).join('') };
      }
      lines.push(line);
    }
  }

  /** Sends "<tag> <command>" and reads until its tagged completion. */
  async cmd(command: string): Promise<Response> {
    const tag = this.nextTag();
    this.write(`${tag} ${command}\r\n`);
    return this.completion(tag);
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
    while (!this.closed && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    return this.closed;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

interface Harness {
  client: ImapClient;
  db: FakeDb;
  redis: RedisFake;
  greeting: string;
}

let cachedCert: { cert: Buffer; key: Buffer } | null = null;
const testCert = (): { cert: Buffer; key: Buffer } => (cachedCert ??= selfSignedTestCert());

/**
 * v7: credentials are only accepted over TLS, so the default harness runs the
 * implicit-TLS configuration (port 993). `plain: true` starts the plaintext
 * listener (port 143) with a STARTTLS certificate.
 */
async function connect(t: TestContext, options: { plain?: boolean } = {}): Promise<Harness> {
  const { db, redis } = installFakes();
  const server = options.plain
    ? createImapServer(undefined, { starttls: testCert })
    : createImapServer(testCert());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const socket = options.plain
    ? net.connect(port, '127.0.0.1')
    : tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => {
    socket.once(options.plain ? 'connect' : 'secureConnect', resolve);
    socket.once('error', reject);
  });
  const client = new ImapClient(socket);
  t.after(() => { client.destroy(); server.close(); });
  const greeting = await client.readLine();
  return { client, db, redis, greeting };
}

async function login(t: TestContext): Promise<Harness> {
  const harness = await connect(t);
  const response = await harness.client.cmd('LOGIN bob@example.test secret');
  assert.equal(response.status, 'OK', 'test setup: LOGIN must succeed');
  return harness;
}

async function select(t: TestContext, mailbox = 'INBOX', verb: 'SELECT' | 'EXAMINE' = 'SELECT'): Promise<Harness> {
  const harness = await login(t);
  const response = await harness.client.cmd(`${verb} ${mailbox}`);
  assert.equal(response.status, 'OK', `test setup: ${verb} must succeed`);
  return harness;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const untagged = (r: Response, pattern: RegExp): string[] => r.lines.filter((l) => l.startsWith('* ') && pattern.test(l));
const capabilitiesOf = (line: string): string[] => (/CAPABILITY ([^\]]+?)(\]|$)/.exec(line)?.[1] ?? '').trim().split(' ');

/** Extracts the octets of the first literal that follows `item` in a FETCH response. */
function literalOf(response: Response, item: string): { announced: number; data: Buffer } {
  const start = response.raw.indexOf(`${item} {`);
  assert.notEqual(start, -1, `no literal for ${item} in: ${JSON.stringify(response.raw)}`);
  const open = response.raw.indexOf('{', start);
  const close = response.raw.indexOf('}\r\n', open);
  const announced = parseInt(response.raw.slice(open + 1, close), 10);
  const rest = Buffer.from(response.raw.slice(close + 3), 'utf8');
  return { announced, data: rest.subarray(0, announced) };
}

// ─── Greeting / CAPABILITY ───────────────────────────────────────────────────

describe('greeting and CAPABILITY (RFC 9051 §7.1, §6.1.1)', () => {
  test('the greeting is an untagged OK carrying a CAPABILITY response code', async (t) => {
    const { greeting } = await connect(t);

    assert.match(greeting, /^\* OK \[CAPABILITY [^\]]+\] /);
  });

  test('the greeting announces both IMAP4rev1 and IMAP4rev2', async (t) => {
    const { greeting } = await connect(t);

    const caps = capabilitiesOf(greeting);
    assert.ok(caps.includes('IMAP4rev1') && caps.includes('IMAP4rev2'), caps.join(' '));
  });

  test('CAPABILITY returns an untagged capability list and a tagged OK', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('CAPABILITY');

    assert.equal(response.status, 'OK');
    assert.equal(untagged(response, /^\* CAPABILITY IMAP4rev1 /).length, 1);
  });

  test('the documented extensions are advertised', async (t) => {
    const { client } = await connect(t);

    const caps = capabilitiesOf((await client.cmd('CAPABILITY')).lines[0] ?? '');

    for (const cap of ['IDLE', 'CONDSTORE', 'MOVE', 'UNSELECT', 'UIDPLUS', 'ID', 'STATUS=SIZE', 'ENABLE', 'NAMESPACE']) {
      assert.ok(caps.includes(cap), `${cap} missing in: ${caps.join(' ')}`);
    }
  });

  test('STARTTLS, which is advertised on the plaintext listener, is actually available', async (t) => {
    // RFC 9051 §6.2.1 / §11.1: a server that advertises STARTTLS must perform the TLS negotiation.
    const { client, greeting } = await connect(t, { plain: true });
    assert.ok(capabilitiesOf(greeting).includes('STARTTLS'), 'precondition: STARTTLS is advertised');

    const response = await client.cmd('STARTTLS');

    assert.equal(response.status, 'OK', response.tagged);
  });

  test('LOGIN is refused while LOGINDISABLED is advertised', async (t) => {
    // RFC 3501 §11.1 / RFC 9051 §11.1: the server "advertises the LOGINDISABLED capability and does NOT permit the LOGIN command" —
    // a server that announces LOGINDISABLED must reject LOGIN instead of accepting the cleartext password.
    const { client, greeting } = await connect(t, { plain: true });
    assert.ok(capabilitiesOf(greeting).includes('LOGINDISABLED'), 'precondition: LOGINDISABLED is advertised');

    const response = await client.cmd('LOGIN bob@example.test secret');

    assert.notEqual(response.status, 'OK', response.tagged);
  });

  test('advertised QUOTA: GETQUOTAROOT is a known command (RFC 9208)', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('GETQUOTAROOT INBOX');

    assert.notEqual(response.status, 'BAD', response.tagged);
  });

  test('advertised ESEARCH: SEARCH RETURN (COUNT) yields an ESEARCH response (RFC 4731)', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('SEARCH RETURN (COUNT) ALL');

    assert.deepEqual(untagged(response, /^\* ESEARCH .*COUNT 3/).length, 1, JSON.stringify(response.lines));
  });

  test('advertised LIST-STATUS: LIST … RETURN (STATUS (MESSAGES)) yields STATUS responses (RFC 5819)', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('LIST "" "*" RETURN (STATUS (MESSAGES))');

    assert.ok(untagged(response, /^\* STATUS /).length > 0, JSON.stringify(response.lines));
  });
});

// ─── Generic command handling ────────────────────────────────────────────────

describe('command syntax (RFC 9051 §2.2, §7.1)', () => {
  test('an unknown command is answered with a tagged BAD', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('FROBNICATE');

    assert.equal(response.status, 'BAD');
  });

  test('command names are case-insensitive', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('noop');

    assert.equal(response.status, 'OK');
  });

  test('a line that contains only a tag is answered with BAD instead of silence', async (t) => {
    // RFC 9051 §7.1.3: BAD "reports a protocol-level error in the client's command"; a client that gets
    // no response at all waits forever.
    const { client } = await connect(t);

    client.write('A1\r\n');
    const lines = await client.drain();

    assert.ok(lines.some((l) => / BAD /.test(l)), `server sent: ${JSON.stringify(lines)}`);
  });

  test('NOOP always succeeds', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('NOOP');

    assert.equal(response.status, 'OK');
  });

  test('LOGOUT sends an untagged BYE before the tagged OK and closes the connection', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('LOGOUT');
    const closed = await client.waitForClose();

    assert.deepEqual([response.lines[0]?.slice(0, 5), response.status, closed], ['* BYE', 'OK', true]);
  });

  test('ID returns the server identification (RFC 2971)', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('ID ("name" "test-client")');

    assert.equal(response.status, 'OK');
    assert.equal(untagged(response, /^\* ID \("name" "CoreMail"/).length, 1);
  });

  test('mailbox commands are refused before authentication', async (t) => {
    const { client } = await connect(t);

    const statuses = [];
    for (const command of ['SELECT INBOX', 'LIST "" "*"', 'STATUS INBOX (MESSAGES)', 'CREATE x', 'IDLE', 'NAMESPACE']) {
      statuses.push((await client.cmd(command)).status);
    }

    assert.ok(statuses.every((s) => s === 'NO' || s === 'BAD'), statuses.join(','));
  });

  test('message commands are refused when no mailbox is selected', async (t) => {
    const { client } = await login(t);

    const statuses = [];
    for (const command of ['FETCH 1 FLAGS', 'STORE 1 +FLAGS (\\Seen)', 'SEARCH ALL', 'EXPUNGE', 'CLOSE', 'UNSELECT', 'COPY 1 Sent']) {
      statuses.push((await client.cmd(command)).status);
    }

    assert.ok(statuses.every((s) => s === 'NO' || s === 'BAD'), statuses.join(','));
  });

  test('pipelined SELECT and FETCH are executed in order', async (t) => {
    // RFC 9051 §5.5: a client may send the next command without waiting for the completion of the previous
    // one (unless an ambiguity would result); the server must process them as if sent one after the other.
    const { client } = await login(t);

    client.write('P1 SELECT INBOX\r\nP2 FETCH 1 (UID)\r\n');
    const completions = (await client.drain(300)).filter((l) => /^P[12] /.test(l));

    assert.deepEqual(completions.map((l) => l.split(' ').slice(0, 2).join(' ')), ['P1 OK', 'P2 OK'], JSON.stringify(completions));
  });
});

// ─── LOGIN / AUTHENTICATE ────────────────────────────────────────────────────

describe('LOGIN and AUTHENTICATE (RFC 9051 §6.2.2–3, RFC 4616, RFC 4959)', () => {
  test('LOGIN with valid credentials succeeds', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('LOGIN bob@example.test secret');

    assert.equal(response.status, 'OK');
  });

  test('LOGIN accepts quoted strings', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('LOGIN "bob@example.test" "secret"');

    assert.equal(response.status, 'OK');
  });

  test('LOGIN accepts an app password', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('LOGIN bob@example.test app-password');

    assert.equal(response.status, 'OK');
  });

  test('LOGIN with a wrong password fails with NO [AUTHENTICATIONFAILED]', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('LOGIN bob@example.test wrong');

    assert.match(response.tagged, /^A1 NO \[AUTHENTICATIONFAILED\]/);
  });

  test('LOGIN without a password is a syntax error (BAD)', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('LOGIN bob@example.test');

    assert.equal(response.status, 'BAD');
  });

  test('LOGIN understands backslash-escaped quotes inside a quoted string', async (t) => {
    // RFC 9051 §9: quoted = DQUOTE *QUOTED-CHAR DQUOTE; QUOTED-CHAR = ... / "\" quoted-specials
    const { client } = await connect(t);
    (globalThis as unknown as { __coremailTest: { verifyPassword?: unknown } }).__coremailTest.verifyPassword =
      async (password: string) => password === 'pa"ss word';
    t.after(() => {
      delete (globalThis as unknown as { __coremailTest: { verifyPassword?: unknown } }).__coremailTest.verifyPassword;
    });

    const response = await client.cmd('LOGIN "bob@example.test" "pa\\"ss word"');

    assert.equal(response.status, 'OK', response.tagged);
  });

  test('LOGIN accepts its arguments as synchronizing literals', async (t) => {
    // RFC 9051 §4.3 / §9: astring = 1*ASTRING-CHAR / string; string = quoted / literal. The server must answer
    // "{n}" with a "+" continuation request and then read n octets.
    const { client } = await connect(t);

    client.write('A1 LOGIN {16}\r\n');
    const firstLine = await client.readLine();

    assert.match(firstLine, /^\+/, `expected a continuation request, got: ${firstLine}`);
  });

  test('advertised LITERAL+: a non-synchronizing literal is read as an argument (RFC 7888)', async (t) => {
    const { client } = await connect(t);

    client.write('A1 LOGIN {16+}\r\nbob@example.test {6+}\r\nsecret\r\n');
    const response = await client.completion('A1');

    assert.equal(response.status, 'OK', response.tagged);
  });

  test('AUTHENTICATE PLAIN with an initial response succeeds (SASL-IR)', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd(`AUTHENTICATE PLAIN ${b64('\0bob@example.test\0secret')}`);

    assert.equal(response.status, 'OK');
  });

  test('AUTHENTICATE PLAIN without an initial response sends a continuation request first', async (t) => {
    const { client } = await connect(t);

    client.write('A1 AUTHENTICATE PLAIN\r\n');
    const continuation = await client.readLine();
    client.write(`${b64('\0bob@example.test\0secret')}\r\n`);
    const response = await client.completion('A1');

    assert.match(continuation, /^\+ ?$/);
    assert.equal(response.status, 'OK');
  });

  test('AUTHENTICATE LOGIN prompts for user name and password', async (t) => {
    const { client } = await connect(t);

    client.write('A1 AUTHENTICATE LOGIN\r\n');
    const userPrompt = await client.readLine();
    client.write(`${b64('bob@example.test')}\r\n`);
    const passPrompt = await client.readLine();
    client.write(`${b64('secret')}\r\n`);
    const response = await client.completion('A1');

    assert.deepEqual([userPrompt, passPrompt, response.status], [`+ ${b64('Username:')}`, `+ ${b64('Password:')}`, 'OK']);
  });

  test('AUTHENTICATE with wrong credentials fails with NO', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd(`AUTHENTICATE PLAIN ${b64('\0bob@example.test\0wrong')}`);

    assert.equal(response.status, 'NO');
  });

  test('a client can cancel AUTHENTICATE with "*" and gets a tagged BAD', async (t) => {
    const { client } = await connect(t);
    client.write('A1 AUTHENTICATE PLAIN\r\n');
    await client.readLine();

    client.write('*\r\n');
    const response = await client.completion('A1');

    assert.equal(response.status, 'BAD');
  });

  test('the session accepts commands again after a cancelled AUTHENTICATE', async (t) => {
    const { client } = await connect(t);
    client.write('X1 AUTHENTICATE LOGIN\r\n');
    await client.readLine();
    client.write('*\r\n');
    await client.completion('X1');

    const response = await client.cmd('NOOP');

    assert.equal(response.status, 'OK');
  });

  test('an unsupported SASL mechanism is rejected with NO', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('AUTHENTICATE XOAUTH2 dGVzdA==');

    assert.equal(response.status, 'NO');
  });

  test('AUTHENTICATE is refused when already authenticated', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd(`AUTHENTICATE PLAIN ${b64('\0bob@example.test\0secret')}`);

    assert.notEqual(response.status, 'OK');
  });
});

// ─── LIST / STATUS / NAMESPACE ───────────────────────────────────────────────

describe('LIST, NAMESPACE and STATUS (RFC 9051 §6.3.9–11)', () => {
  test('LIST "" "*" returns every mailbox with the hierarchy delimiter "."', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('LIST "" "*"');

    const names = untagged(response, /^\* LIST /).map((l) => /"\." "?([^"]+)"?$/.exec(l)?.[1]);
    assert.deepEqual(names, ['Archive', 'Archive.2025', 'INBOX', 'Sent', 'Work']);
  });

  test('LIST marks special-use mailboxes (RFC 6154)', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('LIST "" "Sent"');

    assert.match(untagged(response, /^\* LIST /)[0] ?? '', /\\Sent/);
  });

  test('LIST supports "*" wildcards inside a pattern', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('LIST "" "Arch*"');

    assert.equal(untagged(response, /^\* LIST /).length, 2);
  });

  test('LIST with "%" does not descend into child mailboxes', async (t) => {
    // RFC 9051 §6.3.9: '"%" is similar to "*", but it does not match a hierarchy delimiter.'
    const { client } = await login(t);

    const response = await client.cmd('LIST "" "%"');

    const lines = untagged(response, /^\* LIST /);
    assert.ok(!lines.some((l) => l.includes('Archive.2025')), JSON.stringify(lines));
  });

  test('LIST with an empty mailbox name returns the hierarchy delimiter', async (t) => {
    // RFC 9051 §6.3.9: 'An empty ("" string) mailbox name argument is a special request to return the
    // hierarchy delimiter and the root name of the name given in the reference.'
    const { client } = await login(t);

    const response = await client.cmd('LIST "" ""');

    assert.deepEqual(untagged(response, /^\* LIST \(\\Noselect\) "\." ""$/).length, 1, JSON.stringify(response.lines));
  });

  test('LIST reports \\HasChildren for a mailbox with child mailboxes (advertised CHILDREN, RFC 3348)', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('LIST "" "Archive"');

    assert.match(untagged(response, /^\* LIST /)[0] ?? '', /\\HasChildren/);
  });

  test('NAMESPACE returns one personal namespace with delimiter "."', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('NAMESPACE');

    assert.deepEqual(untagged(response, /^\* NAMESPACE/), ['* NAMESPACE (("" ".")) NIL NIL']);
  });

  test('STATUS returns the requested item', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('STATUS INBOX (MESSAGES)');

    assert.deepEqual(untagged(response, /^\* STATUS/), ['* STATUS "INBOX" (MESSAGES 3)']);
  });

  test('STATUS returns every item of a multi-item request', async (t) => {
    // RFC 9051 §6.3.11: status = "STATUS" SP mailbox SP "(" status-att *(SP status-att) ")"
    const { client } = await login(t);

    const response = await client.cmd('STATUS INBOX (MESSAGES UNSEEN UIDNEXT UIDVALIDITY)');

    assert.deepEqual(untagged(response, /^\* STATUS/), ['* STATUS "INBOX" (MESSAGES 3 UNSEEN 1 UIDNEXT 13 UIDVALIDITY 777)']);
  });

  test('STATUS (SIZE) returns the total size of the mailbox (advertised STATUS=SIZE, RFC 8438)', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('STATUS INBOX (SIZE)');

    assert.deepEqual(untagged(response, /^\* STATUS/), [`* STATUS "INBOX" (SIZE ${1005 + 1009 + 1012})`]);
  });

  test('STATUS for a missing mailbox fails with NO', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('STATUS Nope (MESSAGES)');

    assert.equal(response.status, 'NO');
  });
});

// ─── CREATE / DELETE / RENAME ────────────────────────────────────────────────

describe('CREATE, DELETE and RENAME (RFC 9051 §6.3.4–6)', () => {
  test('CREATE adds a mailbox', async (t) => {
    const { client, db } = await login(t);

    const response = await client.cmd('CREATE "Projects"');

    assert.equal(response.status, 'OK');
    assert.ok(db.folders.some((f) => f.name === 'Projects'));
  });

  test('CREATE ignores a trailing hierarchy delimiter', async (t) => {
    const { client, db } = await login(t);

    await client.cmd('CREATE Projects.');

    assert.ok(db.folders.some((f) => f.name === 'Projects'));
  });

  test('CREATE of an existing mailbox fails with NO', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('CREATE Sent');

    assert.equal(response.status, 'NO');
  });

  test('CREATE INBOX fails with NO in any letter case', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('CREATE inbox');

    assert.equal(response.status, 'NO');
  });

  test('DELETE removes a mailbox', async (t) => {
    const { client, db } = await login(t);

    const response = await client.cmd('DELETE Work');

    assert.equal(response.status, 'OK');
    assert.ok(!db.folders.some((f) => f.name === 'Work'));
  });

  test('DELETE INBOX fails with NO', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('DELETE INBOX');

    assert.equal(response.status, 'NO');
  });

  test('DELETE of a missing mailbox fails with NO', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('DELETE Nope');

    assert.equal(response.status, 'NO');
  });

  test('RENAME changes the mailbox name', async (t) => {
    const { client, db } = await login(t);

    const response = await client.cmd('RENAME Work Job');

    assert.equal(response.status, 'OK');
    assert.ok(db.folders.some((f) => f.name === 'Job') && !db.folders.some((f) => f.name === 'Work'));
  });

  test('RENAME to an existing name fails with NO', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('RENAME Work Sent');

    assert.equal(response.status, 'NO');
  });

  test('RENAME also renames inferior mailboxes', async (t) => {
    // RFC 9051 §6.3.6: 'If the name has inferior hierarchical names, then the inferior hierarchical names
    // MUST also be renamed. For example, a rename of "foo" to "zap" will rename "foo/bar" to "zap/bar".'
    const { client, db } = await login(t);

    await client.cmd('RENAME Archive Old');

    assert.ok(db.folders.some((f) => f.name === 'Old.2025'), db.folders.map((f) => f.name).join(','));
  });
});

// ─── SELECT / EXAMINE / CLOSE / UNSELECT / ENABLE ────────────────────────────

describe('SELECT, EXAMINE, CLOSE, UNSELECT and ENABLE (RFC 9051 §6.3.1–3, §6.4.1–2)', () => {
  test('SELECT reports EXISTS, FLAGS, UIDVALIDITY and UIDNEXT', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('SELECT INBOX');

    assert.ok(response.lines.includes('* 3 EXISTS'));
    assert.equal(untagged(response, /^\* FLAGS \(/).length, 1);
    assert.equal(untagged(response, /^\* OK \[UIDVALIDITY 777\]/).length, 1);
    assert.equal(untagged(response, /^\* OK \[UIDNEXT 13\]/).length, 1);
  });

  test('SELECT completes with [READ-WRITE]', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('SELECT INBOX');

    assert.match(response.tagged, /OK \[READ-WRITE\]/);
  });

  test('EXAMINE completes with [READ-ONLY]', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('EXAMINE INBOX');

    assert.match(response.tagged, /OK \[READ-ONLY\]/);
  });

  test('the UNSEEN response code carries the sequence number of the first unseen message', async (t) => {
    // RFC 3501 §6.3.1: "OK [UNSEEN <n>] The message sequence number of the first unseen message in the
    // mailbox." (not the number of unseen messages). Fixture: only sequence number 3 is unseen.
    const { client } = await login(t);

    const response = await client.cmd('SELECT INBOX');

    assert.deepEqual(untagged(response, /\[UNSEEN \d+\]/).map((l) => /\[UNSEEN (\d+)\]/.exec(l)?.[1]), ['3']);
  });

  test('SELECT of a missing mailbox fails with NO', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('SELECT Nope');

    assert.equal(response.status, 'NO');
  });

  test('CLOSE returns to the authenticated state', async (t) => {
    const { client } = await select(t);

    const close = await client.cmd('CLOSE');
    const fetch = await client.cmd('FETCH 1 FLAGS');

    assert.equal(close.status, 'OK');
    assert.notEqual(fetch.status, 'OK');
  });

  test('CLOSE permanently removes messages flagged \\Deleted', async (t) => {
    const { client, db } = await select(t);
    db.byUid(9).flags.push('\\Deleted');

    await client.cmd('CLOSE');

    assert.notEqual(db.byUid(9).deletedAt, null);
  });

  test('CLOSE after EXAMINE removes nothing', async (t) => {
    // RFC 9051 §6.4.1: "No messages are removed, and no error is given, if the mailbox is selected by an
    // EXAMINE command or is otherwise selected as read-only."
    const { client, db } = await select(t, 'INBOX', 'EXAMINE');
    db.byUid(9).flags.push('\\Deleted');

    await client.cmd('CLOSE');

    assert.equal(db.byUid(9).deletedAt, null);
  });

  test('UNSELECT leaves messages flagged \\Deleted in place (RFC 3691)', async (t) => {
    const { client, db } = await select(t);
    db.byUid(9).flags.push('\\Deleted');

    const response = await client.cmd('UNSELECT');

    assert.equal(response.status, 'OK');
    assert.equal(db.byUid(9).deletedAt, null);
  });

  test('ENABLE CONDSTORE is confirmed with an untagged ENABLED response (RFC 5161)', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('ENABLE CONDSTORE');

    assert.deepEqual(response.lines, ['* ENABLED CONDSTORE']);
  });

  test('ENABLE IMAP4rev2 is confirmed with an untagged ENABLED response', async (t) => {
    // RFC 9051 §6.3.1: the server advertises IMAP4rev2, so "ENABLE IMAP4rev2" must be acknowledged with
    // "* ENABLED IMAP4rev2" and switch the session to rev2 semantics.
    const { client } = await login(t);

    const response = await client.cmd('ENABLE IMAP4rev2');

    assert.deepEqual(response.lines, ['* ENABLED IMAP4rev2']);
  });
});

// ─── FETCH ───────────────────────────────────────────────────────────────────

describe('FETCH and UID FETCH (RFC 9051 §6.4.5, §6.4.9)', () => {
  test('FETCH 1:* returns one response per message with ascending sequence numbers', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('FETCH 1:* (FLAGS)');

    assert.deepEqual(untagged(response, / FETCH /).map((l) => l.split(' ')[1]), ['1', '2', '3']);
  });

  test('FETCH addresses messages by sequence number', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('FETCH 2 (UID)');

    assert.deepEqual(untagged(response, / FETCH /), ['* 2 FETCH (UID 9)']);
  });

  test('FETCH * addresses the last message', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('FETCH * (UID)');

    assert.deepEqual(untagged(response, / FETCH /), ['* 3 FETCH (UID 12)']);
  });

  test('FETCH returns the stored flags', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('FETCH 1 (FLAGS)');

    assert.match(untagged(response, / FETCH /)[0] ?? '', /FLAGS \(\\Seen\)/);
  });

  test('UID FETCH addresses messages by UID, not by sequence number', async (t) => {
    // RFC 9051 §6.4.9: with the UID prefix "the numbers in the sequence-set argument are unique identifiers
    // instead of message sequence numbers".
    const { client } = await select(t);

    const response = await client.cmd('UID FETCH 9 (FLAGS)');

    assert.equal(untagged(response, /^\* 2 FETCH \(.*UID 9\b/).length, 1, JSON.stringify(response.lines));
  });

  test('UID FETCH with a UID range returns exactly the messages in that range', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('UID FETCH 9:* (FLAGS)');

    assert.deepEqual(untagged(response, / FETCH /).map((l) => l.split(' ')[1]), ['2', '3']);
  });

  test('UID FETCH with a UID that does not exist returns no data and OK', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('UID FETCH 3 (FLAGS)');

    assert.equal(response.status, 'OK');
    assert.deepEqual(untagged(response, / FETCH /), []);
  });

  test('a malformed sequence set is rejected with BAD', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('FETCH abc (FLAGS)');

    assert.equal(response.status, 'BAD', response.tagged);
  });

  test('INTERNALDATE uses the date-time format "dd-Mon-yyyy hh:mm:ss +zzzz"', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('FETCH 1 (INTERNALDATE)');

    assert.match(response.lines[0] ?? '', /INTERNALDATE "03-Feb-2026 10:20:31 \+0000"/);
  });

  test('ENVELOPE carries subject, sender and recipient', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('FETCH 1 (ENVELOPE)');

    const line = response.lines[0] ?? '';
    assert.match(line, /ENVELOPE \("[^"]+" "Subject 5" \(\("Alice" NIL "alice" "example.test"\)\)/);
    assert.match(line, /\(\(NIL NIL "bob" "example.test"\)\)/);
  });

  test('ENVELOPE includes the Cc addresses', async (t) => {
    // RFC 9051 §7.5.2 ENVELOPE: fields are date, subject, from, sender, reply-to, to, cc, bcc, in-reply-to,
    // message-id. Message UID 9 has Cc: carol@example.test.
    const { client } = await select(t);

    const response = await client.cmd('FETCH 2 (ENVELOPE)');

    assert.match(response.lines[0] ?? '', /"carol" "example.test"/);
  });

  test('BODY.PEEK[] announces exactly the number of octets it sends', async (t) => {
    const { client, db } = await select(t);
    db.byUid(5).bodyText = 'Grüße – ✓';

    const response = await client.cmd('FETCH 1 (BODY.PEEK[])');

    const literal = literalOf(response, 'BODY[]');
    assert.equal(literal.data.length, literal.announced);
    assert.match(literal.data.toString('utf8'), /Grüße – ✓$/);
  });

  test('BODY.PEEK[] does not set the \\Seen flag', async (t) => {
    const { client, db } = await select(t);

    await client.cmd('FETCH 3 (BODY.PEEK[])');
    await client.cmd('NOOP');

    assert.deepEqual(db.byUid(12).flags, []);
  });

  test('BODY[] sets the \\Seen flag', async (t) => {
    const { client, db } = await select(t);

    await client.cmd('FETCH 3 (BODY[])');
    await client.cmd('NOOP');

    assert.deepEqual(db.byUid(12).flags, ['\\Seen']);
  });

  test('BODY[] does not set \\Seen in a mailbox opened with EXAMINE', async (t) => {
    // RFC 9051 §6.3.3: EXAMINE — "the selected mailbox is identified as read-only. No changes to the
    // permanent state of the mailbox, including per-user state, are permitted."
    const { client, db } = await select(t, 'INBOX', 'EXAMINE');

    await client.cmd('FETCH 3 (BODY[])');
    await client.cmd('NOOP');

    assert.deepEqual(db.byUid(12).flags, []);
  });

  test('RFC822.SIZE equals the number of octets returned for BODY[]', async (t) => {
    // RFC 9051 §7.5.2: RFC822.SIZE is "the size of the message, as defined in Section 2.3.4" — the octet
    // count of the RFC 5322 representation, i.e. of what BODY[] returns. Clients size buffers and detect
    // truncated downloads with it. Fixture: rawSize (1005) stands for the size of the message as originally
    // received and stored by smtp-server; the server answers BODY[] with a message re-synthesized from DB
    // columns, so the two can only agree by coincidence.
    const { client } = await select(t);

    const response = await client.cmd('FETCH 1 (RFC822.SIZE BODY.PEEK[])');

    const size = parseInt(/RFC822\.SIZE (\d+)/.exec(response.raw)?.[1] ?? '-1', 10);
    assert.equal(size, literalOf(response, 'BODY[]').announced);
  });

  test('BODY[HEADER] ends with the blank line that separates header and body', async (t) => {
    // RFC 9051 §6.4.5: "the HEADER ... part specifiers ... The header ... includes the delimiting
    // blank line between the header and the body."
    const { client } = await select(t);

    const response = await client.cmd('FETCH 1 (BODY.PEEK[HEADER])');

    assert.match(literalOf(response, 'BODY[HEADER]').data.toString('utf8'), /\r\n\r\n$/);
  });

  test('BODY[HEADER.FIELDS (SUBJECT)] returns only the requested header field', async (t) => {
    // RFC 9051 §6.4.5: HEADER.FIELDS returns "a subset of the header ... only those header fields with a
    // field-name that matches one of the names in the list".
    const { client } = await select(t);

    const response = await client.cmd('FETCH 1 (BODY.PEEK[HEADER.FIELDS (SUBJECT)])');

    const headerNames = [...response.raw.matchAll(/^([A-Za-z-]+):/gm)].map((m) => m[1]);
    assert.deepEqual(headerNames, ['Subject']);
  });

  test('BODY[1] returns the content of part 1 without the message header', async (t) => {
    // RFC 9051 §6.4.5: a numeric part specifier refers to the body part; for a single-part message
    // "1" is the body content — BODYSTRUCTURE of this message is ("text" "plain" …).
    const { client } = await select(t);

    const response = await client.cmd('FETCH 1 (BODY.PEEK[1])');

    assert.equal(literalOf(response, 'BODY[1]').data.toString('utf8'), 'Body of 5');
  });

  test('a partial fetch BODY[]<0.10> returns 10 octets labelled BODY[]<0>', async (t) => {
    // RFC 9051 §6.4.5: "BODY[]<0.2048> of a 1500-octet message will return BODY[]<0> with a literal of
    // size 1500" — the response item names the origin octet and the literal is limited to the range.
    const { client } = await select(t);

    const response = await client.cmd('FETCH 1 (BODY.PEEK[]<0.10>)');

    assert.equal(literalOf(response, 'BODY[]<0>').announced, 10);
  });

  test('a large message stored in object storage is not returned with an empty body', async (t) => {
    // smtp-server/src/handlers/message.ts stores messages > 256 KB in MinIO (storagePath) and saves
    // bodyText/bodyHtml as ''. A FETCH that ignores storagePath returns the headers only.
    // The object-storage fake (test-hooks.mjs, __coremailTest.objects) returns the raw message.
    const { client, db } = await select(t);
    const raw = Buffer.from(`From: alice@example.test\r\nSubject: Large\r\n\r\n${'x'.repeat(300_000 - 44)}`);
    (globalThis as unknown as { __coremailTest: { objects: Map<string, Buffer> } }).__coremailTest.objects.set('raw/large-message', raw);
    Object.assign(db.byUid(5), { bodyText: '', bodyHtml: '', storagePath: 'raw/large-message', rawSize: raw.length });

    const response = await client.cmd('FETCH 1 (BODY.PEEK[TEXT])');

    assert.notEqual(literalOf(response, 'BODY[TEXT]').announced, 0, 'BODY[TEXT] of a 300 000 octet message is empty');
  });

  test('MODSEQ is included after ENABLE CONDSTORE (RFC 7162)', async (t) => {
    const { client } = await login(t);
    await client.cmd('ENABLE CONDSTORE');
    await client.cmd('SELECT INBOX');

    const response = await client.cmd('FETCH 1 (FLAGS)');

    assert.match(response.lines[0] ?? '', /MODSEQ \(10\)/);
  });
});

// ─── STORE ───────────────────────────────────────────────────────────────────

describe('STORE and UID STORE (RFC 9051 §6.4.6)', () => {
  test('+FLAGS adds a flag and reports the new flags', async (t) => {
    const { client, db } = await select(t, 'Work');

    const response = await client.cmd('STORE 2 +FLAGS (\\Seen)');

    assert.equal(untagged(response, /^\* 2 FETCH \(.*FLAGS \(\\Seen\)/).length, 1, JSON.stringify(response.lines));
    assert.deepEqual(db.byUid(2).flags, ['\\Seen']);
  });

  // v8.0 review: STORE computed the new list from flags read outside the transaction.
  test('+FLAGS keeps a flag another client stored concurrently (no lost update)', async (t) => {
    const { client, db } = await select(t, 'Work');
    // Another client's "+FLAGS (\Answered)" commits between our read and our write.
    db.beforeTransaction = () => {
      db.beforeTransaction = undefined;
      db.byUid(2).flags.push('\\Answered');
      db.byUid(2).modSeq = 11n; db.mailbox.highestModSeq = 11n;
    };

    const response = await client.cmd('STORE 2 +FLAGS (\\Flagged)');

    assert.deepEqual(db.byUid(2).flags, ['\\Answered', '\\Flagged']);
    assert.equal(untagged(response, /^\* 2 FETCH \(FLAGS \(\\Answered \\Flagged\)\)$/).length, 1, JSON.stringify(response.lines));
  });

  test('-FLAGS removes a flag', async (t) => {
    const { client, db } = await select(t, 'Work');

    await client.cmd('STORE 1 -FLAGS (\\Flagged)');

    assert.deepEqual(db.byUid(1).flags, ['\\Seen']);
  });

  test('FLAGS replaces all flags', async (t) => {
    const { client, db } = await select(t, 'Work');

    await client.cmd('STORE 1 FLAGS (\\Answered)');

    assert.deepEqual(db.byUid(1).flags, ['\\Answered']);
  });

  test('.SILENT suppresses the untagged FETCH response', async (t) => {
    const { client } = await select(t, 'Work');

    const response = await client.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');

    assert.deepEqual(response.lines, []);
  });

  test('STORE addresses messages by sequence number', async (t) => {
    // INBOX sequence number 2 is UID 9; there is no message with UID 2.
    const { client, db } = await select(t);

    const response = await client.cmd('STORE 2 +FLAGS (\\Flagged)');

    assert.equal(response.status, 'OK');
    assert.ok(db.byUid(9).flags.includes('\\Flagged'), `flags of UID 9: ${JSON.stringify(db.byUid(9).flags)}`);
  });

  test('STORE never touches the message whose UID happens to equal the sequence number', async (t) => {
    // INBOX: STORE 5 does not exist as a sequence number (only 1..3), although a message with UID 5 does.
    const { client, db } = await select(t);

    await client.cmd('STORE 5 +FLAGS (\\Deleted)');

    assert.ok(!db.byUid(5).flags.includes('\\Deleted'), 'STORE 5 modified the message with UID 5');
  });

  test('UID STORE is a known command and addresses messages by UID', async (t) => {
    // RFC 9051 §6.4.9: "UID ... STORE" — used by practically every client to set \Seen / \Deleted.
    const { client, db } = await select(t);

    const response = await client.cmd('UID STORE 9 +FLAGS (\\Flagged)');

    assert.equal(response.status, 'OK', response.tagged);
    assert.ok(db.byUid(9).flags.includes('\\Flagged'));
  });

  test('STORE is refused in a mailbox opened with EXAMINE', async (t) => {
    // RFC 9051 §6.3.3: no changes to the permanent state are permitted on a read-only mailbox.
    const { client, db } = await select(t, 'Work', 'EXAMINE');

    const response = await client.cmd('STORE 2 +FLAGS (\\Deleted)');

    assert.notEqual(response.status, 'OK');
    assert.deepEqual(db.byUid(2).flags, []);
  });

  test('an unknown STORE data item is rejected with BAD', async (t) => {
    const { client, db } = await select(t, 'Work');

    const response = await client.cmd('STORE 1 FROBS (\\Seen)');

    assert.equal(response.status, 'BAD', response.tagged);
    assert.deepEqual(db.byUid(1).flags, ['\\Seen', '\\Flagged']);
  });
});

// ─── EXPUNGE ─────────────────────────────────────────────────────────────────

describe('EXPUNGE and UID EXPUNGE (RFC 9051 §6.4.3, RFC 4315)', () => {
  test('EXPUNGE permanently removes messages flagged \\Deleted and keeps the others', async (t) => {
    const { client, db } = await select(t);
    db.byUid(9).flags.push('\\Deleted');

    const response = await client.cmd('EXPUNGE');

    assert.equal(response.status, 'OK');
    assert.deepEqual(db.messages.filter((m) => m.deletedAt !== null).map((m) => m.uid), [9]);
  });

  test('EXPUNGE announces every removed message with an untagged EXPUNGE response', async (t) => {
    // RFC 9051 §7.5.1: "The EXPUNGE response reports that the specified message sequence number has been
    // permanently removed from the mailbox." Without it the client keeps a stale message list.
    const { client, db } = await select(t);
    db.byUid(9).flags.push('\\Deleted');

    const response = await client.cmd('EXPUNGE');

    assert.deepEqual(response.lines, ['* 2 EXPUNGE']);
  });

  test('UID EXPUNGE is a known command (advertised UIDPLUS)', async (t) => {
    const { client, db } = await select(t);
    db.byUid(9).flags.push('\\Deleted');

    const response = await client.cmd('UID EXPUNGE 9');

    assert.equal(response.status, 'OK', response.tagged);
  });
});

// ─── COPY / MOVE ─────────────────────────────────────────────────────────────

describe('COPY and MOVE (RFC 9051 §6.4.7–8, RFC 4315)', () => {
  test('COPY duplicates the message addressed by sequence number into the target mailbox', async (t) => {
    const { client, db } = await select(t);

    const response = await client.cmd('COPY 2 Archive');

    assert.equal(response.status, 'OK');
    assert.deepEqual(db.messages.filter((m) => m.folderId === 'f-archive').map((m) => m.subject), ['Subject 9']);
  });

  test('COPY reports source and destination UIDs in a COPYUID response code', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('COPY 2 Archive');

    assert.match(response.tagged, /OK \[COPYUID 777 9 13\]/);
  });

  test('UID COPY addresses the source message by UID', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('UID COPY 12 Archive');

    assert.match(response.tagged, /OK \[COPYUID 777 12 13\]/);
  });

  test('COPY to a missing mailbox fails with NO [TRYCREATE]', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('COPY 1 Nope');

    assert.match(response.tagged, /NO \[TRYCREATE\]/);
  });

  test('MOVE puts the message into the target mailbox', async (t) => {
    const { client, db } = await select(t);

    const moving = db.byUid(9);
    const response = await client.cmd('MOVE 2 Archive');

    assert.equal(response.status, 'OK');
    assert.equal(moving.folderId, 'f-archive');
    // RFC 6851 §4.3: a new UID in the target mailbox (UIDNEXT was 13), reported via COPYUID.
    assert.equal(moving.uid, 13);
    assert.ok(response.lines.some((l) => /^\* OK \[COPYUID 777 9 13\]/.test(l)), response.lines.join('\n'));
  });

  test('MOVE announces the removal from the source mailbox with an untagged EXPUNGE', async (t) => {
    // RFC 6851 §3.3 / RFC 9051 §6.4.8: "the server ... MUST send EXPUNGE responses" for the moved messages
    // before the tagged OK.
    const { client } = await select(t);

    const response = await client.cmd('MOVE 2 Archive');

    assert.ok(response.lines.includes('* 2 EXPUNGE'), JSON.stringify(response.lines));
  });
});

// ─── SEARCH ──────────────────────────────────────────────────────────────────

describe('SEARCH and UID SEARCH (RFC 9051 §6.4.4)', () => {
  test('SEARCH ALL returns all sequence numbers', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('SEARCH ALL');

    assert.deepEqual(response.lines, ['* SEARCH 1 2 3']);
  });

  test('UID SEARCH ALL returns all UIDs', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('UID SEARCH ALL');

    assert.deepEqual(response.lines, ['* SEARCH 5 9 12']);
  });

  test('SEARCH UNSEEN returns only unseen messages', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('SEARCH UNSEEN');

    assert.deepEqual(response.lines, ['* SEARCH 3']);
  });

  test('SEARCH with no match returns an empty SEARCH response', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('SEARCH FLAGGED');

    assert.deepEqual(response.lines, ['* SEARCH']);
  });

  test('SEARCH NOT SEEN is equivalent to UNSEEN', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('SEARCH NOT SEEN');

    assert.deepEqual(response.lines, ['* SEARCH 3']);
  });

  test('multiple search keys are combined with AND', async (t) => {
    // RFC 9051 §6.4.4: "When multiple keys are specified, the result is the intersection (AND function)".
    // Fixture: UID 12 is unseen but flagged \Deleted → UNSEEN UNDELETED matches nothing.
    const { client, db } = await select(t);
    db.byUid(12).flags.push('\\Deleted');

    const response = await client.cmd('SEARCH UNSEEN UNDELETED');

    assert.deepEqual(response.lines, ['* SEARCH']);
  });

  test('SEARCH SUBJECT filters by subject text', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('SEARCH SUBJECT "Subject 9"');

    assert.deepEqual(response.lines, ['* SEARCH 2']);
  });

  test('UID SEARCH UID <set> restricts the result to that UID set', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('UID SEARCH UID 9:12');

    assert.deepEqual(response.lines, ['* SEARCH 9 12']);
  });

  test('an unknown search key is rejected with BAD instead of matching everything', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('SEARCH FROBNICATED');

    assert.equal(response.status, 'BAD', `${response.tagged} / ${JSON.stringify(response.lines)}`);
  });
});

// ─── APPEND ──────────────────────────────────────────────────────────────────

describe('APPEND (RFC 9051 §6.3.12)', () => {
  const MESSAGE = 'From: bob@example.test\r\nTo: alice@example.test\r\nSubject: Draft one\r\n\r\nHello Alice\r\n';

  test('APPEND answers a synchronizing literal with a continuation request', async (t) => {
    // RFC 9051 §4.3: "In the case of literals transmitted from client to server, the client MUST wait to
    // receive a command continuation request before sending the octet data".
    const { client } = await login(t);

    client.write(`A9 APPEND Sent (\\Seen) {${Buffer.byteLength(MESSAGE)}}\r\n`);
    const firstLine = await client.readLine();

    assert.match(firstLine, /^\+/, `expected a continuation request, got: ${firstLine}`);
  });

  test('APPEND stores the literal as the message content', async (t) => {
    const { client, db } = await login(t);

    client.write(`A9 APPEND Sent (\\Seen) {${Buffer.byteLength(MESSAGE)}}\r\n`);
    await client.drain(50);
    client.write(`${MESSAGE}\r\n`);
    await client.drain(100);

    const stored = db.messages.filter((m) => m.folderId === 'f-sent');
    assert.deepEqual(stored.map((m) => [m.subject, m.bodyText]), [['Draft one', 'Hello Alice\r\n']]);
  });

  test('APPEND to a missing mailbox fails with NO [TRYCREATE]', async (t) => {
    const { client } = await login(t);

    client.write('A9 APPEND Nope {5}\r\n');
    const response = await client.completion('A9');

    assert.match(response.tagged, /NO \[TRYCREATE\]/);
  });
});

// ─── IDLE / NOOP updates ─────────────────────────────────────────────────────

describe('IDLE and mailbox updates (RFC 9051 §6.3.13, §7.4.1)', () => {
  test('IDLE answers with a continuation request and DONE completes it', async (t) => {
    const { client } = await select(t);

    client.write('I1 IDLE\r\n');
    const continuation = await client.readLine();
    client.write('DONE\r\n');
    const response = await client.completion('I1');

    assert.match(continuation, /^\+ /);
    assert.equal(response.status, 'OK');
  });

  test('a message delivered during IDLE is announced with an untagged EXISTS', async (t) => {
    const { client, db, redis } = await select(t);
    client.write('I1 IDLE\r\n');
    await client.readLine();

    const delivered = db.deliver('f-inbox');
    redis.emitNewMail({ userId: 'u1', folderId: 'f-inbox', messageId: delivered.id, uid: delivered.uid, subject: 'new' });
    const update = await client.readLine();

    assert.equal(update, '* 4 EXISTS');
  });

  test('new mail in another mailbox is not announced to an idling session', async (t) => {
    const { client, redis } = await select(t);
    client.write('I1 IDLE\r\n');
    await client.readLine();

    redis.emitNewMail({ userId: 'u1', folderId: 'f-work', messageId: 'x', uid: 99, subject: 'new' });
    const lines = await client.drain();

    assert.deepEqual(lines, []);
  });

  test('NOOP announces a message that was delivered since the mailbox was selected', async (t) => {
    // RFC 9051 §6.1.2: "Since any command can return a status update as untagged data, the NOOP command can
    // be used as a periodic poll for new messages". §7.4.1: the server sends EXISTS when the size changes.
    const { client, db } = await select(t);
    db.deliver('f-inbox');

    const response = await client.cmd('NOOP');

    assert.ok(response.lines.includes('* 4 EXISTS'), JSON.stringify(response.lines));
  });

  // v8.0 review: IDLE polls and every command end used to read all rows of the folder.
  test('an unchanged mailbox is not re-read on IDLE polls and NOOP', async (t) => {
    setIdlePollInterval(20);
    t.after(() => setIdlePollInterval(30_000));
    const { client, db } = await select(t);
    await client.cmd('NOOP'); // first comparison records the stamp
    const before = db.messageReads;

    client.write('I1 IDLE\r\n');
    await client.readLine();
    await new Promise((resolve) => setTimeout(resolve, 150)); // several poll rounds
    client.write('DONE\r\n');
    await client.completion('I1');
    await client.cmd('NOOP');
    const unchangedReads = db.messageReads - before;

    db.deliver('f-inbox');
    const after = await client.cmd('NOOP');

    assert.equal(unchangedReads, 0, 'no full folder read while nothing changed');
    assert.ok(after.lines.includes('* 4 EXISTS'), JSON.stringify(after.lines));
  });

  test('withheld EXPUNGEs (FETCH) are still sent by the next NOOP', async (t) => {
    const { client, db } = await select(t);
    expungeElsewhere(db, 9);

    const fetch = await client.cmd('FETCH 1 (UID)');
    const noop = await client.cmd('NOOP');

    assert.ok(!fetch.lines.some((l) => l.endsWith('EXPUNGE')), JSON.stringify(fetch.lines));
    assert.ok(noop.lines.includes('* 2 EXPUNGE'), JSON.stringify(noop.lines));
  });
});

// ─── UID routing and input limits (added with the UID routing fix) ──────────

describe('UID EXPUNGE semantics and input limits (RFC 4315 §2.1)', () => {
  test('UID EXPUNGE removes only \\Deleted messages inside the UID set', async (t) => {
    // INBOX: UIDs 5, 9, 12 at sequence numbers 1, 2, 3.
    const { client, db } = await select(t);
    db.byUid(5).flags.push('\\Deleted');
    db.byUid(12).flags.push('\\Deleted');

    const response = await client.cmd('UID EXPUNGE 9:12');

    assert.equal(response.status, 'OK', response.tagged);
    assert.deepEqual(response.lines, ['* 3 EXPUNGE']);
    assert.deepEqual(db.messages.filter((m) => m.deletedAt !== null).map((m) => m.uid), [12]);
  });

  test('UID EXPUNGE without a UID set is rejected with BAD', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('UID EXPUNGE');

    assert.equal(response.status, 'BAD', response.tagged);
  });

  test('EXPUNGE of several messages reports decremented sequence numbers', async (t) => {
    // RFC 9051 §7.5.1: each EXPUNGE immediately renumbers the following messages.
    const { client, db } = await select(t);
    db.byUid(9).flags.push('\\Deleted');
    db.byUid(12).flags.push('\\Deleted');

    const response = await client.cmd('EXPUNGE');

    assert.deepEqual(response.lines, ['* 2 EXPUNGE', '* 2 EXPUNGE']);
  });

  test('UID STORE with a UID that does not exist changes nothing', async (t) => {
    const { client, db } = await select(t);

    const response = await client.cmd('UID STORE 2 +FLAGS (\\Flagged)');

    assert.equal(response.status, 'OK', response.tagged);
    assert.ok(!db.byUid(9).flags.includes('\\Flagged'));
    assert.deepEqual(untagged(response, / FETCH /), []);
  });

  test('an unterminated input line above 64 KiB closes the connection with BYE', async (t) => {
    const { client } = await login(t);

    client.write(`a1 NOOP ${'x'.repeat(70 * 1024)}`);
    const bye = await client.readLine();
    const closed = await client.waitForClose();

    assert.match(bye, /^\* BYE/);
    assert.equal(closed, true);
  });
});

// ─── v7.1.0 review regressions ───────────────────────────────────────────────

/** Simulates another client (or the web client) expunging a message. */
const expungeElsewhere = (db: FakeDb, uid: number): void => { db.byUid(uid).deletedAt = new Date(); };

/** Sends APPEND with a synchronizing literal (or literal8 with `~`) and returns the completion. */
async function appendRaw(client: ImapClient, mailbox: string, raw: string | Buffer, extra = '', marker = ''): Promise<Response> {
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const tag = client.nextTag();
  client.write(`${tag} APPEND ${mailbox}${extra ? ` ${extra}` : ''} ${marker}{${data.length}}\r\n`);
  const cont = await client.readLine();
  assert.match(cont, /^\+/, `expected a continuation request, got: ${cont}`);
  (client as unknown as { socket: net.Socket }).socket.write(Buffer.concat([data, Buffer.from('\r\n')]));
  return client.completion(tag);
}

describe('per-session sequence map and unsolicited updates (RFC 9051 §2.3.1.2, §5.2, §7.4.1, §7.5.1)', () => {
  test('a message expunged by another client keeps its sequence number until EXPUNGE is reported (no data loss)', async (t) => {
    // Reviewer probe P4: STORE 1 + EXPUNGE used to hit UID 9 after UID 5 was deleted elsewhere.
    const { client, db } = await select(t);
    expungeElsewhere(db, 5);

    const store = await client.cmd('STORE 1 +FLAGS (\\Deleted)');
    const expunge = await client.cmd('EXPUNGE');

    assert.equal(store.status, 'OK');
    assert.deepEqual(untagged(store, /EXPUNGE/), [], 'no EXPUNGE during STORE');
    assert.ok(!db.byUid(9).flags.includes('\\Deleted'), 'STORE 1 must not touch UID 9');
    assert.equal(db.byUid(9).deletedAt, null, 'EXPUNGE must not delete UID 9');
    assert.deepEqual(expunge.lines, ['* 1 EXPUNGE']);
  });

  test('FETCH, STORE and SEARCH never send EXPUNGE; NOOP then reports it', async (t) => {
    const { client, db } = await select(t);
    expungeElsewhere(db, 5);

    const fetch = await client.cmd('FETCH 2 (UID)');
    const search = await client.cmd('SEARCH ALL');
    const noop = await client.cmd('NOOP');
    const after = await client.cmd('FETCH 1 (UID)');

    assert.deepEqual(fetch.lines, ['* 2 FETCH (UID 9)'], 'sequence number 2 is still UID 9');
    assert.deepEqual(untagged(search, /EXPUNGE/), []);
    assert.deepEqual(search.lines, ['* SEARCH 2 3']);
    assert.deepEqual(noop.lines, ['* 1 EXPUNGE']);
    assert.deepEqual(after.lines, ['* 1 FETCH (UID 9)'], 'renumbered only after the EXPUNGE response');
  });

  test('UID FETCH may report the expunge at its end', async (t) => {
    const { client, db } = await select(t);
    expungeElsewhere(db, 12);

    const response = await client.cmd('UID FETCH 1:* (FLAGS)');

    assert.deepEqual(response.lines.slice(-1), ['* 3 EXPUNGE']);
  });

  test('a delivered message is announced with EXISTS before it can be addressed', async (t) => {
    // Reviewer probe P4b: "* 4 FETCH" was sent without "* 4 EXISTS".
    const { client, db } = await select(t);
    db.deliver('f-inbox');

    const fetch = await client.cmd('FETCH 1:* (UID)');
    const again = await client.cmd('FETCH 4 (UID)');

    assert.deepEqual(fetch.lines, ['* 1 FETCH (UID 5)', '* 2 FETCH (UID 9)', '* 3 FETCH (UID 12)', '* 4 EXISTS']);
    assert.deepEqual(again.lines, ['* 4 FETCH (UID 13)']);
  });

  test('a flag change by another client is reported with an unsolicited FETCH including UID', async (t) => {
    const { client, db } = await select(t);
    db.byUid(9).flags.push('\\Flagged');
    db.byUid(9).modSeq = 11n; db.mailbox.highestModSeq = 11n;

    const response = await client.cmd('NOOP');

    assert.deepEqual(response.lines, ['* 2 FETCH (UID 9 FLAGS (\\Seen \\Flagged))']);
  });

  test('an expunge by another client is pushed while idling', async (t) => {
    setIdlePollInterval(40);
    t.after(() => setIdlePollInterval(30_000));
    const { client, db } = await select(t);
    client.write('I1 IDLE\r\n');
    await client.readLine();

    expungeElsewhere(db, 9);
    const update = await client.readLine();
    client.write('DONE\r\n');
    const done = await client.completion('I1');

    assert.equal(update, '* 2 EXPUNGE');
    assert.equal(done.status, 'OK');
  });

  test('new mail during IDLE is announced with EXISTS only (no RECENT)', async (t) => {
    const { client, db, redis } = await select(t);
    client.write('I1 IDLE\r\n');
    await client.readLine();

    const delivered = db.deliver('f-inbox');
    redis.emitNewMail({ userId: 'u1', folderId: 'f-inbox', messageId: delivered.id, uid: delivered.uid, subject: 'new' });
    const lines = await client.drain(200);

    assert.deepEqual(lines, ['* 4 EXISTS']);
  });

  test('a failed SELECT leaves no mailbox selected', async (t) => {
    const { client } = await select(t);

    await client.cmd('SELECT Nope');
    const fetch = await client.cmd('FETCH 1 (UID)');

    assert.notEqual(fetch.status, 'OK');
  });
});

describe('EXAMINE is read-only (RFC 9051 §6.3.3, RFC 6851 §3.3)', () => {
  test('EXPUNGE and UID EXPUNGE are refused and remove nothing', async (t) => {
    const { client, db } = await select(t, 'INBOX', 'EXAMINE');
    db.byUid(5).flags.push('\\Deleted');

    const expunge = await client.cmd('EXPUNGE');
    const uidExpunge = await client.cmd('UID EXPUNGE 5');

    assert.match(expunge.tagged, /NO \[READ-ONLY\]/);
    assert.match(uidExpunge.tagged, /NO \[READ-ONLY\]/);
    assert.equal(db.byUid(5).deletedAt, null);
  });

  test('MOVE is refused and the message stays', async (t) => {
    const { client, db } = await select(t, 'INBOX', 'EXAMINE');

    const response = await client.cmd('UID MOVE 9 Work');

    assert.match(response.tagged, /NO \[READ-ONLY\]/);
    assert.equal(db.byUid(9).folderId, 'f-inbox');
  });
});

describe('CONDSTORE (RFC 7162)', () => {
  test('STORE UNCHANGEDSINCE stores where possible and reports the rest as MODIFIED', async (t) => {
    const { client, db } = await select(t);
    db.byUid(9).modSeq = 20n; db.mailbox.highestModSeq = 20n;

    const response = await client.cmd('STORE 1:3 (UNCHANGEDSINCE 15) +FLAGS (\\Flagged)');

    assert.match(response.tagged, /^A\d+ OK \[MODIFIED 2\]/);
    assert.ok(db.byUid(5).flags.includes('\\Flagged') && db.byUid(12).flags.includes('\\Flagged'));
    assert.ok(!db.byUid(9).flags.includes('\\Flagged'));
    assert.equal(untagged(response, /^\* [13] FETCH \(FLAGS .* MODSEQ \(\d+\)\)$/).length, 2, JSON.stringify(response.lines));
  });

  test('UID STORE UNCHANGEDSINCE reports UIDs in MODIFIED', async (t) => {
    const { client, db } = await select(t);
    db.byUid(9).modSeq = 20n; db.mailbox.highestModSeq = 20n;

    const response = await client.cmd('UID STORE 9 (UNCHANGEDSINCE 15) +FLAGS (\\Flagged)');

    assert.match(response.tagged, /OK \[MODIFIED 9\]/);
  });

  test('SEARCH MODSEQ ends with the highest MODSEQ of the result', async (t) => {
    const { client, db } = await select(t);
    db.byUid(12).modSeq = 42n; db.mailbox.highestModSeq = 42n;

    const search = await client.cmd('SEARCH MODSEQ 1');
    const esearch = await client.cmd('SEARCH RETURN (ALL) MODSEQ 1');

    // (The modSeq change of UID 12 is also reported as an unsolicited FETCH after the result.)
    assert.equal(search.lines[0], '* SEARCH 1 2 3 (MODSEQ 42)');
    assert.match(esearch.lines[0] ?? '', /^\* ESEARCH \(TAG "A\d+"\) ALL 1:3 MODSEQ 42$/);
  });

  test('SELECT … (CONDSTORE) enables MODSEQ in FETCH responses', async (t) => {
    const { client } = await login(t);
    await client.cmd('SELECT INBOX (CONDSTORE)');

    const response = await client.cmd('FETCH 1 (FLAGS)');

    assert.match(response.lines[0] ?? '', /MODSEQ \(10\)/);
  });

  test('FETCH MODSEQ is a CONDSTORE-enabling command', async (t) => {
    const { client } = await select(t);
    await client.cmd('FETCH 1 (MODSEQ)');

    const response = await client.cmd('FETCH 1 (FLAGS)');

    assert.match(response.lines[0] ?? '', /MODSEQ \(10\)/);
  });
});

describe('mailbox names (RFC 9051 §5.1, RFC 3501 §5.1.3)', () => {
  test('INBOX is case-insensitive in SELECT, STATUS, APPEND, COPY and MOVE', async (t) => {
    const { client, db } = await login(t);

    const status = await client.cmd('STATUS inbox (MESSAGES)');
    const append = await appendRaw(client, 'Inbox', 'Subject: x\r\n\r\nbody\r\n');
    const selectWork = await client.cmd('SELECT Work');
    const copy = await client.cmd('COPY 1 inBox');
    const move = await client.cmd('MOVE 2 INBOX');
    const select = await client.cmd('SELECT inbox');

    assert.deepEqual(status.lines, ['* STATUS "INBOX" (MESSAGES 3)']);
    assert.equal(append.status, 'OK', append.tagged);
    assert.equal(selectWork.status, 'OK');
    assert.equal(copy.status, 'OK', copy.tagged);
    assert.equal(move.status, 'OK', move.tagged);
    assert.equal(select.status, 'OK', select.tagged);
    assert.ok(select.lines.includes('* 6 EXISTS'), JSON.stringify(select.lines));
    assert.equal(db.messages.filter((m) => m.folderId === 'f-inbox' && m.deletedAt === null).length, 6);
  });

  test('non-ASCII names are sent and accepted in modified UTF-7', async (t) => {
    const { client, db } = await login(t);
    db.folders.push({ id: 'f-de', mailboxId: 'mb1', name: 'Entwürfe', displayName: 'Entwürfe' });

    const list = await client.cmd('LIST "" "Entw*"');
    const select = await client.cmd('SELECT "Entw&APw-rfe"');
    const create = await client.cmd('CREATE "Caf&AOk-"');

    assert.deepEqual(untagged(list, /^\* LIST /), ['* LIST (\\HasNoChildren \\Drafts) "." "Entw&APw-rfe"']);
    assert.equal(select.status, 'OK', select.tagged);
    assert.equal(create.status, 'OK');
    assert.ok(db.folders.some((f) => f.name === 'Café'), db.folders.map((f) => f.name).join(','));
  });

  test('after ENABLE IMAP4rev2 names are UTF-8', async (t) => {
    const { client, db } = await login(t);
    db.folders.push({ id: 'f-de', mailboxId: 'mb1', name: 'Entwürfe', displayName: 'Entwürfe' });
    await client.cmd('ENABLE IMAP4rev2');

    const list = await client.cmd('LIST "" "Entw*"');
    const select = await client.cmd('SELECT "Entwürfe"');

    assert.match(list.raw, /\* LIST \(\\HasNoChildren \\Drafts\) "\." \{9\}\r\nEntwürfe/);
    assert.equal(select.status, 'OK', select.tagged);
  });

  test('quotes inside a mailbox name are kept (no second unquoting)', async (t) => {
    const { client, db } = await login(t);

    await client.cmd(`CREATE "'Old'"`);

    assert.ok(db.folders.some((f) => f.name === "'Old'"), db.folders.map((f) => f.name).join(','));
  });

  test('RENAME of a mailbox with inferiors renames them as well', async (t) => {
    const { client, db } = await login(t);

    const response = await client.cmd('RENAME Archive Old');

    assert.equal(response.status, 'OK');
    assert.deepEqual(db.folders.map((f) => f.name).filter((n) => n.startsWith('Old') || n.startsWith('Archive')).sort(), ['Old', 'Old.2025']);
  });

  // v8.0 review: up to 7.0.0, CREATE stored non-ASCII names as the client sent them
  // (modified UTF-7). Such rows are not migrated: they keep their stored name and
  // look exactly as before to rev1 clients.
  test('a legacy folder stored in modified UTF-7 keeps its name for rev1 clients and is reachable', async (t) => {
    const { client, db } = await login(t);
    db.folders.push({ id: 'f-legacy', mailboxId: 'mb1', name: 'Entw&APw-rfe', displayName: 'Entw&APw-rfe' });
    db.folders.push({ id: 'f-legacy-sub', mailboxId: 'mb1', name: 'Entw&APw-rfe.Alt', displayName: 'Entw&APw-rfe.Alt' });

    const list = await client.cmd('LIST "" "Entw*"');
    const status = await client.cmd('STATUS "Entw&APw-rfe" (MESSAGES)');
    const select = await client.cmd('SELECT "Entw&APw-rfe"');
    const create = await client.cmd('CREATE "Entw&APw-rfe"');
    const append = await appendRaw(client, 'Entw&APw-rfe', 'Subject: x\r\n\r\nbody\r\n');

    assert.deepEqual(untagged(list, /^\* LIST /), [
      '* LIST (\\HasChildren \\Drafts) "." "Entw&APw-rfe"',
      '* LIST (\\HasNoChildren) "." "Entw&APw-rfe.Alt"',
    ]);
    assert.deepEqual(status.lines, ['* STATUS "Entw&APw-rfe" (MESSAGES 0)']);
    assert.equal(select.status, 'OK', select.tagged);
    assert.match(create.tagged, /NO \[ALREADYEXISTS\]/, 'no duplicate "Entwürfe" next to the legacy row');
    assert.equal(append.status, 'OK', append.tagged);
    assert.ok(db.messages.some((m) => m.folderId === 'f-legacy'));
    assert.deepEqual(db.folders.filter((f) => f.id.startsWith('f-legacy')).map((f) => f.name), ['Entw&APw-rfe', 'Entw&APw-rfe.Alt'],
      'stored names are never rewritten');
  });

  test('a legacy modified UTF-7 folder is shown in UTF-8 after ENABLE IMAP4rev2', async (t) => {
    const { client, db } = await login(t);
    db.folders.push({ id: 'f-legacy', mailboxId: 'mb1', name: 'Entw&APw-rfe', displayName: 'Entw&APw-rfe' });
    await client.cmd('ENABLE IMAP4rev2');

    const list = await client.cmd('LIST "" "Entw*"');
    const select = await client.cmd('SELECT "Entwürfe"');

    assert.match(list.raw, /\* LIST \(\\HasNoChildren \\Drafts\) "\." \{9\}\r\nEntwürfe/);
    assert.equal(select.status, 'OK', select.tagged);
  });

  test('RENAME of a legacy modified UTF-7 folder renames it and its inferiors', async (t) => {
    const { client, db } = await login(t);
    db.folders.push({ id: 'f-legacy', mailboxId: 'mb1', name: 'Entw&APw-rfe', displayName: 'Entw&APw-rfe' });
    db.folders.push({ id: 'f-legacy-sub', mailboxId: 'mb1', name: 'Entw&APw-rfe.Alt', displayName: 'Entw&APw-rfe.Alt' });

    const response = await client.cmd('RENAME "Entw&APw-rfe" "Caf&AOk-"');

    assert.equal(response.status, 'OK', response.tagged);
    assert.deepEqual(db.folders.filter((f) => f.id.startsWith('f-legacy')).map((f) => f.name), ['Café', 'Café.Alt']);
  });

  test('an over-long LIST pattern is refused; a backtracking pattern answers quickly', async (t) => {
    const { client, db } = await login(t);
    await client.cmd(`CREATE ${'a'.repeat(40)}`);
    assert.ok(db.folders.some((f) => f.name === 'a'.repeat(40)));

    const started = Date.now();
    const evil = await client.cmd(`LIST "" "${'*a'.repeat(20)}X"`);
    const elapsed = Date.now() - started;
    const tooLong = await client.cmd(`LIST "" "${'*'.repeat(1100)}"`);

    assert.equal(evil.status, 'OK');
    assert.deepEqual(untagged(evil, /^\* LIST /), []);
    assert.ok(elapsed < 2000, `LIST took ${elapsed} ms`);
    assert.equal(tooLong.status, 'BAD');
  });
});

describe('IMAP4rev2 after ENABLE IMAP4rev2 (RFC 9051 Appendix E)', () => {
  async function rev2(t: TestContext): Promise<Harness> {
    const harness = await login(t);
    await harness.client.cmd('ENABLE IMAP4rev2');
    return harness;
  }

  test('SELECT sends a LIST response and neither RECENT nor UNSEEN', async (t) => {
    const { client } = await rev2(t);

    const response = await client.cmd('SELECT INBOX');

    assert.ok(response.lines.includes('* LIST () "." "INBOX"'), JSON.stringify(response.lines));
    assert.deepEqual(untagged(response, /RECENT|UNSEEN/), []);
  });

  test('SELECT while a mailbox is selected reports [CLOSED]', async (t) => {
    const { client } = await rev2(t);
    await client.cmd('SELECT INBOX');

    const response = await client.cmd('SELECT Work');

    assert.equal(response.lines[0], '* OK [CLOSED] Previous mailbox closed');
  });

  test('SEARCH is answered with ESEARCH', async (t) => {
    const { client } = await rev2(t);
    await client.cmd('SELECT INBOX');

    const search = await client.cmd('SEARCH UNSEEN');
    const uidSearch = await client.cmd('UID SEARCH ALL');

    assert.match(search.lines[0] ?? '', /^\* ESEARCH \(TAG "A\d+"\) ALL 3$/);
    assert.match(uidSearch.lines[0] ?? '', /^\* ESEARCH \(TAG "A\d+"\) UID ALL 5,9,12$/);
  });
});

describe('BINARY (RFC 3516)', () => {
  const B64 = 'From: a@example.test\r\nSubject: bin\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8gQklOQVJZ\r\n';
  const NUL = 'From: a@example.test\r\nSubject: nul\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC\r\n';
  const QP = 'From: a@example.test\r\nSubject: qp\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nGr=C3=BC=\r\n=C3=9Fe\r\n';

  test('BINARY.PEEK[1] returns the decoded part and BINARY.SIZE its decoded size', async (t) => {
    const { client } = await select(t);
    await appendRaw(client, 'INBOX', B64);
    await client.cmd('NOOP');

    const response = await client.cmd('FETCH 4 (BINARY.PEEK[1] BINARY.SIZE[1])');

    assert.match(response.raw, /BINARY\[1\] \{12\}\r\nHello BINARY BINARY\.SIZE\[1\] 12\)/);
  });

  test('quoted-printable is decoded', async (t) => {
    const { client } = await select(t);
    await appendRaw(client, 'INBOX', QP);
    await client.cmd('NOOP');

    const response = await client.cmd('FETCH 4 (BINARY.PEEK[1])');

    // "Gr=C3=BC=<CRLF>=C3=9Fe<CRLF>": soft line break removed, the final line break kept.
    assert.match(response.raw, /BINARY\[1\] \{9\}\r\nGrüße\r\n\)/);
  });

  test('data with NUL is sent as literal8', async (t) => {
    const { client } = await select(t);
    await appendRaw(client, 'INBOX', NUL);
    await client.cmd('NOOP');

    const response = await client.cmd('FETCH 4 (BINARY.PEEK[1])');

    assert.match(response.raw, /BINARY\[1\] ~\{3\}\r\n\u0000\u0001\u0002\)/);
  });

  test('APPEND accepts a literal8', async (t) => {
    const { client, db } = await login(t);

    const response = await appendRaw(client, 'Sent', 'Subject: eight\r\n\r\nx\u0000y\r\n', '', '~');

    assert.equal(response.status, 'OK', response.tagged);
    assert.ok(db.messages.some((m) => m.folderId === 'f-sent' && m.subject === 'eight'));
  });

  test('BINARY without .PEEK sets \\Seen', async (t) => {
    const { client, db } = await select(t);

    await client.cmd('FETCH 3 (BINARY[1])');

    assert.ok(db.byUid(12).flags.includes('\\Seen'));
  });
});

describe('SEARCHRES (RFC 5182)', () => {
  test('RETURN (SAVE) sends no ESEARCH and "$" addresses the saved messages', async (t) => {
    const { client } = await select(t);

    const save = await client.cmd('SEARCH RETURN (SAVE) UNSEEN');
    const fetch = await client.cmd('FETCH $ (UID)');
    const uidSearch = await client.cmd('UID SEARCH $');

    assert.deepEqual(save.lines, []);
    assert.deepEqual(fetch.lines, ['* 3 FETCH (UID 12)']);
    assert.deepEqual(uidSearch.lines, ['* SEARCH 12']);
  });

  test('SAVE with MIN saves only the minimum', async (t) => {
    const { client } = await select(t);

    const save = await client.cmd('UID SEARCH RETURN (SAVE MIN) ALL');
    const fetch = await client.cmd('UID FETCH $ (FLAGS)');

    assert.match(save.lines[0] ?? '', /^\* ESEARCH \(TAG "A\d+"\) UID MIN 5$/);
    assert.equal(untagged(fetch, / FETCH /).length, 1);
    assert.match(fetch.lines[0] ?? '', /^\* 1 FETCH \(UID 5 /);
  });
});

describe('LIST-EXTENDED (RFC 5258), LIST-STATUS (RFC 5819), QUOTA (RFC 9208)', () => {
  test('LIST (SUBSCRIBED) returns every mailbox with \\Subscribed', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('LIST (SUBSCRIBED) "" "*"');

    const lines = untagged(response, /^\* LIST /);
    assert.equal(lines.length, 5);
    assert.ok(lines.every((l) => l.includes('\\Subscribed')), JSON.stringify(lines));
  });

  test('LIST (SPECIAL-USE) returns only special-use mailboxes', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('LIST (SPECIAL-USE) "" "*"');

    assert.deepEqual(untagged(response, /^\* LIST /).map((l) => /"\." "([^"]+)"$/.exec(l)?.[1]), ['Archive', 'Sent']);
  });

  test('LIST with several patterns', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('LIST "" ("INBOX" "Work")');

    assert.equal(untagged(response, /^\* LIST /).length, 2);
  });

  test('LIST … RETURN (STATUS (MESSAGES UNSEEN)) follows each LIST with STATUS', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('LIST "" "INBOX" RETURN (STATUS (MESSAGES UNSEEN))');

    assert.deepEqual(response.lines, ['* LIST (\\HasNoChildren) "." "INBOX"', '* STATUS "INBOX" (MESSAGES 3 UNSEEN 1)']);
  });

  test('"%" lists a parent that only exists implicitly', async (t) => {
    const { client, db } = await login(t);
    db.folders.push({ id: 'f-deep', mailboxId: 'mb1', name: 'Projects.2026', displayName: '2026' });

    const response = await client.cmd('LIST "" "%"');

    assert.ok(response.lines.includes('* LIST (\\Noselect \\HasChildren) "." "Projects"'), JSON.stringify(response.lines));
  });

  test('GETQUOTAROOT reports the STORAGE usage and limit', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('GETQUOTAROOT INBOX');

    assert.deepEqual(response.lines, ['* QUOTAROOT "INBOX" ""', '* QUOTA "" (STORAGE 5 1024)']);
  });
});

describe('state checks, flags, APPEND date and HEADER search', () => {
  test('LOGIN in the authenticated or selected state is rejected and keeps the selection', async (t) => {
    const { client } = await select(t);

    const relogin = await client.cmd('LOGIN bob@example.test secret');
    const fetch = await client.cmd('FETCH 1 (UID)');

    assert.equal(relogin.status, 'BAD');
    assert.equal(fetch.status, 'OK');
  });

  test('ENABLE before authentication is rejected', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('ENABLE CONDSTORE');

    assert.equal(response.status, 'BAD');
    assert.deepEqual(response.lines, []);
  });

  test('system flags are case-insensitive and \\Recent cannot be set', async (t) => {
    const { client, db } = await select(t);

    await client.cmd('STORE 3 +FLAGS (\\seen)');
    const status = await client.cmd('STATUS INBOX (UNSEEN)');
    const removed = await client.cmd('STORE 1 -FLAGS (\\SEEN)');
    const recent = await client.cmd('STORE 2 +FLAGS (\\Recent)');

    assert.deepEqual(db.byUid(12).flags, ['\\Seen']);
    assert.match(status.lines.join('\n'), /UNSEEN 0/);
    assert.equal(removed.status, 'OK');
    assert.deepEqual(db.byUid(5).flags, []);
    assert.equal(recent.status, 'BAD');
    assert.deepEqual(db.byUid(9).flags, ['\\Seen']);
  });

  test('the APPEND date-time becomes the internal date', async (t) => {
    const { client, db } = await login(t);

    const ok = await appendRaw(client, 'Sent', 'Subject: dated\r\n\r\nx\r\n', '(\\Seen) "03-Feb-2026 10:20:30 +0100"');
    const bad = await client.cmd('APPEND Sent "yesterday" {1+}\r\nx');

    assert.equal(ok.status, 'OK', ok.tagged);
    const stored = db.messages.find((m) => m.subject === 'dated');
    assert.equal(stored?.createdAt.toISOString(), '2026-02-03T09:20:30.000Z');
    assert.equal(bad.status, 'BAD');
  });

  test('SEARCH HEADER matches any header field, "" every message that has it', async (t) => {
    const { client } = await select(t);
    await appendRaw(client, 'INBOX', 'Subject: prio\r\nX-Priority: 1 (Highest)\r\n\r\nx\r\n');
    await client.cmd('NOOP');

    const value = await client.cmd('SEARCH HEADER X-Priority 1');
    const exists = await client.cmd('SEARCH HEADER X-Priority ""');
    const missing = await client.cmd('SEARCH HEADER X-Mailer ""');

    assert.deepEqual(value.lines, ['* SEARCH 4']);
    assert.deepEqual(exists.lines, ['* SEARCH 4']);
    assert.deepEqual(missing.lines, ['* SEARCH']);
  });

  test('SEARCH RECENT matches nothing (SELECT reports 0 RECENT)', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('SEARCH RECENT');

    assert.deepEqual(response.lines, ['* SEARCH']);
  });
});

describe('SASL (RFC 9051 §6.2.2, RFC 4616)', () => {
  test('a response that is not base64 is answered with BAD', async (t) => {
    const { client } = await connect(t);

    const initial = await client.cmd('AUTHENTICATE PLAIN !!!notbase64');
    client.write('A9 AUTHENTICATE PLAIN\r\n');
    await client.readLine();
    client.write('%%%\r\n');
    const continuation = await client.completion('A9');

    assert.equal(initial.status, 'BAD');
    assert.equal(continuation.status, 'BAD');
  });

  test('an authorization identity other than the login is refused', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd(`AUTHENTICATE PLAIN ${b64('alice@example.test\u0000bob@example.test\u0000secret')}`);
    const same = await client.cmd(`AUTHENTICATE PLAIN ${b64('bob@example.test\u0000bob@example.test\u0000secret')}`);

    assert.match(response.tagged, /NO \[AUTHORIZATIONFAILED\]/);
    assert.equal(same.status, 'OK', same.tagged);
  });
});

// ─── QRESYNC (RFC 7162 §3.2) ─────────────────────────────────────────────────

/** Another client expunges a message: tombstone with a fresh modSeq. */
function tombstone(db: FakeDb, uid: number): void {
  const m = db.byUid(uid);
  db.mailbox.highestModSeq++;
  m.deletedAt = new Date();
  m.modSeq = db.mailbox.highestModSeq;
}

/** Another client changes flags. */
function flagElsewhere(db: FakeDb, uid: number, flag: string): void {
  const m = db.byUid(uid);
  db.mailbox.highestModSeq++;
  m.flags.push(flag);
  m.modSeq = db.mailbox.highestModSeq;
}

describe('QRESYNC (RFC 7162 §3.2)', () => {
  test('ENABLE QRESYNC is confirmed and implies CONDSTORE (MODSEQ in FETCH)', async (t) => {
    const { client } = await login(t);

    const enable = await client.cmd('ENABLE QRESYNC');
    await client.cmd('SELECT INBOX');
    const fetch = await client.cmd('FETCH 1 (FLAGS)');

    assert.deepEqual(enable.lines, ['* ENABLED QRESYNC']);
    assert.match(fetch.lines[0] ?? '', /MODSEQ \(10\)/);
  });

  test('SELECT … (QRESYNC …) without ENABLE QRESYNC is a BAD command', async (t) => {
    const { client } = await login(t);

    const response = await client.cmd('SELECT INBOX (QRESYNC (777 10))');

    assert.equal(response.status, 'BAD');
  });

  test('malformed QRESYNC parameters are rejected with BAD', async (t) => {
    const { client } = await login(t);
    await client.cmd('ENABLE QRESYNC');

    for (const params of ['(QRESYNC)', '(QRESYNC (0 10))', '(QRESYNC (777 x))', '(QRESYNC (777 10 1:x))', '(QRESYNC (777 10 1:5 (1:2)))', '(FOO)']) {
      const response = await client.cmd(`SELECT INBOX ${params}`);
      assert.equal(response.status, 'BAD', params);
    }
  });

  test('Thunderbird/iOS resync: VANISHED (EARLIER) for known UIDs, FETCH for changes since the modseq', async (t) => {
    const { client, db } = await login(t);
    tombstone(db, 9);              // modSeq 11
    flagElsewhere(db, 12, '\\Flagged');   // modSeq 12
    const fresh = db.deliver('f-inbox');  // UID 13, modSeq 13
    fresh.modSeq = 13n;
    await client.cmd('ENABLE QRESYNC');

    const response = await client.cmd('SELECT INBOX (QRESYNC (777 10 5,9,12))');

    assert.equal(response.status, 'OK', response.tagged);
    assert.deepEqual(untagged(response, /^\* VANISHED/), ['* VANISHED (EARLIER) 9']);
    assert.deepEqual(untagged(response, / FETCH /), [
      '* 2 FETCH (UID 12 FLAGS (\\Flagged) MODSEQ (12))',
      '* 3 FETCH (UID 13 FLAGS () MODSEQ (13))',
    ]);
    // The resync data follows the standard SELECT responses.
    const at = (l: string): number => response.lines.indexOf(l);
    assert.ok(at('* VANISHED (EARLIER) 9') > response.lines.findIndex((l) => l.includes('[HIGHESTMODSEQ')));
    assert.ok(at('* VANISHED (EARLIER) 9') < at('* 2 FETCH (UID 12 FLAGS (\\Flagged) MODSEQ (12))'));
  });

  test('without known UIDs every missing UID below UIDNEXT is reported, minus tombstones the client already knew', async (t) => {
    const { client, db } = await login(t);
    tombstone(db, 9); // modSeq 11
    await client.cmd('ENABLE QRESYNC');

    const fromTen = await client.cmd('SELECT INBOX (QRESYNC (777 10))');
    const fromEleven = await client.cmd('EXAMINE INBOX (QRESYNC (777 11))');

    // Live UIDs: 5, 12; UIDNEXT 13.
    assert.deepEqual(untagged(fromTen, /^\* VANISHED/), ['* VANISHED (EARLIER) 1:4,6:11']);
    // UID 9 vanished at modSeq 11 — a client at 11 already knows.
    assert.deepEqual(untagged(fromEleven, /^\* VANISHED/), ['* VANISHED (EARLIER) 1:4,6:8,10:11']);
    // Switching mailboxes reports CLOSED (RFC 7162 §3.2.11).
    assert.equal(fromEleven.lines[0], '* OK [CLOSED] Previous mailbox closed');
  });

  test('a UIDVALIDITY mismatch suppresses the resync data', async (t) => {
    const { client, db } = await login(t);
    tombstone(db, 9);
    await client.cmd('ENABLE QRESYNC');

    const response = await client.cmd('SELECT INBOX (QRESYNC (1 1 1:20))');

    assert.equal(response.status, 'OK');
    assert.deepEqual(untagged(response, /VANISHED| FETCH /), []);
  });

  test('EXPUNGE reports VANISHED instead of EXPUNGE and carries HIGHESTMODSEQ', async (t) => {
    const { client, db } = await login(t);
    await client.cmd('ENABLE QRESYNC');
    await client.cmd('SELECT INBOX');
    await client.cmd('STORE 1:2 +FLAGS.SILENT (\\Deleted)');

    const response = await client.cmd('EXPUNGE');

    assert.deepEqual(untagged(response, /EXPUNGE|VANISHED/), ['* VANISHED 5,9']);
    assert.match(response.tagged, new RegExp(`OK \\[HIGHESTMODSEQ ${db.mailbox.highestModSeq}\\] EXPUNGE completed`));
  });

  test('expunges by another client arrive as unsolicited VANISHED', async (t) => {
    const { client, db } = await login(t);
    await client.cmd('ENABLE QRESYNC');
    await client.cmd('SELECT INBOX');
    tombstone(db, 5);
    tombstone(db, 12);

    const noop = await client.cmd('NOOP');

    assert.deepEqual(untagged(noop, /EXPUNGE|VANISHED/), ['* VANISHED 5,12']);
  });

  test('MOVE reports the moved messages with VANISHED', async (t) => {
    const { client } = await login(t);
    await client.cmd('ENABLE QRESYNC');
    await client.cmd('SELECT INBOX');

    const response = await client.cmd('UID MOVE 9 Archive');

    assert.deepEqual(untagged(response, /EXPUNGE|VANISHED/), ['* VANISHED 9']);
    assert.match(response.tagged, /OK \[HIGHESTMODSEQ \d+\] MOVE completed/);
  });

  test('UID FETCH … (CHANGEDSINCE m VANISHED) reports vanished UIDs of the set first', async (t) => {
    const { client, db } = await login(t);
    await client.cmd('ENABLE QRESYNC');
    await client.cmd('SELECT INBOX');
    tombstone(db, 9);              // 11
    flagElsewhere(db, 12, '\\Answered');  // 12

    const response = await client.cmd('UID FETCH 5:12 (FLAGS) (CHANGEDSINCE 10 VANISHED)');

    assert.equal(response.status, 'OK', response.tagged);
    // 6:8, 10:11 never existed in this folder — reporting them is allowed and harmless.
    assert.equal(response.lines[0], '* VANISHED (EARLIER) 6:11');
    assert.ok(response.lines.includes('* 3 FETCH (UID 12 FLAGS (\\Answered) MODSEQ (12))'), JSON.stringify(response.lines));
    assert.equal(untagged(response, /UID 5 /).length, 0, 'unchanged message must not be fetched');
    // UID FETCH may also deliver the pending expunge of the session's view.
    assert.ok(response.lines.includes('* VANISHED 9'));
  });

  test('the VANISHED modifier needs QRESYNC, UID FETCH and CHANGEDSINCE', async (t) => {
    const { client } = await login(t);
    await client.cmd('SELECT INBOX');

    const notEnabled = await client.cmd('UID FETCH 1:* (FLAGS) (CHANGEDSINCE 1 VANISHED)');
    await client.cmd('ENABLE QRESYNC');
    const notUid = await client.cmd('FETCH 1:* (FLAGS) (CHANGEDSINCE 1 VANISHED)');
    const noSince = await client.cmd('UID FETCH 1:* (FLAGS) (VANISHED)');
    const unknown = await client.cmd('UID FETCH 1:* (FLAGS) (CHANGEDSINCE 1 FOO)');

    for (const r of [notEnabled, notUid, noSince, unknown]) assert.equal(r.status, 'BAD', r.tagged);
  });

  test('Thunderbird CONDSTORE flow: SELECT (CONDSTORE), UID FETCH 1:* (FLAGS) (CHANGEDSINCE m)', async (t) => {
    const { client, db } = await login(t);

    const selectResponse = await client.cmd('SELECT "INBOX" (CONDSTORE)');
    flagElsewhere(db, 9, '\\Flagged');
    const fetch = await client.cmd('UID FETCH 1:* (FLAGS) (CHANGEDSINCE 10)');

    assert.equal(untagged(selectResponse, /\[HIGHESTMODSEQ 10\]/).length, 1);
    // Reported once, by the FETCH itself (not again as an unsolicited update).
    assert.deepEqual(untagged(fetch, / FETCH /), ['* 2 FETCH (UID 9 FLAGS (\\Seen \\Flagged) MODSEQ (11))']);
  });

  test('SELECT while a mailbox is selected reports [CLOSED] also without IMAP4rev2', async (t) => {
    const { client } = await select(t);

    const response = await client.cmd('SELECT Work');

    assert.equal(response.lines[0], '* OK [CLOSED] Previous mailbox closed');
  });

  test('QRESYNC, SORT, THREAD and ACL are advertised; COMPRESS only after login', async (t) => {
    const { client } = await connect(t);

    const before = capabilitiesOf((await client.cmd('CAPABILITY')).lines[0] ?? '');
    const loginResponse = await client.cmd('LOGIN bob@example.test secret');
    const after = capabilitiesOf(loginResponse.tagged);

    for (const cap of ['QRESYNC', 'SORT', 'THREAD=ORDEREDSUBJECT', 'THREAD=REFERENCES', 'ACL', 'RIGHTS=texk']) {
      assert.ok(before.includes(cap), `${cap} missing`);
    }
    assert.ok(!before.includes('COMPRESS=DEFLATE'));
    assert.ok(after.includes('COMPRESS=DEFLATE'), after.join(' '));
  });
});

// ─── SORT / THREAD (RFC 5256) ────────────────────────────────────────────────

describe('SORT and THREAD (RFC 5256)', () => {
  /** INBOX: seq 1 = UID 5, seq 2 = UID 9, seq 3 = UID 12. */
  function threadFixture(db: FakeDb): void {
    Object.assign(db.byUid(5), { subject: 'Plan', messageId: '<a@x>', date: new Date('2026-02-01T00:00:00Z'), fromAddr: 'zoe@example.test', rawSize: 300 });
    Object.assign(db.byUid(9), { subject: 'Re: plan', messageId: '<b@x>', inReplyTo: '<a@x>', date: new Date('2026-02-03T00:00:00Z'), fromAddr: 'adam@example.test', rawSize: 100 });
    Object.assign(db.byUid(12), { subject: 'Budget', messageId: '<c@x>', date: new Date('2026-02-02T00:00:00Z'), fromAddr: 'mia@example.test', rawSize: 200 });
  }

  test('SORT returns sequence numbers, UID SORT returns UIDs', async (t) => {
    const { client, db } = await select(t);
    threadFixture(db);

    const bySubject = await client.cmd('SORT (SUBJECT) UTF-8 ALL');
    const byDate = await client.cmd('UID SORT (REVERSE DATE) US-ASCII ALL');
    const byFrom = await client.cmd('SORT (FROM) utf-8 ALL');

    assert.deepEqual(bySubject.lines, ['* SORT 3 1 2']);
    assert.deepEqual(byDate.lines, ['* SORT 9 12 5']);
    assert.deepEqual(byFrom.lines, ['* SORT 2 3 1']);
  });

  test('SORT applies the search criteria', async (t) => {
    const { client, db } = await select(t);
    threadFixture(db);

    const response = await client.cmd('UID SORT (SIZE) UTF-8 SEEN');

    assert.deepEqual(response.lines, ['* SORT 9 5']);
  });

  test('SORT with a MODSEQ criterion reports the highest MODSEQ', async (t) => {
    const { client, db } = await select(t);
    flagElsewhere(db, 12, '\\Flagged');
    await client.cmd('NOOP');

    const response = await client.cmd('SORT (ARRIVAL) UTF-8 MODSEQ 11');

    assert.deepEqual(response.lines, ['* SORT 3 (MODSEQ 11)']);
  });

  test('THREAD REFERENCES and ORDEREDSUBJECT', async (t) => {
    const { client, db } = await select(t);
    threadFixture(db);

    const refs = await client.cmd('THREAD REFERENCES UTF-8 ALL');
    const uidRefs = await client.cmd('UID THREAD REFERENCES UTF-8 ALL');
    const ordered = await client.cmd('UID THREAD ORDEREDSUBJECT UTF-8 ALL');
    const none = await client.cmd('THREAD REFERENCES UTF-8 SUBJECT nothing-matches');

    assert.deepEqual(refs.lines, ['* THREAD (1 2)(3)']);
    assert.deepEqual(uidRefs.lines, ['* THREAD (5 9)(12)']);
    assert.deepEqual(ordered.lines, ['* THREAD (5 9)(12)']);
    assert.deepEqual(none.lines, ['* THREAD']);
  });

  test('errors: charset, sort keys, algorithm, state, size limit', async (t) => {
    const { setMaxSortMessages } = await import('./limits.js');
    const { client } = await login(t);

    const notSelected = await client.cmd('SORT (DATE) UTF-8 ALL');
    await client.cmd('SELECT INBOX');
    const charset = await client.cmd('SORT (DATE) ISO-8859-1 ALL');
    const key = await client.cmd('SORT (COLOR) UTF-8 ALL');
    const algorithm = await client.cmd('THREAD FANCY UTF-8 ALL');
    const noCriteria = await client.cmd('SORT (DATE) UTF-8');
    setMaxSortMessages(2);
    t.after(() => setMaxSortMessages(100_000));
    const limited = await client.cmd('THREAD REFERENCES UTF-8 ALL');

    assert.equal(notSelected.status, 'NO');
    assert.match(charset.tagged, /NO \[BADCHARSET \(UTF-8 US-ASCII\)\]/);
    assert.equal(key.status, 'BAD');
    assert.equal(algorithm.status, 'BAD');
    assert.equal(noCriteria.status, 'BAD');
    assert.match(limited.tagged, /NO \[LIMIT\]/);
  });

  test('non-UID SORT holds back EXPUNGE, UID SORT delivers it', async (t) => {
    const { client, db } = await select(t);
    tombstone(db, 9);

    const sort = await client.cmd('SORT (ARRIVAL) UTF-8 ALL');
    const uidSort = await client.cmd('UID SORT (ARRIVAL) UTF-8 ALL');

    assert.deepEqual(untagged(sort, /EXPUNGE/), []);
    assert.deepEqual(untagged(uidSort, /EXPUNGE/), ['* 2 EXPUNGE']);
  });
});

// ─── ACL (RFC 4314) ──────────────────────────────────────────────────────────

describe('ACL (RFC 4314, read-only)', () => {
  test('MYRIGHTS, GETACL and LISTRIGHTS on the own mailbox', async (t) => {
    const { client } = await login(t);

    const my = await client.cmd('MYRIGHTS INBOX');
    const acl = await client.cmd('GETACL Archive.2025');
    const owner = await client.cmd('LISTRIGHTS INBOX bob@example.test');
    const other = await client.cmd('LISTRIGHTS INBOX anyone');

    assert.deepEqual(my.lines, ['* MYRIGHTS "INBOX" lrswipkxteacd']);
    assert.deepEqual(acl.lines, ['* ACL "Archive.2025" "bob@example.test" lrswipkxteacd']);
    assert.deepEqual(owner.lines, ['* LISTRIGHTS "INBOX" "bob@example.test" lrswipkxteacd']);
    assert.deepEqual(other.lines, ['* LISTRIGHTS "INBOX" "anyone" ""']);
  });

  test('SETACL / DELETEACL are refused with NOPERM; unknown mailboxes with NONEXISTENT', async (t) => {
    const { client } = await login(t);

    const set = await client.cmd('SETACL INBOX alice@example.test lr');
    const del = await client.cmd('DELETEACL INBOX alice@example.test');
    const missing = await client.cmd('GETACL Nope');
    const syntax = await client.cmd('SETACL INBOX');

    assert.match(set.tagged, /NO \[NOPERM\]/);
    assert.match(del.tagged, /NO \[NOPERM\]/);
    assert.match(missing.tagged, /NO \[NONEXISTENT\]/);
    assert.equal(syntax.status, 'BAD');
  });

  test('ACL commands need authentication', async (t) => {
    const { client } = await connect(t);

    const response = await client.cmd('MYRIGHTS INBOX');

    assert.equal(response.status, 'NO');
  });
});

// ─── COMPRESS=DEFLATE (RFC 4978) ─────────────────────────────────────────────

/** Minimal client that can switch to raw deflate in both directions. */
class DeflateClient {
  private text = '';
  private wake: (() => void) | null = null;
  private inflate: zlib.InflateRaw | null = null;
  private deflate: zlib.DeflateRaw | null = null;
  private tagCounter = 0;
  closed = false;

  constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      if (this.inflate) this.inflate.write(chunk);
      else this.received(chunk);
    });
    socket.on('close', () => {
      // Compressed data may still be inflating: close after the inflate stream has drained.
      if (this.inflate) { this.inflate.once('close', () => this.markClosed()); this.inflate.end(); } else this.markClosed();
    });
    socket.on('error', () => undefined);
  }

  private markClosed(): void { this.closed = true; this.wake?.(); }

  private received(chunk: Buffer): void {
    this.text += chunk.toString('utf8');
    this.wake?.();
  }

  /** Switches both directions to deflate (after the tagged OK of COMPRESS). */
  startCompression(): void {
    assert.equal(this.text, '', 'no octets may follow the COMPRESS OK before the switch');
    this.inflate = zlib.createInflateRaw();
    this.inflate.on('data', (c: Buffer) => this.received(c));
    this.inflate.on('error', () => { this.closed = true; this.wake?.(); });
    this.deflate = zlib.createDeflateRaw();
    this.deflate.on('data', (c: Buffer) => this.socket.write(c));
  }

  /** Raw deflate of `text`, sync-flushed (for pipelining tests). */
  static compressSync(text: string): Buffer {
    return zlib.deflateRawSync(Buffer.from(text, 'utf8'), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  }

  write(raw: string | Buffer): void {
    if (this.deflate) {
      this.deflate.write(raw);
      this.deflate.flush(zlib.constants.Z_SYNC_FLUSH);
    } else {
      this.socket.write(raw);
    }
  }

  async readLine(timeoutMs = 3000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.text.indexOf('\r\n');
      if (idx !== -1) {
        const line = this.text.slice(0, idx);
        this.text = this.text.slice(idx + 2);
        return line;
      }
      if (this.closed) throw new Error(`connection closed (buffered: ${JSON.stringify(this.text)})`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timeout (buffered: ${JSON.stringify(this.text)})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  }

  async completion(tag: string): Promise<Response> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) return { tagged: line, status: line.split(' ')[1] ?? '', lines, raw: '' };
      lines.push(line);
    }
  }

  async cmd(command: string): Promise<Response> {
    const tag = `Z${++this.tagCounter}`;
    this.write(`${tag} ${command}\r\n`);
    return this.completion(tag);
  }

  async waitForClose(timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    return this.closed;
  }
}

async function deflateConnect(t: TestContext): Promise<{ client: DeflateClient; db: FakeDb }> {
  const { db } = installFakes();
  const server = createImapServer(testCert());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  const client = new DeflateClient(socket);
  t.after(() => { socket.destroy(); server.close(); });
  await client.readLine(); // greeting
  return { client, db };
}

describe('COMPRESS=DEFLATE (RFC 4978)', () => {
  test('COMPRESS before authentication is refused', async (t) => {
    const { client } = await deflateConnect(t);

    const response = await client.cmd('COMPRESS DEFLATE');

    assert.equal(response.status, 'BAD');
  });

  test('iOS Mail sequence: LOGIN, ID, COMPRESS, ENABLE QRESYNC, SELECT (QRESYNC), FETCH over deflate', async (t) => {
    const { client, db } = await deflateConnect(t);
    assert.equal((await client.cmd('LOGIN bob@example.test secret')).status, 'OK');
    await client.cmd('ID ("name" "iPhone Mail")');

    const compress = await client.cmd('COMPRESS DEFLATE');
    client.startCompression();
    const caps = await client.cmd('CAPABILITY');
    const enable = await client.cmd('ENABLE QRESYNC');
    tombstone(db, 9);
    const selectResponse = await client.cmd('SELECT INBOX (QRESYNC (777 10 5,9,12))');
    const fetch = await client.cmd('UID FETCH 12 (BODY.PEEK[HEADER.FIELDS (SUBJECT)])');
    const again = await client.cmd('COMPRESS DEFLATE');

    assert.match(compress.tagged, /^Z\d+ OK DEFLATE active$/);
    assert.ok(!capabilitiesOf(caps.lines[0] ?? '').includes('COMPRESS=DEFLATE'), 'COMPRESS is no longer advertised');
    assert.deepEqual(enable.lines, ['* ENABLED QRESYNC']);
    assert.ok(selectResponse.lines.includes('* VANISHED (EARLIER) 9'), JSON.stringify(selectResponse.lines));
    assert.equal(fetch.status, 'OK', fetch.tagged);
    assert.ok(fetch.lines.some((l) => l.includes('Subject: Subject 12')), JSON.stringify(fetch.lines));
    assert.match(again.tagged, /NO \[COMPRESSIONACTIVE\]/);
  });

  test('compressed commands pipelined right after COMPRESS are executed', async (t) => {
    const { client } = await deflateConnect(t);
    await client.cmd('LOGIN bob@example.test secret');

    client.write(Buffer.concat([Buffer.from('P1 COMPRESS DEFLATE\r\n'), DeflateClient.compressSync('P2 NOOP\r\n')]));
    const compress = await client.completion('P1');
    client.startCompression();
    const noop = await client.completion('P2');

    assert.equal(compress.tagged, 'P1 OK DEFLATE active');
    assert.equal(noop.tagged, 'P2 OK NOOP completed');
  });

  test('unknown mechanisms are BAD', async (t) => {
    const { client } = await deflateConnect(t);
    await client.cmd('LOGIN bob@example.test secret');

    const response = await client.cmd('COMPRESS GZIP');

    assert.equal(response.status, 'BAD');
  });

  test('line limits apply to the inflated stream (decompression bomb)', async (t) => {
    const { client } = await deflateConnect(t);
    await client.cmd('LOGIN bob@example.test secret');
    await client.cmd('COMPRESS DEFLATE');
    client.startCompression();

    // 8 MiB without a line end compress to a few KiB.
    client.write(Buffer.alloc(8 * 1024 * 1024, 0x41));
    const bye = await client.readLine();

    assert.equal(bye, '* BYE Line too long');
    assert.ok(await client.waitForClose());
  });

  test('a corrupt deflate stream closes the connection', async (t) => {
    const { client } = await deflateConnect(t);
    await client.cmd('LOGIN bob@example.test secret');
    await client.cmd('COMPRESS DEFLATE');

    client.socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));

    assert.ok(await client.waitForClose());
  });
});
