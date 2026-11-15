/**
 * ActiveSync Sync delta selection on the mailbox modSeq counter (sync-window.ts).
 * In-memory stand-in for the two Prisma calls; writers are simulated the way the
 * message store performs them (modSeq = ++mailbox.highestModSeq).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSyncWindow, parseSyncKey, isPrimingSyncKey, PRIMING_SYNC_KEY, estimateSyncWindow, parseWindowSize,
  SYNC_WINDOW_SIZE, MAX_WINDOW_SIZE, type SyncMessageRow, type SyncWindowDb,
} from './sync-window.js';

interface Msg extends SyncMessageRow { folderId: string; deletedAt: Date | null }
let mailbox = { id: 'mb1', highestModSeq: 0n };
let messages: Msg[] = [];

function inRange(v: bigint, c: unknown): boolean {
  if (typeof c === 'bigint') return v === c;
  const o = c as { gte?: bigint; lt?: bigint };
  return (o.gte === undefined || v >= o.gte) && (o.lt === undefined || v < o.lt);
}
const db: SyncWindowDb = {
  mailbox: { findUnique: async () => ({ highestModSeq: mailbox.highestModSeq }) },
  message: {
    findMany: async ({ where, take }) => {
      const rows = messages
        .filter((m) => m.folderId === where['folderId'] && m.deletedAt === null && inRange(m.modSeq, where['modSeq']))
        .sort((a, b) => (a.modSeq === b.modSeq ? a.id.localeCompare(b.id) : a.modSeq < b.modSeq ? -1 : 1));
      return take === undefined ? rows : rows.slice(0, take);
    },
  },
};

/** SMTP delivery through the message store. */
function deliver(id: string, folderId = 'inbox'): Msg {
  mailbox.highestModSeq += 1n;
  const m: Msg = {
    id, folderId, deletedAt: null, modSeq: mailbox.highestModSeq, flags: [], subject: id,
    fromAddr: 'a@b.de', toAddrs: [], date: new Date(), bodyText: '', bodyHtml: '',
    fromName: '', ccAddrs: [], replyTo: null, messageId: null, inReplyTo: null, threadId: null,
    storagePath: null, smimeMeta: null,
  };
  messages.push(m);
  return m;
}
/** Flag change through the message store (setFlags). */
function markSeen(id: string): void {
  mailbox.highestModSeq += 1n;
  const m = messages.find((x) => x.id === id)!;
  m.flags = ['\\Seen'];
  m.modSeq = mailbox.highestModSeq;
}
const sync = (key: string | undefined, windowSize?: number) =>
  loadSyncWindow(db, { mailboxId: 'mb1', folderId: 'inbox', clientSyncKey: key, ...(windowSize ? { windowSize } : {}) });
const ids = (w: Awaited<ReturnType<typeof sync>>): string[] => (w.status === 'ok' ? w.messages.map((m) => m.id) : []);

beforeEach(() => {
  mailbox = { id: 'mb1', highestModSeq: 0n };
  messages = [];
});

test('initial sync (SyncKey 0) returns everything and a counter-based key', async () => {
  deliver('m1'); deliver('m2');
  const w = await sync('0');
  assert.equal(w.status, 'ok');
  assert.deepEqual(ids(w), ['m1', 'm2']);
  assert.equal(w.status === 'ok' && w.newSyncKey, '3');
});

test('incremental sync delivers mail that arrived after the last sync key', async () => {
  deliver('m1');
  const first = await sync('0');
  assert.equal(first.status, 'ok');
  const key = first.status === 'ok' ? first.newSyncKey : '';

  deliver('m2');                                   // SMTP delivery after the last Sync
  const second = await sync(key);
  assert.deepEqual(ids(second), ['m2'], 'new mail was not part of the delta');

  const key2 = second.status === 'ok' ? second.newSyncKey : '';
  const third = await sync(key2);
  assert.deepEqual(ids(third), [], 'already delivered mail sent again');
});

test('a flag change by another client (IMAP STORE / JMAP) shows up in the delta', async () => {
  deliver('m1'); deliver('m2');
  const w = await sync('0');
  markSeen('m1');
  const d = await sync(w.status === 'ok' ? w.newSyncKey : '');
  assert.deepEqual(ids(d), ['m1']);
});

