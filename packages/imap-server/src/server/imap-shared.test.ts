/**
 * v9.1: shared and delegated mailboxes over IMAP — NAMESPACE (RFC 2342), LIST/LSUB/
 * LIST-STATUS, SELECT/EXAMINE/STATUS/FETCH/STORE/SEARCH/COPY/MOVE/EXPUNGE/APPEND on
 * foreign folders, read-only permissions (NOPERM), quota of the target mailbox,
 * live revocation, IDLE push, ACL rights (RFC 4314) and IDOR checks on every command.
 *
 * The real createImapServer() runs on a loopback port with an in-memory multi-mailbox
 * database (test-hooks.mjs replaces @coremail/core / @coremail/storage; the message
 * store and the access policy are the real modules).
 *
 * Fixture (user bob@example.test, password "secret"):
 *   own mailbox mb-bob (uidValidity 777): INBOX (UID 1), Sent, Work
 *   Shared/team@example.test     FULL_ACCESS   mb-team (555): INBOX (UID 1 seen, 2 unseen), Sent, Projects, Projects.2026
 *   Shared/ro@example.test       READ_ONLY     mb-ro   (556): INBOX (UID 3 unseen)
 *   Shared/sendonly@example.test SEND_AS only  → no mailbox access
 *   Shared/secret@example.test   no grant for bob (carol has FULL_ACCESS)
 *   Other Users/alice@example.test  delegated FULL_ACCESS  mb-alice (600): INBOX (UID 1), Archive
 *   Other Users/carol@example.test  delegated READ_ONLY    mb-carol (601): INBOX (UID 4)
 *   Other Users/dave@example.test   delegated to carol only → no access for bob
 *
 * Run (in packages/imap-server, Node >= 22.15): node src/run-protocol-tests.mjs
 */
import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { applyAuthInvalidation, createImapServer } from './index.js';
import { setIdlePollInterval } from '../commands/index.js';
import {
  invalidateAccessCaches, loadNamespaceConfig, parseForeignName, parseNamespacePrefix, setNamespaceConfig,
  namespaceResponse, namespaceConfig,
} from '../commands/namespaces.js';
import { selfSignedTestCert } from '../test-cert.js';

// ─── In-memory database ──────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface Msg {
  id: string; uid: number; modSeq: bigint; folderId: string; flags: string[]; subject: string;
  fromAddr: string; fromName: string; toAddrs: string[]; ccAddrs: string[]; bccAddrs: string[];
  replyTo: string | null; messageId: string | null; inReplyTo: string | null; date: Date; createdAt: Date;
  bodyText: string; bodyHtml: string; rawSize: number; storagePath: string | null; deletedAt: Date | null;
  attachments: unknown[];
}
interface Folder { id: string; mailboxId: string; name: string; displayName: string }
interface Mailbox { id: string; uidNext: number; uidValidity: number; highestModSeq: bigint; userId: string | null; sharedBoxId: string | null }
interface SharedBox { id: string; email: string; displayName: string; active: boolean }
interface User { id: string; email: string; displayName: string | null; active: boolean; passwordHash: string; mailbox: { id: string }; quotaBytes: bigint }

