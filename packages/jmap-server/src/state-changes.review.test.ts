/**
 * Review tests for state strings, Email/changes, Thread/*, Email/query sort and
 * Principal/query against an in-memory Prisma stand-in.
 *
 * Seam: @coremail/storage exports `prisma = globalThis.__prisma ?? new PrismaClient()`
 * (packages/storage/src/prisma/index.ts:21). We install a fake on globalThis.__prisma
 * BEFORE dynamically importing any module that loads @coremail/storage. No DB/Redis used:
 * only methods without Redis side effects are exercised.
 *
 * Writes by other CoreMail components are simulated exactly as their code performs them:
 *   IMAP STORE  → message.modSeq += 1, nothing else      (imap-server/src/commands/index.ts:1207-1210)
 *   IMAP MOVE   → message.folderId = target, nothing else (imap-server/src/commands/index.ts:603-606)
 *   SMTP/JMAP create → mailbox.highestModSeq += 1, message.modSeq = that, createdAt = now|receivedAt
 *                 (jmap-server/src/mail/write.ts:28-58)
 *   JMAP update → message.modSeq = Date.now()            (jmap-server/src/mail/write.ts:111)
 *   JMAP destroy → hard delete                            (jmap-server/src/mail/write.ts:134)
 *
 * Tests named "BUG:" are expected to FAIL against the current code.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal Prisma stand-in ────────────────────────────────────────────────

type Row = Record<string, unknown>;
interface Db { mailboxes: Row[]; folders: Row[]; messages: Row[]; users: Row[]; sharedMailboxes: Row[] }
const db: Db = { mailboxes: [], folders: [], messages: [], users: [], sharedMailboxes: [] };

const OPS = new Set(['gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'not', 'has', 'hasSome', 'contains', 'mode', 'equals']);
const cmpVal = (v: unknown): number | bigint | string => (v instanceof Date ? v.getTime() : (v as number | bigint | string));
function cmp(a: unknown, b: unknown): number {
  const x = cmpVal(a); const y = cmpVal(b);
  if (typeof x === 'bigint' || typeof y === 'bigint') { const bx = BigInt(x as never); const by = BigInt(y as never); return bx < by ? -1 : bx > by ? 1 : 0; }
  return x < y ? -1 : x > y ? 1 : 0;
}
function isOpObject(v: unknown): v is Row {
  return !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => OPS.has(k));
}
function matchField(value: unknown, cond: unknown): boolean {
  if (!isOpObject(cond)) return value === cond || (value instanceof Date && cond instanceof Date && value.getTime() === cond.getTime());
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case 'gt': if (!(value !== null && cmp(value, arg) > 0)) return false; break;
      case 'gte': if (!(value !== null && cmp(value, arg) >= 0)) return false; break;
      case 'lt': if (!(value !== null && cmp(value, arg) < 0)) return false; break;
      case 'lte': if (!(value !== null && cmp(value, arg) <= 0)) return false; break;
      case 'in': if (!(arg as unknown[]).includes(value)) return false; break;
      case 'notIn': if ((arg as unknown[]).includes(value)) return false; break;
      case 'not': if (matchField(value, arg)) return false; break;
      case 'equals': if (value !== arg) return false; break;
      case 'has': if (!(value as unknown[]).includes(arg)) return false; break;
      case 'hasSome': if (!(value as unknown[]).some((x) => (arg as unknown[]).includes(x))) return false; break;
      case 'contains': {
        const ci = (cond as Row)['mode'] === 'insensitive';
        const hay = String(value ?? ''); const needle = String(arg);
        if (!(ci ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle))) return false;
        break;
      }
      case 'mode': break;
    }
  }
  return true;
}
function match(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') { if (!(Array.isArray(v) ? v : [v]).every((w) => match(row, w as Row))) return false; continue; }
    if (k === 'OR') { if (!(v as Row[]).some((w) => match(row, w))) return false; continue; }
    if (k === 'NOT') { if ((Array.isArray(v) ? v : [v]).some((w) => match(row, w as Row))) return false; continue; }
    if (k === 'folder') { const f = db.folders.find((x) => x['id'] === row['folderId']); if (!f || !match(f, v as Row)) return false; continue; }
    if (k === 'attachments') continue;
    if (!matchField(row[k], v)) return false;
  }
  return true;
}
function order(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, 'asc' | 'desc'>>;
  return [...rows].sort((a, b) => {
    for (const s of specs) {
      const [f, dir] = Object.entries(s)[0]!;
      const r = cmp(a[f], b[f]);
      if (r) return dir === 'desc' ? -r : r;
    }
    return 0;
  });
}
function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Row)) row[k] = (row[k] as bigint) + BigInt((v as Row)['increment'] as number);
    else row[k] = v;
  }
}
function model(table: () => Row[], extra: (r: Row) => Row = (r) => r) {
  return {
    findMany: async (a: Row = {}) => {
      const rows = order(table().filter((r) => match(r, a['where'] as Row)), a['orderBy']);
      return rows.slice(0, typeof a['take'] === 'number' ? a['take'] : undefined).map((r) => extra({ ...r }));
    },
    findFirst: async (a: Row = {}) => {
      const r = order(table().filter((x) => match(x, a['where'] as Row)), a['orderBy'])[0];
      return r ? extra({ ...r }) : null;
    },
    findUnique: async (a: Row) => { const r = table().find((x) => match(x, a['where'] as Row)); return r ? extra({ ...r }) : null; },
    update: async (a: Row) => {
      const r = table().find((x) => match(x, a['where'] as Row));
      if (!r) throw new Error('not found');
      applyData(r, a['data'] as Row);
      return extra({ ...r });
    },
    aggregate: async (a: Row) => {
      const rows = table().filter((r) => match(r, a['where'] as Row));
      const max: Row = {};
      for (const f of Object.keys((a['_max'] ?? {}) as Row)) {
        max[f] = rows.length ? rows.map((r) => r[f]).reduce((p, c) => (cmp(c, p) > 0 ? c : p)) : null;
      }
      return { _max: max, _count: { _all: rows.length } };
    },
  };
}
const fakePrisma = {
  $on: () => undefined,
  mailbox: model(() => db.mailboxes),
  folder: model(() => db.folders),
  message: model(() => db.messages, (r) => ({ attachments: [], ...r })),
  user: model(() => db.users),
  sharedMailbox: model(() => db.sharedMailboxes),
};
(globalThis as Record<string, unknown>)['__prisma'] = fakePrisma;

// ── Modules under test (loaded after the seam is in place) ─────────────────

const { parseRequest, processRequest } = await import('./dispatcher.js');
const { CAP_CORE, CAP_MAIL, CAP_PRINCIPALS } = await import('./capabilities.js');
const { emailState } = await import('./state.js');
await import('./methods/email.js');
await import('./methods/thread.js');
await import('./methods/principal.js');
type AccountContext = import('./types.js').AccountContext;
type JsonObject = import('./types.js').JsonObject;

const user = { userId: 'u1', email: 'a@b.de', displayName: 'A', domainId: 'd', role: 'USER' };
const acc: AccountContext = {
  accountId: 'u1', mailboxId: 'mbx1', ownerUserId: 'u1', sharedMailboxId: null, name: 'A', email: 'a@b.de',
  readOnly: false, isPersonal: true, maySend: true,
};
const accounts = new Map([['u1', acc]]);

async function call(name: string, args: JsonObject): Promise<[string, JsonObject]> {
  const req = parseRequest({ using: [CAP_CORE, CAP_MAIL, CAP_PRINCIPALS], methodCalls: [[name, { accountId: 'u1', ...args }, 'c0']] });
  const res = await processRequest(req, user, accounts, 's');
  const [n, a] = res.methodResponses[0]!;
  return [n, a];
}

// ── Fixture + simulated writers ───────────────────────────────────────────

let clock = Date.parse('2026-11-01T10:00:00Z');
const tick = (ms = 1000): Date => new Date((clock += ms));

function reset(): void {
  clock = Date.parse('2026-11-01T10:00:00Z');
  db.mailboxes = [{ id: 'mbx1', highestModSeq: 0n, uidNext: 1 }];
  db.folders = [
    { id: 'inbox', mailboxId: 'mbx1', name: 'INBOX', parentId: null },
    { id: 'archive', mailboxId: 'mbx1', name: 'Archive', parentId: null },
  ];
  db.messages = [];
  db.users = [];
  db.sharedMailboxes = [];
}

function smtpDeliver(id: string, extra: Row = {}, receivedAt?: Date): Row {
  const mbx = db.mailboxes[0]!;
  mbx['highestModSeq'] = (mbx['highestModSeq'] as bigint) + 1n;
  const row: Row = {
    id, folderId: 'inbox', modSeq: mbx['highestModSeq'], createdAt: receivedAt ?? tick(), deletedAt: null,
    flags: [], threadId: null, inReplyTo: null, messageId: `<${id}@x>`, subject: id, fromAddr: 'x@y.de', fromName: '',
    toAddrs: [], ccAddrs: [], bccAddrs: [], replyTo: null, date: new Date(clock), bodyText: '', bodyHtml: '', rawSize: 10, storagePath: null,
    ...extra,
  };
  db.messages.push(row);
  return row;
}
const imapStore = (id: string, flags: string[]): void => { const m = db.messages.find((r) => r['id'] === id)!; m['flags'] = flags; m['modSeq'] = (m['modSeq'] as bigint) + 1n; };
const imapMove = (id: string, folderId: string): void => { db.messages.find((r) => r['id'] === id)!['folderId'] = folderId; };
const jmapUpdate = (id: string, flags: string[]): void => { const m = db.messages.find((r) => r['id'] === id)!; m['flags'] = flags; m['modSeq'] = BigInt(tick().getTime()); };
const hardDelete = (id: string): void => { db.messages = db.messages.filter((r) => r['id'] !== id); };

// ── Email state + Email/changes (RFC 8620 §5.2) ────────────────────────────

describe('Email state + Email/changes', () => {
  beforeEach(reset);

  test('new delivery → created', async () => {
    smtpDeliver('m1');
    const s0 = await emailState('mbx1');
    smtpDeliver('m2');
    const [name, r] = await call('Email/changes', { sinceState: s0 });
    assert.equal(name, 'Email/changes');
    assert.deepEqual(r['created'], ['m2']);
    assert.deepEqual(r['updated'], []);
    assert.equal(r['oldState'], s0);
    assert.notEqual(r['newState'], s0);
  });

  test('JMAP keyword update → updated', async () => {
    smtpDeliver('m1'); smtpDeliver('m2');
    const s0 = await emailState('mbx1');
    jmapUpdate('m1', ['\\Seen']);
    const [, r] = await call('Email/changes', { sinceState: s0 });
    assert.deepEqual(r['updated'], ['m1']);
  });

  test('hard delete → cannotCalculateChanges (no tombstones, documented)', async () => {
    smtpDeliver('m1'); smtpDeliver('m2');
    const s0 = await emailState('mbx1');
    hardDelete('m1');
    const [name, r] = await call('Email/changes', { sinceState: s0 });
    assert.equal(name, 'error');
    assert.equal(r['type'], 'cannotCalculateChanges');
  });

  test('delete + new delivery in the same window → cannotCalculateChanges (count check)', async () => {
    smtpDeliver('m1'); smtpDeliver('m2');
    const s0 = await emailState('mbx1');
    hardDelete('m1'); smtpDeliver('m3');
    const [name] = await call('Email/changes', { sinceState: s0 });
    assert.equal(name, 'error');
  });

  test('garbage sinceState → cannotCalculateChanges', async () => {
    const [name, r] = await call('Email/changes', { sinceState: 'nope' });
    assert.equal(name, 'error');
    assert.equal(r['type'], 'cannotCalculateChanges');
  });

  test('BUG: IMAP STORE (\\Seen) does not change the Email state — JMAP clients never see it', async () => {
    smtpDeliver('m1'); smtpDeliver('m2');               // modSeq 1, 2; highestModSeq 2
    const s0 = await emailState('mbx1');
    imapStore('m1', ['\\Seen']);                         // modSeq 1 → 2; mailbox counter untouched
    const s1 = await emailState('mbx1');
    assert.notEqual(s1, s0, 'state string identical after a flag change');
    const [, r] = await call('Email/changes', { sinceState: s0 });
    assert.deepEqual(r['updated'], ['m1']);
  });

  test('BUG: IMAP MOVE does not change the Email state — mailboxIds change is invisible', async () => {
    smtpDeliver('m1');
    const s0 = await emailState('mbx1');
    imapMove('m1', 'archive');
    assert.notEqual(await emailState('mbx1'), s0, 'state string identical after a move');
  });

  test('BUG: Email/import with past receivedAt + destroy of another email → wrong delta instead of cannotCalculateChanges', async () => {
    smtpDeliver('m1'); smtpDeliver('m2');
    const s0 = await emailState('mbx1');
    hardDelete('m1');                                                     // Email/set destroy
    smtpDeliver('imp', {}, new Date('2020-01-01T00:00:00Z'));             // Email/import receivedAt=2020 (write.ts:57 createdAt = receivedAt)
    const [name, r] = await call('Email/changes', { sinceState: s0 });
    // Current: count check passes (2-1+1 == 2 + 0 created) → created [], updated ['imp'], destroyed [] → client keeps m1 forever.
    if (name === 'error') return; // cannotCalculateChanges would be acceptable
    assert.deepEqual(r['destroyed'], ['m1'], `delta lost the destroyed email: ${JSON.stringify(r)}`);
    assert.deepEqual(r['created'], ['imp']);
  });

  test('BUG: maxChanges exceeded → must return hasMoreChanges:true with an intermediate state (§5.2), not cannotCalculateChanges', async () => {
    smtpDeliver('m1');
    const s0 = await emailState('mbx1');
    smtpDeliver('m2'); smtpDeliver('m3'); smtpDeliver('m4');
    const [name, r] = await call('Email/changes', { sinceState: s0, maxChanges: 2 });
    assert.equal(name, 'Email/changes', `got ${name} ${JSON.stringify(r)}`);
    assert.equal(r['hasMoreChanges'], true);
  });

  test('BUG: more than 5000 updates are silently truncated with hasMoreChanges:false (email-changes.ts take:5000)', async () => {
    for (let i = 0; i < 5001; i++) smtpDeliver(`m${i}`);
    const s0 = await emailState('mbx1');
    for (let i = 0; i < 5001; i++) jmapUpdate(`m${i}`, ['\\Seen']);
    const [, r] = await call('Email/changes', { sinceState: s0 });
    const n = (r['updated'] as string[]).length;
    assert.ok(n === 5001 || r['hasMoreChanges'] === true, `updated=${n}, hasMoreChanges=${String(r['hasMoreChanges'])}`);
  });
});

// ── Thread derivation (RFC 8621 §3) ────────────────────────────────────────

describe('Thread/get + Thread/changes', () => {
  beforeEach(reset);

  test('reply is threaded via In-Reply-To once both are read', async () => {
    smtpDeliver('A', { messageId: '<A@x>' });
    smtpDeliver('B', { inReplyTo: '<A@x>' });
    const [, g] = await call('Email/get', { ids: ['A', 'B'], properties: ['threadId'] });
    const list = g['list'] as JsonObject[];
    assert.equal(list[0]!['threadId'], list[1]!['threadId']);
  });

  test('BUG: Thread/get misses replies whose threadId was not yet derived lazily', async () => {
    smtpDeliver('A', { messageId: '<A@x>' });
    await call('Email/get', { ids: ['A'], properties: ['threadId'] });   // A.threadId = 'A' persisted
    smtpDeliver('B', { inReplyTo: '<A@x>' });                             // B.threadId stays null until someone reads B
    const [, t] = await call('Thread/get', { ids: ['A'] });
    assert.deepEqual((t['list'] as JsonObject[])[0]!['emailIds'], ['A', 'B']);
  });

  test('BUG: lazy threadId assignment changes Thread membership without a state change', async () => {
    smtpDeliver('A', { messageId: '<A@x>' });
    await call('Email/get', { ids: ['A'], properties: ['threadId'] });
    smtpDeliver('B', { inReplyTo: '<A@x>' });
    const [, t0] = await call('Thread/get', { ids: ['A'] });
    await call('Email/get', { ids: ['B'], properties: ['threadId'] });   // derives B.threadId = 'A'
    const [, t1] = await call('Thread/get', { ids: ['A'] });
    const changedMembers = JSON.stringify((t0['list'] as JsonObject[])[0]) !== JSON.stringify((t1['list'] as JsonObject[])[0]);
    if (changedMembers) assert.notEqual(t1['state'], t0['state'], 'Thread A changed but Thread state did not');
  });

  test('BUG: Thread/changes reports brand-new threads in "updated" instead of "created" (RFC 8620 §5.2)', async () => {
    smtpDeliver('A');
    const s0 = await emailState('mbx1');
    smtpDeliver('N');
    const [, r] = await call('Thread/changes', { sinceState: s0 });
    assert.deepEqual(r['created'], ['N'], JSON.stringify(r));
  });

  test('QUALITY (RFC 8621 §3 suggested algorithm): parent arriving after its reply ends up in a different thread', async () => {
    smtpDeliver('B', { inReplyTo: '<A@x>' });
    await call('Email/get', { ids: ['B'], properties: ['threadId'] });   // parent unknown → B is its own root
    smtpDeliver('A', { messageId: '<A@x>' });
    const [, g] = await call('Email/get', { ids: ['A', 'B'], properties: ['threadId'] });
    const list = g['list'] as JsonObject[];
    assert.equal(list[0]!['threadId'], list[1]!['threadId']);
  });
});

// ── Sort precedence (RFC 8620 §5.5: first comparator is primary) ───────────

describe('Sort precedence', () => {
  beforeEach(reset);

  test('BUG: Email/query secondary hasKeyword comparator overrides the primary receivedAt sort', async () => {
    smtpDeliver('old', { flags: ['\\Flagged'] });
    smtpDeliver('new', { flags: [] });
    const [, r] = await call('Email/query', { sort: [{ property: 'receivedAt', isAscending: false }, { property: 'hasKeyword', keyword: '$flagged' }] });
    assert.deepEqual(r['ids'], ['new', 'old']);
  });

  test('BUG: Principal/query applies sort comparators in reverse precedence', async () => {
    db.users = [
      { id: 'p1', email: 'a@x.de', displayName: 'Zed', active: true },
      { id: 'p2', email: 'z@x.de', displayName: 'Amy', active: true },
    ];
    const [, r] = await call('Principal/query', { sort: [{ property: 'name' }, { property: 'email' }] });
    assert.deepEqual(r['ids'], ['p2', 'p1'], 'primary key must be name');
  });
});