test('windowing pages by modSeq with MoreAvailable and loses nothing', async () => {
  for (let i = 1; i <= 7; i++) deliver(`m${i}`);
  const seen: string[] = [];
  let key = '0';
  for (let round = 0; round < 10; round++) {
    const w = await sync(key, 3);
    assert.equal(w.status, 'ok');
    if (w.status !== 'ok') break;
    seen.push(...w.messages.map((m) => m.id));
    key = w.newSyncKey;
    if (!w.moreAvailable) break;
  }
  assert.deepEqual(seen, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
});

test('messages sharing one modSeq are never split across windows', async () => {
  deliver('m1');
  deliver('g1'); deliver('g2'); deliver('g3');
  // one COPY/STORE gave g1..g3 the same modSeq
  for (const m of messages.filter((x) => x.id.startsWith('g'))) m.modSeq = mailbox.highestModSeq;
  const w1 = await sync('0', 2);
  assert.deepEqual(ids(w1), ['m1']);
  const w2 = await sync(w1.status === 'ok' ? w1.newSyncKey : '', 2);
  assert.deepEqual(ids(w2).sort(), ['g1', 'g2', 'g3']);
});

test('legacy Date.now() sync keys and garbage are rejected as invalid (Status 3)', async () => {
  deliver('m1');
  assert.equal((await sync(String(Date.now()))).status, 'invalid');
  assert.equal((await sync('abc')).status, 'invalid');
  assert.deepEqual(parseSyncKey(undefined, 5n), { kind: 'delta', since: 0n });
  assert.deepEqual(parseSyncKey('5', 5n), { kind: 'delta', since: 5n });
});

// Regression (e2e 7.0.0): the SyncKey-0 response must not carry items ([MS-ASCMD]
// 2.2.3.166.4) — handleSync answers with PRIMING_SYNC_KEY, and the client's next
// Sync with that key must return the WHOLE folder (nothing lost by priming).
test('priming key: SyncKey 0 is a priming request; the priming key returns every message', async () => {
  assert.ok(isPrimingSyncKey('0') && isPrimingSyncKey('') && isPrimingSyncKey(undefined));
  assert.ok(!isPrimingSyncKey(PRIMING_SYNC_KEY));
  deliver('m1'); deliver('m2'); markSeen('m1'); deliver('m3');
  const w = await sync(PRIMING_SYNC_KEY);
  assert.deepEqual(ids(w).sort(), ['m1', 'm2', 'm3']);
});

// GetItemEstimate counts the same range the Sync window delivers (over all windows).
const estDb = {
  mailbox: db.mailbox,
  message: { count: async ({ where }: { where: Record<string, unknown> }) => (await db.message.findMany({ where, select: {} })).length },
};
const estimate = (key: string | undefined) => estimateSyncWindow(estDb, { mailboxId: 'mb1', folderId: 'inbox', clientSyncKey: key });

test('GetItemEstimate: equals the number of items the Sync windows deliver for the same key', async () => {
  for (let i = 1; i <= 7; i++) deliver(`m${i}`);
  deliver('other', 'sent');
  assert.deepEqual(await estimate(PRIMING_SYNC_KEY), { status: 'ok', estimate: 7 });
  let key = PRIMING_SYNC_KEY; let total = 0;
  for (let round = 0; round < 10; round++) {
    const w = await sync(key, 3);
    if (w.status !== 'ok') break;
    total += w.messages.length;
    const e = await estimate(w.newSyncKey);
    assert.equal(e.status === 'ok' && e.estimate, 7 - total, `after ${total} delivered`);
    key = w.newSyncKey;
    if (!w.moreAvailable) break;
  }
  assert.equal(total, 7);
  markSeen('m2'); deliver('m8');
  assert.deepEqual(await estimate(key), { status: 'ok', estimate: 2 });
});

test('GetItemEstimate: SyncKey 0 → not primed, garbage / future keys → invalid', async () => {
  deliver('m1');
  assert.deepEqual(await estimate('0'), { status: 'not-primed' });
  assert.deepEqual(await estimate(undefined), { status: 'not-primed' });
  assert.deepEqual(await estimate('abc'), { status: 'invalid' });
  assert.deepEqual(await estimate(String(Date.now())), { status: 'invalid' });
});

test('WindowSize parsing: default, cap, garbage', () => {
  assert.equal(parseWindowSize(undefined), SYNC_WINDOW_SIZE);
  assert.equal(parseWindowSize('100'), 100);
  assert.equal(parseWindowSize('100000'), MAX_WINDOW_SIZE);
  assert.equal(parseWindowSize('0'), SYNC_WINDOW_SIZE);
  assert.equal(parseWindowSize('x'), SYNC_WINDOW_SIZE);
});