interface Db {
  mailboxes: Mailbox[];
  folders: Folder[];
  messages: Msg[];
  users: User[];
  shared: SharedBox[];
  sharedPerms: Array<{ userId: string; sharedMailboxId: string; permission: string; autoMap?: boolean }>;
  /** 9.4: UserSettings.addedSharedMailboxes of bob. */
  added: string[];
  delegates: Array<{ mailboxId: string; granteeId: string; permission: string }>;
  msg(id: string): Msg;
  folder(id: string): Folder;
  mailbox(id: string): Mailbox;
  deliver(folderId: string, subject: string): Msg;
  /** Number of permission lookups (sharedMailboxPerm.findMany calls). */
  accessReads: number;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (key === 'NOT') return !matches(row, cond as Row);
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { has?: unknown; in?: unknown[]; gte?: number; lte?: number; lt?: unknown };
      if ('has' in c) return (value as unknown[]).includes(c.has);
      if ('in' in c) return (c.in ?? []).includes(value);
      if ('gte' in c || 'lte' in c) {
        return (c.gte === undefined || (value as number) >= c.gte) && (c.lte === undefined || (value as number) <= c.lte);
      }
      throw new Error(`fake prisma: unsupported condition on "${key}": ${JSON.stringify(cond, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    }
    return value === cond;
  });
}

function applyData(target: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'object' && value !== null && 'increment' in value) {
      const inc = (value as { increment: number | bigint }).increment;
      const current = target[key];
      target[key] = typeof current === 'bigint' ? current + BigInt(inc) : (current as number) + Number(inc);
    } else {
      target[key] = value;
    }
  }
}

function install(): Db {
  let nextId = 1;
  const message = (id: string, uid: number, folderId: string, over: Partial<Msg> = {}): Msg => ({
    id, uid, modSeq: 10n, folderId, flags: [], subject: `Subject ${id}`,
    fromAddr: 'someone@example.test', fromName: 'Someone', toAddrs: ['x@example.test'], ccAddrs: [], bccAddrs: [],
    replyTo: null, messageId: `<${id}@example.test>`, inReplyTo: null,
    date: new Date('2026-02-03T10:20:30Z'), createdAt: new Date('2026-02-03T10:20:31Z'),
    bodyText: `Body of ${id}`, bodyHtml: '', rawSize: 1000, storagePath: null, deletedAt: null, attachments: [],
    ...over,
  });
  const mb = (id: string, uidValidity: number, uidNext: number, owner: { userId?: string; sharedBoxId?: string }): Mailbox =>
    ({ id, uidValidity, uidNext, highestModSeq: 10n, userId: owner.userId ?? null, sharedBoxId: owner.sharedBoxId ?? null });
  const f = (id: string, mailboxId: string, name: string): Folder => ({ id, mailboxId, name, displayName: name });
  const user = (id: string, email: string, mailboxId: string): User =>
    ({ id, email, displayName: null, active: true, passwordHash: 'hash:secret', mailbox: { id: mailboxId }, quotaBytes: 1024n * 1024n });

  const db: Db = {
    mailboxes: [
      mb('mb-bob', 777, 2, { userId: 'u1' }), mb('mb-alice', 600, 2, { userId: 'u2' }), mb('mb-carol', 601, 5, { userId: 'u3' }),
      mb('mb-dave', 602, 2, { userId: 'u4' }), mb('mb-team', 555, 3, { sharedBoxId: 's1' }), mb('mb-ro', 556, 4, { sharedBoxId: 's2' }),
      mb('mb-secret', 557, 2, { sharedBoxId: 's3' }), mb('mb-sendonly', 558, 1, { sharedBoxId: 's4' }),
    ],
    folders: [
      f('f-bob-inbox', 'mb-bob', 'INBOX'), f('f-bob-sent', 'mb-bob', 'Sent'), f('f-bob-work', 'mb-bob', 'Work'),
      f('f-team-inbox', 'mb-team', 'INBOX'), f('f-team-sent', 'mb-team', 'Sent'), f('f-team-proj', 'mb-team', 'Projects'),
      f('f-team-proj26', 'mb-team', 'Projects.2026'), f('f-team-slash', 'mb-team', 'A/B'),
      f('f-ro-inbox', 'mb-ro', 'INBOX'),
      f('f-alice-inbox', 'mb-alice', 'INBOX'), f('f-alice-archive', 'mb-alice', 'Archive'),
      f('f-carol-inbox', 'mb-carol', 'INBOX'), f('f-dave-inbox', 'mb-dave', 'INBOX'),
      f('f-secret-inbox', 'mb-secret', 'INBOX'), f('f-sendonly-inbox', 'mb-sendonly', 'INBOX'),
    ],
    messages: [
      message('m-bob-1', 1, 'f-bob-inbox', { subject: 'Bob own mail' }),
      message('m-team-1', 1, 'f-team-inbox', { subject: 'Team one', flags: ['\\Seen'] }),
      message('m-team-2', 2, 'f-team-inbox', { subject: 'Team two' }),
      message('m-ro-3', 3, 'f-ro-inbox', { subject: 'Readonly three' }),
      message('m-alice-1', 1, 'f-alice-inbox', { subject: 'Alice private' }),
      message('m-carol-4', 4, 'f-carol-inbox', { subject: 'Carol private' }),
      message('m-dave-1', 1, 'f-dave-inbox', { subject: 'TOPSECRET dave' }),
      message('m-secret-1', 1, 'f-secret-inbox', { subject: 'TOPSECRET shared' }),
    ],
    users: [
      user('u1', 'bob@example.test', 'mb-bob'), user('u2', 'alice@example.test', 'mb-alice'),
      user('u3', 'carol@example.test', 'mb-carol'), user('u4', 'dave@example.test', 'mb-dave'),
    ],
    shared: [
      { id: 's1', email: 'team@example.test', displayName: 'Team', active: true },
      { id: 's2', email: 'ro@example.test', displayName: 'RO', active: true },
      { id: 's3', email: 'secret@example.test', displayName: 'Secret', active: true },
      { id: 's4', email: 'sendonly@example.test', displayName: 'Send only', active: true },
    ],
    sharedPerms: [
      { userId: 'u1', sharedMailboxId: 's1', permission: 'FULL_ACCESS' },
      { userId: 'u1', sharedMailboxId: 's1', permission: 'SEND_AS' },
      { userId: 'u1', sharedMailboxId: 's2', permission: 'READ_ONLY' },
      { userId: 'u1', sharedMailboxId: 's4', permission: 'SEND_AS' },
      { userId: 'u3', sharedMailboxId: 's3', permission: 'FULL_ACCESS' },
    ],
    delegates: [
      { mailboxId: 'mb-alice', granteeId: 'u1', permission: 'FULL_ACCESS' },
      { mailboxId: 'mb-carol', granteeId: 'u1', permission: 'READ_ONLY' },
      { mailboxId: 'mb-dave', granteeId: 'u3', permission: 'FULL_ACCESS' },
    ],
    msg: (id) => db.messages.find((m) => m.id === id)!,
    folder: (id) => db.folders.find((x) => x.id === id)!,
    mailbox: (id) => db.mailboxes.find((x) => x.id === id)!,
    deliver(folderId, subject) {
      const box = db.mailbox(db.folder(folderId).mailboxId);
      box.highestModSeq++;
      const m = message(`m-new-${nextId++}`, box.uidNext++, folderId, { subject, modSeq: box.highestModSeq });
      db.messages.push(m);
      return m;
    },
    accessReads: 0,
    added: [],
  };

  const withMailbox = (x: Folder | undefined): Row | null => (x ? { ...x, mailbox: { ...db.mailbox(x.mailboxId) } } : null);
  const msgMailbox = (m: Msg): string => db.folder(m.folderId)?.mailboxId ?? '';
  const prisma: Row = {
    domain: { findFirst: async () => ({ name: 'example.test' }) },
    user: { findFirst: async ({ where }: { where: Row }) => { await tick(); return db.users.find((u) => matches(u as unknown as Row, where)) ?? null; } },
    appPassword: { findMany: async () => [], update: async () => ({}) },
    userSettings: { findUnique: async () => ({ addedSharedMailboxes: [...db.added] }) },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(prisma),
    sharedMailboxPerm: {
      findMany: async ({ where }: { where: { userId: string; permission: { in: string[] } } }) => {
        db.accessReads++;
        await tick();
        return db.sharedPerms
          .filter((p) => p.userId === where.userId && where.permission.in.includes(p.permission))
          .map((p) => {
            const box = db.shared.find((s) => s.id === p.sharedMailboxId)!;
            const mbx = db.mailboxes.find((m) => m.sharedBoxId === box.id);
            return { permission: p.permission, autoMap: p.autoMap, sharedMailbox: { ...box, mailbox: mbx ? { id: mbx.id } : null } };
          });
      },
    },
    mailboxDelegate: {
      findMany: async ({ where }: { where: { granteeId: string; permission: { in: string[] } } }) => {
        await tick();
        return db.delegates
          .filter((d) => d.granteeId === where.granteeId && where.permission.in.includes(d.permission))
          .map((d) => {
            const owner = db.users.find((u) => u.mailbox.id === d.mailboxId) ?? null;
            return { permission: d.permission, mailbox: { id: d.mailboxId, user: owner && { id: owner.id, email: owner.email, displayName: owner.displayName, active: owner.active } } };
          });
      },
    },
    mailbox: {
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        await tick();
        const box = db.mailbox(where.id);
        applyData(box as unknown as Row, data);
        return { ...box };
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: { highestModSeq?: bigint; uidNext?: number } }) => {
        const box = db.mailbox(where.id);
        if (data.highestModSeq !== undefined && box.highestModSeq < data.highestModSeq) box.highestModSeq = data.highestModSeq;
        if (data.uidNext !== undefined && box.uidNext < data.uidNext) box.uidNext = data.uidNext;
        return { count: 1 };
      },
    },
    folder: {
      findMany: async ({ where }: { where: Row }) => {
        await tick();
        return db.folders.filter((x) => matches(x as unknown as Row, where)).sort((a, b) => a.name.localeCompare(b.name));
      },
      findFirst: async ({ where }: { where: Row }) => { await tick(); return withMailbox(db.folders.find((x) => matches(x as unknown as Row, where))); },
      findUnique: async ({ where }: { where: { id: string } }) => withMailbox(db.folders.find((x) => x.id === where.id)),
      create: async ({ data }: { data: { mailboxId: string; name: string; displayName: string } }) => {
        const created = { id: `f-new-${nextId++}`, ...data };
        db.folders.push(created);
        return created;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const target = db.folder(where.id);
        applyData(target as unknown as Row, data);
        return target;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const targets = db.folders.filter((x) => matches(x as unknown as Row, where));
        for (const target of targets) applyData(target as unknown as Row, data);
        return { count: targets.length };
      },
      delete: async ({ where }: { where: { id: string } }) => { db.folders = db.folders.filter((x) => x.id !== where.id); return {}; },
    },
    message: {
      findMany: async ({ where, orderBy }: { where: Row; orderBy?: unknown }) => {
        await tick();
        const rows = db.messages.filter((m) => matches(m as unknown as Row, where));
        rows.sort((a, b) => a.uid - b.uid);
        if (orderBy && !Array.isArray(orderBy) && (orderBy as { uid?: string }).uid === 'desc') rows.reverse();
        return rows.map((m) => ({ ...m, flags: [...m.flags] }));
      },
      count: async ({ where }: { where: Row }) => { await tick(); return db.messages.filter((m) => matches(m as unknown as Row, where)).length; },
      aggregate: async ({ where }: { where: { folder: { mailboxId: string } } }) => {
        const rows = db.messages.filter((m) => msgMailbox(m) === where.folder.mailboxId);
        return {
          _max: {
            modSeq: rows.length ? rows.reduce((a, m) => (m.modSeq > a ? m.modSeq : a), 0n) : null,
            uid: rows.length ? Math.max(...rows.map((m) => m.uid)) : null,
          },
        };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        await tick();
        const target = db.msg(where.id);
        applyData(target as unknown as Row, data);
        return { ...target };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        await tick();
        const targets = db.messages.filter((m) => matches(m as unknown as Row, where));
        for (const t of targets) applyData(t as unknown as Row, data);
        return { count: targets.length };
      },
      create: async ({ data }: { data: Row }) => {
        await tick();
        const { attachments: _a, ...rest } = data;
        const created = { ...message(`m-new-${nextId++}`, 0, ''), ...rest } as Msg;
        db.messages.push(created);
        return created;
      },
    },
    attachment: { create: async () => ({}) },
  };

  const globals = (globalThis as unknown as { __coremailTest: Row }).__coremailTest;
  globals['prisma'] = prisma;
  globals['overQuota'] = undefined;
  let onMessage: ((channel: string, message: string) => void) | null = null;
  globals['redis'] = {
    duplicate: () => ({ subscribe: async () => 1, on: (e: string, l: typeof onMessage) => { if (e === 'message') onMessage = l; } }),
    publish: async (channel: string, message: string) => { onMessage?.(channel, message); return 1; },
  };
  // 9.4: the message store's mailbox:changes event for new mail in a folder
  (db as unknown as { emit: (e: Row) => void }).emit = (e) => {
    const folder = db.folders.find((f) => f['id'] === e['folderId']);
    onMessage?.('mailbox:changes', JSON.stringify({ mailboxId: folder?.['mailboxId'], kinds: ['messages'], folderIds: [e['folderId']] }));
  };
  invalidateAccessCaches();
  return db;
}

// ─── Client ──────────────────────────────────────────────────────────────────

interface Response { tagged: string; status: string; lines: string[]; raw: string }

class Client {
  private buffer = '';
  private wake: (() => void) | null = null;
  private n = 0;
  closed = false;
  constructor(private readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => { this.buffer += c; this.wake?.(); });
    socket.on('close', () => { this.closed = true; this.wake?.(); });
    socket.on('error', () => undefined);
  }
  write(raw: string): void { this.socket.write(raw, 'utf8'); }
  async line(timeoutMs = 2000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.buffer.indexOf('\r\n');
      if (i !== -1) { const l = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 2); return l; }
      if (this.closed) throw new Error('connection closed');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout (buffered: ${JSON.stringify(this.buffer)})`);
      await new Promise<void>((r) => { const t = setTimeout(r, left); this.wake = () => { clearTimeout(t); r(); }; });
    }
  }
  async completion(tag: string): Promise<Response> {
    const lines: string[] = [];
    for (;;) {
      const l = await this.line();
      if (l.startsWith(`${tag} `)) return { tagged: l, status: l.split(' ')[1] ?? '', lines, raw: lines.join('\r\n') };
      lines.push(l);
    }
  }
  async cmd(command: string): Promise<Response> {
    const tag = `A${++this.n}`;
    this.write(`${tag} ${command}\r\n`);
    return this.completion(tag);
  }
  /** APPEND with a synchronizing literal; returns the response (continuation or refusal). */
  async append(mailbox: string, message: string): Promise<Response> {
    const tag = `A${++this.n}`;
    this.write(`${tag} APPEND ${mailbox} {${Buffer.byteLength(message)}}\r\n`);
    const first = await this.line();
    if (first.startsWith(`${tag} `)) return { tagged: first, status: first.split(' ')[1] ?? '', lines: [], raw: '' };
    assert.match(first, /^\+/);
    this.write(`${message}\r\n`);
    return this.completion(tag);
  }
  destroy(): void { this.socket.destroy(); }
}

let cert: { cert: Buffer; key: Buffer } | null = null;

async function login(t: TestContext): Promise<{ client: Client; db: Db }> {
  const db = install();
  const server = createImapServer((cert ??= selfSignedTestCert()));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  const client = new Client(socket);
  t.after(() => { client.destroy(); server.close(); });
  await client.line();
  const r = await client.cmd('LOGIN bob@example.test secret');
  assert.equal(r.status, 'OK', r.tagged);
  return { client, db };
}

const TEAM = '"Shared/team@example.test/INBOX"';
const RO = '"Shared/ro@example.test/INBOX"';
const ALICE = '"Other Users/alice@example.test/INBOX"';
const CAROL = '"Other Users/carol@example.test/INBOX"';
const SECRET = '"Shared/secret@example.test/INBOX"';
const DAVE = '"Other Users/dave@example.test/INBOX"';
const SENDONLY = '"Shared/sendonly@example.test/INBOX"';
const NOBODY = '"Shared/nobody@example.test/INBOX"';

const untagged = (r: Response, re: RegExp): string[] => r.lines.filter((l) => l.startsWith('* ') && re.test(l));

// ─── Configuration and name parsing (unit) ───────────────────────────────────

describe('namespace configuration and names', () => {
  test('prefixes come from the environment, can be disabled, and invalid values fall back to the defaults', () => {
    assert.equal(parseNamespacePrefix(undefined, 'Shared'), 'Shared');
    assert.equal(parseNamespacePrefix('Public/', 'Shared'), 'Public');
    assert.equal(parseNamespacePrefix('off', 'Shared'), null);
    assert.equal(parseNamespacePrefix('', 'Shared'), null);
    for (const bad of ['a.b', 'a*', '%', 'x"y', 'inbox', 'a\\b', 'ü']) assert.equal(parseNamespacePrefix(bad, 'Shared'), 'Shared', bad);
    const cfg = loadNamespaceConfig({ IMAP_NAMESPACE_OTHER_USERS: 'Users', IMAP_NAMESPACE_SHARED: 'users', IMAP_SHARED_ACCESS_CACHE_MS: '999999' });
    assert.deepEqual(cfg, { otherUsers: 'Users', shared: null, cacheMs: 30_000 });
    assert.equal(loadNamespaceConfig({ IMAP_SHARED_ACCESS_CACHE_MS: '-5' }).cacheMs, 0);
  });

  test('NAMESPACE follows the configuration', () => {
    const saved = namespaceConfig();
    try {
      setNamespaceConfig({ otherUsers: null, shared: 'Public', cacheMs: 0 });
      assert.equal(namespaceResponse(), 'NAMESPACE (("" ".")) NIL (("Public/" "/"))');
    } finally {
      setNamespaceConfig(saved);
    }
  });

  test('foreign names: case-insensitive prefix, address and INBOX; "." inside a level is invalid', () => {
    assert.deepEqual(parseForeignName('shared/TEAM@Example.test/inbox/Sub'), { kind: 'shared', email: 'team@example.test', path: 'INBOX.Sub' });
    assert.deepEqual(parseForeignName('Other Users/alice@example.test/Archive/2025'), { kind: 'delegated', email: 'alice@example.test', path: 'Archive.2025' });
    assert.deepEqual(parseForeignName('Shared/team@example.test'), { kind: 'shared', email: 'team@example.test', path: null });
    assert.deepEqual(parseForeignName('Shared/'), { kind: 'shared', email: '', path: null });
    assert.equal(parseForeignName('Shared/team@example.test/a.b')?.path, undefined);
    assert.equal(parseForeignName('Shared/team@example.test/a//b')?.path, undefined);
    assert.equal(parseForeignName('Shared'), null);
    assert.equal(parseForeignName('Work.Sub'), null);
  });
});

// ─── LIST / LSUB / STATUS ────────────────────────────────────────────────────

describe('LIST, LSUB and STATUS show shared and delegated folders', () => {
  test('LIST "" "*" lists the accessible foreign folders with "/" and no SPECIAL-USE', async (t) => {
    const { client } = await login(t);
    const r = await client.cmd('LIST "" "*"');
    assert.equal(r.status, 'OK');
    const names = r.lines.map((l) => /"([^"]*)"$/.exec(l)?.[1]);
    for (const n of [
      'Shared/team@example.test/INBOX', 'Shared/team@example.test/Sent', 'Shared/team@example.test/Projects',
      'Shared/team@example.test/Projects/2026', 'Shared/ro@example.test/INBOX',
      'Other Users/alice@example.test/INBOX', 'Other Users/alice@example.test/Archive', 'Other Users/carol@example.test/INBOX',
    ]) assert.ok(names.includes(n), `${n} missing in ${r.raw}`);
    // No access, SEND_AS only, or a name that cannot be expressed with "/".
    assert.equal(untagged(r, /secret|dave|sendonly|A\/B/).length, 0, r.raw);
    assert.deepEqual(untagged(r, /"Shared\/team@example.test\/Sent"$/), ['* LIST (\\HasNoChildren) "/" "Shared/team@example.test/Sent"']);
    assert.deepEqual(untagged(r, /"Sent"$/), ['* LIST (\\HasNoChildren \\Sent) "." "Sent"']);
    assert.deepEqual(untagged(r, /"Shared\/team@example.test\/Projects"$/), ['* LIST (\\HasChildren) "/" "Shared/team@example.test/Projects"']);
  });

  test('"%" shows the namespace roots; LIST under a prefix walks the hierarchy', async (t) => {
    const { client } = await login(t);
    const top = await client.cmd('LIST "" "%"');
    assert.deepEqual(untagged(top, /Shared|Other Users/), [
      '* LIST (\\Noselect \\HasChildren) "/" "Other Users"',
      '* LIST (\\Noselect \\HasChildren) "/" "Shared"',
    ]);
    const accounts = await client.cmd('LIST "Shared/" "%"');
    assert.deepEqual(accounts.lines, [
      '* LIST (\\Noselect \\HasChildren) "/" "Shared/ro@example.test"',
      '* LIST (\\Noselect \\HasChildren) "/" "Shared/team@example.test"',
    ]);
    const folders = await client.cmd('LIST "" "Shared/team@example.test/%"');
    assert.equal(folders.lines.length, 3, folders.raw); // INBOX, Projects, Sent — not Projects/2026
    const delim = await client.cmd('LIST "Shared/" ""');
    assert.deepEqual(delim.lines, ['* LIST (\\Noselect) "/" "Shared"']);
  });

  test('LSUB and LIST (SUBSCRIBED) include the foreign folders; SPECIAL-USE selection does not', async (t) => {
    const { client } = await login(t);
    const lsub = await client.cmd('LSUB "" "*"');
    assert.ok(lsub.lines.includes('* LSUB (\\HasNoChildren) "/" "Shared/team@example.test/INBOX"'), lsub.raw);
    const sub = await client.cmd('LIST (SUBSCRIBED) "" "Other Users/*"');
    assert.ok(sub.lines.some((l) => l.includes('\\Subscribed') && l.endsWith('"Other Users/alice@example.test/INBOX"')), sub.raw);
    const special = await client.cmd('LIST (SPECIAL-USE) "" "*"');
    assert.equal(untagged(special, /Shared|Other Users/).length, 0, special.raw);
  });

  test('STATUS and LIST-STATUS report the foreign mailbox counters', async (t) => {
    const { client } = await login(t);
    const s = await client.cmd(`STATUS ${TEAM} (MESSAGES UNSEEN UIDNEXT UIDVALIDITY HIGHESTMODSEQ)`);
    assert.deepEqual(s.lines, ['* STATUS "Shared/team@example.test/INBOX" (MESSAGES 2 UNSEEN 1 UIDNEXT 3 UIDVALIDITY 555 HIGHESTMODSEQ 10)']);
    const l = await client.cmd('LIST "" "Other Users/alice@example.test/INBOX" RETURN (STATUS (MESSAGES))');
    assert.deepEqual(untagged(l, /^\* STATUS/), ['* STATUS "Other Users/alice@example.test/INBOX" (MESSAGES 1)']);
  });

  test('the prefix, the address and INBOX are case-insensitive', async (t) => {
    const { client } = await login(t);
    const s = await client.cmd('STATUS "shared/TEAM@example.test/inbox" (MESSAGES)');
    assert.equal(s.status, 'OK', s.tagged);
  });
});

// ─── SELECT / FETCH / STORE / SEARCH / EXPUNGE ───────────────────────────────

describe('SELECT and message commands on foreign folders', () => {
  test('SELECT on a FULL_ACCESS shared mailbox is read-write with that mailbox\'s UIDVALIDITY and counters', async (t) => {
    const { client } = await login(t);
    const r = await client.cmd(`SELECT ${TEAM}`);
    assert.match(r.tagged, /OK \[READ-WRITE\]/);
    assert.ok(r.lines.includes('* 2 EXISTS'));
    assert.ok(r.lines.includes('* OK [UIDVALIDITY 555] UIDs valid'));
    assert.ok(r.lines.includes('* OK [UIDNEXT 3] Predicted next UID'));
    const f = await client.cmd('FETCH 1:* (UID FLAGS ENVELOPE)');
    assert.equal(untagged(f, /FETCH/).length, 2);
    assert.match(f.raw, /Team one/);
    assert.doesNotMatch(f.raw, /Bob own mail|TOPSECRET/);
  });

  test('STORE writes through the message store of the target mailbox (its modSeq, not the own one)', async (t) => {
    const { client, db } = await login(t);
    await client.cmd('ENABLE CONDSTORE');
    await client.cmd(`SELECT ${TEAM}`);
    const r = await client.cmd('UID STORE 2 +FLAGS (\\Flagged)');
    assert.equal(r.status, 'OK', r.tagged);
    assert.deepEqual(db.msg('m-team-2').flags, ['\\Flagged']);
    assert.equal(db.mailbox('mb-team').highestModSeq, 11n);
    assert.equal(db.mailbox('mb-bob').highestModSeq, 10n);
    assert.match(r.raw, /MODSEQ \(11\)/);
  });

  test('FETCH BODY[] sets \\Seen in a read-write foreign mailbox, SEARCH works on its messages', async (t) => {
    const { client, db } = await login(t);
    await client.cmd(`SELECT ${ALICE}`);
    const s = await client.cmd('UID SEARCH UNSEEN');
    assert.ok(s.lines.includes('* SEARCH 1'), s.raw);
    await client.cmd('FETCH 1 BODY[]');
    assert.deepEqual(db.msg('m-alice-1').flags, ['\\Seen']);
  });

  test('EXPUNGE removes \\Deleted messages of the foreign folder only', async (t) => {
    const { client, db } = await login(t);
    await client.cmd(`SELECT ${TEAM}`);
    await client.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');
    const r = await client.cmd('EXPUNGE');
    assert.ok(r.lines.includes('* 1 EXPUNGE'), r.raw);
    assert.ok(db.msg('m-team-1').deletedAt);
    assert.equal(db.msg('m-bob-1').deletedAt, null);
  });

  test('read-only permission: SELECT is [READ-ONLY] and every write is NO [NOPERM]', async (t) => {
    const { client, db } = await login(t);
    const sel = await client.cmd(`SELECT ${RO}`);
    assert.match(sel.tagged, /OK \[READ-ONLY\] SELECT completed/);
    assert.ok(sel.lines.includes('* OK [PERMANENTFLAGS ()] No permanent flags permitted'));
    for (const cmd of ['STORE 1 +FLAGS (\\Seen)', 'UID STORE 3 +FLAGS (\\Deleted)', 'EXPUNGE', 'UID EXPUNGE 3', 'MOVE 1 INBOX', 'UID MOVE 3 INBOX']) {
      const r = await client.cmd(cmd);
      assert.match(r.tagged, /NO \[NOPERM\]/, `${cmd}: ${r.tagged}`);
    }
    // Reading does not set \Seen; copying out is allowed.
    await client.cmd('FETCH 1 BODY[]');
    assert.deepEqual(db.msg('m-ro-3').flags, []);
    const copy = await client.cmd('COPY 1 Work');
    assert.match(copy.tagged, /OK \[COPYUID 777 3 2\]/);
    assert.equal(db.messages.filter((m) => m.folderId === 'f-bob-work').length, 1);
    assert.equal(db.msg('m-ro-3').deletedAt, null);
  });

  test('read-only delegation behaves the same (Other Users)', async (t) => {
    const { client } = await login(t);
    const sel = await client.cmd(`SELECT ${CAROL}`);
    assert.match(sel.tagged, /\[READ-ONLY\]/);
    assert.match((await client.cmd('STORE 1 +FLAGS (\\Seen)')).tagged, /NO \[NOPERM\]/);
  });

  test('EXAMINE on a FULL_ACCESS mailbox keeps the EXAMINE semantics', async (t) => {
    const { client } = await login(t);
    const r = await client.cmd(`EXAMINE ${TEAM}`);
    assert.match(r.tagged, /\[READ-ONLY\] EXAMINE/);
    assert.match((await client.cmd('STORE 1 +FLAGS (\\Seen)')).tagged, /NO \[READ-ONLY\]/);
  });

  test('THREAD REFERENCES uses the References of the selected shared folder', async (t) => {
    const { client, db } = await login(t);
    Object.assign(db.msg('m-team-2'), { subject: 'Other subject', inReplyTo: '<gone@example.test>', references: '<m-team-1@example.test> <gone@example.test>' });
    await client.cmd(`SELECT ${TEAM}`);
    const r = await client.cmd('UID THREAD REFERENCES UTF-8 ALL');
    assert.deepEqual(r.lines, ['* THREAD (1 2)']);
  });

  test('IMAP4rev2 SELECT names the foreign mailbox with its "/" delimiter', async (t) => {
    const { client } = await login(t);
    await client.cmd('ENABLE IMAP4rev2');
    const r = await client.cmd(`SELECT ${TEAM}`);
    assert.ok(r.lines.includes('* LIST () "/" "Shared/team@example.test/INBOX"'), r.raw);
  });

  test('QRESYNC resynchronises against the foreign mailbox\'s modSeq', async (t) => {
    const { client, db } = await login(t);
    db.msg('m-team-2').modSeq = 12n;
    db.mailbox('mb-team').highestModSeq = 12n;
    await client.cmd('ENABLE QRESYNC');
    const r = await client.cmd(`SELECT ${TEAM} (QRESYNC (555 11))`);
    assert.ok(r.lines.includes('* OK [HIGHESTMODSEQ 12] Highest'), r.raw);
    assert.deepEqual(untagged(r, /FETCH/), ['* 2 FETCH (UID 2 FLAGS () MODSEQ (12))']);
  });

  test('a delivery into a selected shared folder is pushed to an IDLE session of another user', async (t) => {
    setIdlePollInterval(60_000);
    const { client, db } = await login(t);
    await client.cmd(`SELECT ${TEAM}`);
    client.write('I1 IDLE\r\n');
    assert.match(await client.line(), /^\+ /);
    const m = db.deliver('f-team-inbox', 'Pushed');
    (db as unknown as { emit: (e: Row) => void }).emit({ userId: 'someone-else', folderId: 'f-team-inbox', messageId: m.id, uid: m.uid, subject: 'Pushed' });
    assert.equal(await client.line(), '* 3 EXISTS');
    client.write('DONE\r\n');
    assert.match(await client.line(), /^I1 OK/);
  });
});

// ─── COPY / MOVE / APPEND across mailboxes, quota ────────────────────────────

describe('COPY, MOVE and APPEND between the own and foreign mailboxes', () => {
  test('COPY from a shared folder into the own INBOX and back uses each target\'s UIDs', async (t) => {
    const { client, db } = await login(t);
    await client.cmd(`SELECT ${TEAM}`);
    const out = await client.cmd('UID COPY 2 INBOX');
    assert.match(out.tagged, /OK \[COPYUID 777 2 2\]/);
    assert.equal(db.messages.filter((m) => m.folderId === 'f-bob-inbox').length, 2);
    await client.cmd('SELECT INBOX');
    const back = await client.cmd(`UID COPY 1 ${TEAM}`);
    assert.match(back.tagged, /OK \[COPYUID 555 1 3\]/);
    assert.equal(db.mailbox('mb-team').uidNext, 4);
  });

  test('MOVE from the own INBOX into a delegated mailbox', async (t) => {
    const { client, db } = await login(t);
    await client.cmd('SELECT INBOX');
    const r = await client.cmd('UID MOVE 1 "Other Users/alice@example.test/Archive"');
    assert.equal(r.status, 'OK', r.tagged);
    assert.ok(r.lines.some((l) => l.includes('[COPYUID 600 1 2]')), r.raw);
    assert.equal(db.msg('m-bob-1').folderId, 'f-alice-archive');
    assert.equal(db.msg('m-bob-1').uid, 2);
  });

  test('COPY / MOVE / APPEND into a read-only foreign mailbox are NO [NOPERM]', async (t) => {
    const { client, db } = await login(t);
    await client.cmd('SELECT INBOX');
    assert.match((await client.cmd(`COPY 1 ${RO}`)).tagged, /NO \[NOPERM\]/);
    assert.match((await client.cmd(`MOVE 1 ${CAROL}`)).tagged, /NO \[NOPERM\]/);
    const a = await client.append(RO, 'Subject: x\r\n\r\nbody');
    assert.match(a.tagged, /NO \[NOPERM\]/);
    assert.equal(db.messages.filter((m) => m.folderId === 'f-ro-inbox').length, 1);
  });

  test('APPEND into a FULL_ACCESS shared mailbox allocates its UID', async (t) => {
    const { client, db } = await login(t);
    const a = await client.append(TEAM, 'Subject: appended\r\n\r\nbody');
    assert.match(a.tagged, /OK \[APPENDUID 555 3\]/);
    assert.equal(db.messages.find((m) => m.subject === 'appended')?.folderId, 'f-team-inbox');
  });

  test('quota is the target mailbox\'s own: a full shared mailbox refuses APPEND/COPY, a full own one does not matter', async (t) => {
    const { client } = await login(t);
    const g = (globalThis as unknown as { __coremailTest: Row }).__coremailTest;
    g['overQuota'] = (mailboxId: string) => mailboxId === 'mb-team';
    assert.match((await client.append(TEAM, 'Subject: q\r\n\r\nx')).tagged, /NO \[OVERQUOTA\]/);
    await client.cmd('SELECT INBOX');
    assert.match((await client.cmd(`COPY 1 ${TEAM}`)).tagged, /NO \[OVERQUOTA\]/);
    g['overQuota'] = (mailboxId: string) => mailboxId === 'mb-bob';
    assert.match((await client.append(ALICE, 'Subject: q\r\n\r\nx')).tagged, /OK \[APPENDUID 600/);
    g['overQuota'] = undefined;
  });
});

// ─── Folder management and ACL ───────────────────────────────────────────────

describe('CREATE/DELETE/RENAME and ACL rights', () => {
  test('FULL_ACCESS may manage folders inside the foreign mailbox; read-only may not', async (t) => {
    const { client, db } = await login(t);
    assert.equal((await client.cmd('CREATE "Shared/team@example.test/New/Sub"')).status, 'OK');
    assert.ok(db.folders.some((x) => x.mailboxId === 'mb-team' && x.name === 'New.Sub'));
    assert.equal((await client.cmd('RENAME "Shared/team@example.test/New/Sub" "Shared/team@example.test/Renamed"')).status, 'OK');
    assert.ok(db.folders.some((x) => x.mailboxId === 'mb-team' && x.name === 'Renamed'));
    assert.match((await client.cmd('RENAME "Shared/team@example.test/Renamed" "Mine"')).tagged, /NO \[CANNOT\]/);
    assert.equal((await client.cmd('DELETE "Shared/team@example.test/Renamed"')).status, 'OK');
    assert.match((await client.cmd('CREATE "Shared/ro@example.test/New"')).tagged, /NO \[NOPERM\]/);
    assert.match((await client.cmd(`DELETE "Other Users/carol@example.test/INBOX"`)).tagged, /NO/);
    assert.match((await client.cmd('CREATE "Shared/team@example.test"')).tagged, /NO \[NOPERM\]/);
    assert.match((await client.cmd('CREATE "Shared/team@example.test/a.b"')).tagged, /NO \[NOPERM\]/);
  });

  test('personal folders under a reserved prefix are hidden from LIST; CREATE/RENAME into a prefix say it is reserved', async (t) => {
    const { client, db } = await login(t);
    // Legacy personal folders (created before 9.1) whose names start with a namespace prefix.
    db.folders.push(
      { id: 'f-bob-legacy1', mailboxId: 'mb-bob', name: 'Shared/old', displayName: 'Shared/old' },
      { id: 'f-bob-legacy2', mailboxId: 'mb-bob', name: 'other users/x', displayName: 'other users/x' },
      { id: 'f-bob-legacy3', mailboxId: 'mb-bob', name: 'Shared/team@example.test/INBOX', displayName: 'Shared/team@example.test/INBOX' },
    );
    const r = await client.cmd('LIST "" "*"');
    assert.equal(r.status, 'OK');
    assert.equal(untagged(r, /Shared\/old|other users\/x/i).length, 0, r.raw);
    // The real shared entry is listed once, with the "/" delimiter (not shadowed by the personal one).
    assert.deepEqual(untagged(r, /"Shared\/team@example.test\/INBOX"$/), ['* LIST (\\HasNoChildren) "/" "Shared/team@example.test/INBOX"']);
    assert.ok(untagged(r, /"Work"$/).length === 1, 'ordinary personal folders stay listed');

    const c = await client.cmd('CREATE "Shared/nobody@example.test/New"');
    assert.match(c.tagged, /NO \[NOPERM\].*reserved/, c.tagged);
    const c2 = await client.cmd('CREATE "shared/Whatever"');
    assert.match(c2.tagged, /NO \[NOPERM\].*"Shared\/" are reserved/, c2.tagged);
    const rn = await client.cmd('RENAME Work "Other Users/zed@example.test/Work"');
    assert.match(rn.tagged, /NO \[NOPERM\].*"Other Users\/" are reserved/, rn.tagged);
    assert.ok(db.folders.some((x) => x.id === 'f-bob-work' && x.name === 'Work'), 'nothing renamed');
    assert.equal(db.folders.filter((x) => x.mailboxId === 'mb-bob' && /^shared\//i.test(x.name)).length, 2, 'nothing created');
  });

  test('MYRIGHTS maps the permission; GETACL/LISTRIGHTS of others and SETACL are NOPERM', async (t) => {
    const { client } = await login(t);
    assert.deepEqual((await client.cmd(`MYRIGHTS ${TEAM}`)).lines, ['* MYRIGHTS "Shared/team@example.test/INBOX" lrswipkxtecd']);
    assert.deepEqual((await client.cmd(`MYRIGHTS ${RO}`)).lines, ['* MYRIGHTS "Shared/ro@example.test/INBOX" lr']);
    assert.deepEqual((await client.cmd(`MYRIGHTS ${ALICE}`)).lines, ['* MYRIGHTS "Other Users/alice@example.test/INBOX" lrswipkxtecd']);
    assert.deepEqual((await client.cmd(`MYRIGHTS ${CAROL}`)).lines, ['* MYRIGHTS "Other Users/carol@example.test/INBOX" lr']);
    assert.deepEqual((await client.cmd('MYRIGHTS INBOX')).lines, ['* MYRIGHTS "INBOX" lrswipkxteacd']);
    assert.match((await client.cmd(`GETACL ${TEAM}`)).tagged, /NO \[NOPERM\]/);
    assert.deepEqual((await client.cmd(`LISTRIGHTS ${RO} bob@example.test`)).lines, ['* LISTRIGHTS "Shared/ro@example.test/INBOX" "bob@example.test" lr']);
    assert.match((await client.cmd(`LISTRIGHTS ${TEAM} carol@example.test`)).tagged, /NO \[NOPERM\]/);
    assert.match((await client.cmd(`SETACL ${TEAM} carol@example.test lr`)).tagged, /NO \[NOPERM\].*BCP/);
    assert.match((await client.cmd(`DELETEACL ${TEAM} carol@example.test`)).tagged, /NO \[NOPERM\]/);
  });
});

// ─── IDOR: no foreign folder or message without a current permission ─────────

describe('IDOR — nothing of another mailbox is reachable without a current permission', () => {
  const inaccessible = [SECRET, DAVE, SENDONLY, NOBODY, '"Shared/team@example.test/Missing"'];

  test('SELECT / EXAMINE / STATUS / SUBSCRIBE / MYRIGHTS / GETACL / LISTRIGHTS / SETACL / GETQUOTAROOT / DELETE answer like a missing mailbox', async (t) => {
    const { client } = await login(t);
    for (const name of inaccessible) {
      for (const cmd of [
        `SELECT ${name}`, `EXAMINE ${name}`, `STATUS ${name} (MESSAGES)`, `SUBSCRIBE ${name}`, `MYRIGHTS ${name}`,
        `GETACL ${name}`, `LISTRIGHTS ${name} bob@example.test`, `SETACL ${name} bob@example.test lr`,
        `GETQUOTAROOT ${name}`, `DELETE ${name}`,
      ]) {
        const r = await client.cmd(cmd);
        assert.match(r.tagged, /NO \[NONEXISTENT\]/, `${cmd}: ${r.tagged}`);
        assert.doesNotMatch(r.raw, /TOPSECRET|MESSAGES \d/, cmd);
      }
    }
  });

  test('APPEND / COPY / MOVE into an inaccessible mailbox are refused like a missing one and write nothing', async (t) => {
    const { client, db } = await login(t);
    const before = db.messages.length;
    for (const name of [SECRET, DAVE, SENDONLY]) {
      assert.match((await client.append(name, 'Subject: x\r\n\r\ny')).tagged, /NO \[TRYCREATE\]/, name);
    }
    await client.cmd('SELECT INBOX');
    for (const name of [SECRET, DAVE, SENDONLY]) {
      assert.match((await client.cmd(`COPY 1 ${name}`)).tagged, /NO \[TRYCREATE\]/, name);
      assert.match((await client.cmd(`UID MOVE 1 ${name}`)).tagged, /NO \[TRYCREATE\]/, name);
      assert.match((await client.cmd(`CREATE "${name.slice(1, -1).replace('/INBOX', '/New')}"`)).tagged, /NO \[NOPERM\]/, name);
      assert.match((await client.cmd(`RENAME Work ${name.replace('INBOX', 'X')}`)).tagged, /NO \[NOPERM\]/, name);
    }
    assert.equal(db.messages.length, before);
    assert.equal(db.msg('m-bob-1').folderId, 'f-bob-inbox');
    assert.ok(!db.folders.some((x) => ['mb-secret', 'mb-dave', 'mb-sendonly'].includes(x.mailboxId) && x.name !== 'INBOX'));
  });

  test('UID / sequence addressing never leaves the selected folder', async (t) => {
    const { client, db } = await login(t);
    await client.cmd('SELECT INBOX');
    // UIDs that exist in other mailboxes (1 = secret/dave/alice/team, 3 = ro, 4 = carol).
    const f = await client.cmd('UID FETCH 1:* (UID BODY.PEEK[HEADER.FIELDS (SUBJECT)])');
    assert.equal(untagged(f, /FETCH/).length, 1);
    assert.doesNotMatch(f.raw, /TOPSECRET|Team|Alice|Carol|Readonly/);
    await client.cmd('UID STORE 1:* +FLAGS (\\Deleted)');
    await client.cmd('UID EXPUNGE 1:*');
    for (const id of ['m-secret-1', 'm-dave-1', 'm-team-1', 'm-alice-1']) assert.equal(db.msg(id).deletedAt, null, id);
    // From a shared folder: COPY addresses the shared folder's messages only.
    await client.cmd(`SELECT ${TEAM}`);
    const c = await client.cmd('UID COPY 1:* INBOX');
    assert.match(c.tagged, /OK \[COPYUID 777 1:2 2:3\]|OK \[COPYUID 777 1,2 2,3\]/);
    assert.ok(!db.messages.some((m) => m.folderId === 'f-bob-inbox' && /TOPSECRET/.test(m.subject)));
    const s = await client.cmd('UID SEARCH ALL');
    assert.ok(s.lines.includes('* SEARCH 1 2'), s.raw);
  });

  test('LIST patterns never reveal inaccessible accounts', async (t) => {
    const { client } = await login(t);
    for (const p of ['"*"', '"Shared/*"', '"Other Users/%"', '"Shared/secret@example.test/*"', '"Other Users/dave@example.test/%"']) {
      const r = await client.cmd(`LIST "" ${p}`);
      assert.equal(untagged(r, /secret|dave|sendonly/).length, 0, `${p}: ${r.raw}`);
    }
    const lsub = await client.cmd('LSUB "" "*"');
    assert.equal(untagged(lsub, /secret|dave|sendonly/).length, 0);
  });
});

// ─── Live permission changes ─────────────────────────────────────────────────

describe('permission changes take effect on a live session', () => {
  test('a revoked permission refuses the next write immediately and closes the mailbox ([CLOSED])', async (t) => {
    const { client, db } = await login(t);
    await client.cmd(`SELECT ${TEAM}`);
    db.sharedPerms = db.sharedPerms.filter((p) => !(p.userId === 'u1' && p.sharedMailboxId === 's1'));
    // Writes re-read the permission without the cache.
    const r = await client.cmd('STORE 1 +FLAGS (\\Flagged)');
    assert.ok(r.lines.includes('* OK [CLOSED] Access to the selected mailbox was revoked'), r.raw);
    assert.match(r.tagged, /NO \[NOPERM\]/);
    assert.deepEqual(db.msg('m-team-1').flags, ['\\Seen']);
    // The mailbox is closed: further message commands do not reach it.
    const f = await client.cmd('FETCH 1 (FLAGS)');
    assert.equal(f.status, 'NO');
    assert.match((await client.cmd(`SELECT ${TEAM}`)).tagged, /NO \[NONEXISTENT\]/);
    assert.match((await client.cmd(`STATUS ${TEAM} (MESSAGES)`)).tagged, /NO \[NONEXISTENT\]/);
  });

  test('reads see a revocation once the cache expires (≤ 30 s) or is invalidated', async (t) => {
    const { client, db } = await login(t);
    await client.cmd(`SELECT ${ALICE}`);
    db.delegates = db.delegates.filter((d) => d.mailboxId !== 'mb-alice');
    invalidateAccessCaches(); // what an auth invalidation event / the 30 s expiry does
    const r = await client.cmd('UID FETCH 1 (FLAGS)');
    assert.ok(r.lines.includes('* OK [CLOSED] Access to the selected mailbox was revoked'), r.raw);
    assert.match(r.tagged, /NO \[NOPERM\]/);
    assert.equal(untagged(r, /FETCH/).length, 0);
    assert.match((await client.cmd('CLOSE')).tagged, /OK|NO/);
  });

  test('a cache lifetime of 0 re-reads the permission on every command', async (t) => {
    const saved = namespaceConfig();
    setNamespaceConfig({ ...saved, cacheMs: 0 });
    t.after(() => setNamespaceConfig(saved));
    const { client, db } = await login(t);
    await client.cmd(`SELECT ${TEAM}`);
    const reads = db.accessReads;
    await client.cmd('NOOP');
    await client.cmd('FETCH 1 (FLAGS)');
    assert.ok(db.accessReads >= reads + 2, `${db.accessReads} vs ${reads}`);
  });

  test('a downgrade to READ_ONLY makes the selected mailbox read-only (NOPERM on writes)', async (t) => {
    const { client, db } = await login(t);
    await client.cmd(`SELECT ${TEAM}`);
    db.sharedPerms = db.sharedPerms.map((p) => (p.userId === 'u1' && p.sharedMailboxId === 's1' && p.permission === 'FULL_ACCESS' ? { ...p, permission: 'READ_ONLY' } : p));
    assert.match((await client.cmd('UID STORE 2 +FLAGS (\\Seen)')).tagged, /NO \[NOPERM\]/);
    assert.deepEqual(db.msg('m-team-2').flags, []);
    assert.match((await client.cmd('EXPUNGE')).tagged, /NO \[NOPERM\]/);
    // Reading keeps working; \Seen is not set implicitly any more.
    const f = await client.cmd('FETCH 2 BODY[]');
    assert.equal(f.status, 'OK', f.tagged);
    assert.deepEqual(db.msg('m-team-2').flags, []);
  });

  test('a revocation during IDLE closes the mailbox on the next check', async (t) => {
    setIdlePollInterval(60_000);
    const { client, db } = await login(t);
    await client.cmd(`SELECT ${TEAM}`);
    client.write('I1 IDLE\r\n');
    assert.match(await client.line(), /^\+ /);
    await new Promise((r) => setTimeout(r, 50)); // the initial IDLE check has finished
    db.sharedPerms = [];
    invalidateAccessCaches();
    const m = db.deliver('f-team-inbox', 'after revoke');
    (db as unknown as { emit: (e: Row) => void }).emit({ userId: 'x', folderId: 'f-team-inbox', messageId: m.id, uid: m.uid, subject: 'x' });
    assert.equal(await client.line(), '* OK [CLOSED] Access to the selected mailbox was revoked');
    client.write('DONE\r\n');
    assert.match(await client.line(), /^I1 OK/);
  });

  test('a permission-change event closes a revoked read-only folder during IDLE at once', async (t) => {
    setIdlePollInterval(60_000);
    const { client, db } = await login(t);
    assert.equal((await client.cmd(`EXAMINE ${RO}`)).status, 'OK');
    client.write('I2 IDLE\r\n');
    assert.match(await client.line(), /^\+ /);
    await new Promise((r) => setTimeout(r, 50));
    db.sharedPerms = db.sharedPerms.filter((p) => !(p.userId === 'u1' && p.sharedMailboxId === 's2'));
    // Another user's event changes nothing for bob's session …
    applyAuthInvalidation({ userId: 'u2' });
    await assert.rejects(client.line(200), /timeout/);
    // … bob's own (what publishUserAuthChange(granteeId, 'permission-change') delivers) closes it, no new mail needed.
    applyAuthInvalidation({ userId: 'u1' });
    assert.equal(await client.line(), '* OK [CLOSED] Access to the selected mailbox was revoked');
    client.write('DONE\r\n');
    assert.match(await client.line(), /^I2 OK/);
  });

  test('a permission-change event: the next command of a non-idle session gets [CLOSED]', async (t) => {
    const { client, db } = await login(t);
    assert.equal((await client.cmd(`EXAMINE ${RO}`)).status, 'OK');
    assert.equal((await client.cmd('NOOP')).status, 'OK'); // cache warm
    db.sharedPerms = db.sharedPerms.filter((p) => !(p.userId === 'u1' && p.sharedMailboxId === 's2'));
    applyAuthInvalidation({ userId: 'u1' });
    const r = await client.cmd('FETCH 1 (FLAGS)');
    assert.ok(r.lines.includes('* OK [CLOSED] Access to the selected mailbox was revoked'), r.raw);
    assert.match(r.tagged, /NO \[NOPERM\]/);
  });
});

// ─── 9.4 auto-mapping and mailbox access audit ──────────────────────────────

type AuditEvent = { action: string; source: string; actorId: string; target: { kind: string; sharedMailboxId: string | null; mailboxId: string }; changes?: Record<string, unknown> };
const auditLog = (): AuditEvent[] => ((globalThis as unknown as { __coremailTest: { accessAudit?: AuditEvent[] } }).__coremailTest.accessAudit ??= []);

describe('9.4: auto-mapping and the mailbox access audit', () => {
  test('a grant without auto-mapping is not listed until the user adds it; SELECT works regardless', async (t) => {
    const { client, db } = await login(t);
    db.sharedPerms.find((p) => p.sharedMailboxId === 's2')!.autoMap = false;
    invalidateAccessCaches();
    let r = await client.cmd('LIST "" "*"');
    assert.equal(untagged(r, /ro@example.test/).length, 0, r.raw);
    assert.ok(untagged(r, /team@example.test/).length > 0, 'auto-mapped ones stay');
    assert.equal((await client.cmd(`EXAMINE ${RO}`)).status, 'OK', 'access does not depend on the listing');
    db.added = ['shared:s2'];
    invalidateAccessCaches();
    r = await client.cmd('LIST "" "*"');
    assert.ok(untagged(r, /"Shared\/ro@example.test\/INBOX"$/).length === 1, r.raw);
  });

  test('SELECT, EXPUNGE, MOVE and folder changes in foreign mailboxes are audited; the own mailbox is not', async (t) => {
    const { client } = await login(t);
    auditLog().length = 0;
    await client.cmd('SELECT INBOX');
    assert.equal(auditLog().length, 0, 'own mailbox');
    await client.cmd(`SELECT ${TEAM}`);
    const open = auditLog().find((e) => e.action === 'mailbox.foreign.open');
    assert.deepEqual([open?.source, open?.actorId, open?.target.kind, open?.target.sharedMailboxId, open?.target.mailboxId], ['imap', 'u1', 'shared', 's1', 'mb-team']);
    await client.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');
    await client.cmd('EXPUNGE');
    const del = auditLog().find((e) => e.action === 'mailbox.foreign.message.delete');
    assert.equal(del?.changes?.['count'], 1);
    await client.cmd('MOVE 1 INBOX');
    assert.equal(auditLog().find((e) => e.action === 'mailbox.foreign.message.move')?.changes?.['count'], 1);
    await client.cmd('CREATE "Other Users/alice@example.test/Audit"');
    const created = auditLog().find((e) => e.action === 'mailbox.foreign.folder.create');
    assert.deepEqual([created?.target.kind, created?.target.mailboxId], ['delegated', 'mb-alice']);
    await client.cmd('RENAME "Other Users/alice@example.test/Audit" "Other Users/alice@example.test/Audit2"');
    await client.cmd('DELETE "Other Users/alice@example.test/Audit2"');
    assert.ok(auditLog().some((e) => e.action === 'mailbox.foreign.folder.update'));
    assert.ok(auditLog().some((e) => e.action === 'mailbox.foreign.folder.delete'));
  });
});
