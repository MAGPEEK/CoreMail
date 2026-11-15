/**
 * References header (v9.1): parsing, the column format, population on message
 * creation (raw store → storagePath cache → message store, parseRawMessage,
 * internal notifications) and the backfill (lazy per folder, background batches
 * under a Redis lock) — against the in-memory Prisma fake.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

const { emptyDb, createFake } = await import('./test-support/mailbox-fake.js');
const db = emptyDb();
const fake = createFake(db);
(globalThis as unknown as { __prisma: unknown }).__prisma = fake;

const refs = await import('./references.js');
const { parseRawMessage } = await import('./mime/index.js');
const { createRawMessageStore } = await import('./raw-message.js');
const { createMessage, copyMessages, resetMessageStoreCache } = await import('./message-store.js');
const { notifyMailboxInbox } = await import('./internal-notify.js');
const bf = await import('./references-backfill.js');
const { ObjectNotFoundError } = await import('./object-store/types.js');

const tx = fake as never;

function raw(headers: string[], body = 'Hello'): Buffer {
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`);
}

function seed(): void {
  Object.assign(db, emptyDb());
  db.mailboxes.push({ id: 'mb1', userId: 'u1', sharedBoxId: null, uidNext: 1, highestModSeq: 1n });
  db.folders.push({ id: 'inbox', mailboxId: 'mb1', name: 'INBOX', displayName: 'Inbox', totalCount: 0, unreadCount: 0 });
  db.folders.push({ id: 'arch', mailboxId: 'mb1', name: 'Archive', displayName: 'Archive', totalCount: 0, unreadCount: 0 });
  resetMessageStoreCache();
  refs.resetReferencesCache();
}

describe('parseReferences', () => {
  test('msg-id list in header order', () => {
    assert.deepEqual(refs.parseReferences('<a@x> <b@y>\r\n\t<c@z>'), ['<a@x>', '<b@y>', '<c@z>']);
    assert.deepEqual(refs.parseReferences('<a@x><b@y>'), ['<a@x>', '<b@y>']);
  });

  test('dedupe keeps the first occurrence and the order', () => {
    assert.deepEqual(refs.parseReferences('<a@x> <b@x> <a@x> <c@x> <b@x>'), ['<a@x>', '<b@x>', '<c@x>']);
  });

  test('comments, quoted strings and garbage are tolerated', () => {
    assert.deepEqual(refs.parseReferences('(comment <not@id>) <a@x> junk "q <no@id>" <b@x> (nested (c) <z@z>)'), ['<a@x>', '<b@x>']);
    assert.deepEqual(refs.parseReferences('no ids at all'), []);
    assert.deepEqual(refs.parseReferences(''), []);
    assert.deepEqual(refs.parseReferences(null), []);
    assert.deepEqual(refs.parseReferences('<> <a b@x> <ok@x> <\u0001@x> <<nested@x>>'), ['<ok@x>', '<nested@x>']);
    assert.deepEqual(refs.parseReferences('<unterminated@x <b@x>'), ['<b@x>']);
  });

  test('a msg-id broken by folding whitespace is not a msg-id; folding between ids is fine', () => {
    assert.deepEqual(refs.parseReferences('<very-long-id\r\n part@x> <b@x>'), ['<b@x>']);
    assert.deepEqual(refs.parseReferences('<a@x>\r\n <b@x>'), ['<a@x>', '<b@x>']);
  });

  test('ids longer than 998 characters are dropped', () => {
    const long = `<${'a'.repeat(997)}@x>`;
    const ok = `<${'a'.repeat(994)}@x>`;
    assert.equal(ok.length, 998);
    assert.deepEqual(refs.parseReferences(`${long} ${ok}`), [ok]);
  });

  test('cap: first id plus the last 99', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `<m${i}@x>`);
    const out = refs.parseReferences(ids.join(' '));
    assert.equal(out.length, refs.MAX_REFERENCES);
    assert.equal(out[0], '<m0@x>');
    assert.equal(out[1], '<m151@x>');
    assert.equal(out.at(-1), '<m249@x>');
  });

  test('extractReferences reads only the top-level header section', () => {
    const r = raw([
      'From: a@x', 'Subject: hi', 'References: <a@x>', '\t<b@x>', 'In-Reply-To: <b@x>',
    ], 'References: <body@x>\r\n');
    assert.deepEqual(refs.extractReferences(r), ['<a@x>', '<b@x>']);
    assert.deepEqual(refs.extractReferences(raw(['Subject: x'], 'References: <body@x>')), []);
    assert.deepEqual(refs.extractReferences(Buffer.from('references:<lf@x>\n\nbody')), ['<lf@x>']);
  });

  test('column format round trip and the In-Reply-To fallback', () => {
    assert.equal(refs.formatReferencesColumn(['<a@x>', '<b@x>', '<a@x>']), '<a@x> <b@x>');
    assert.deepEqual(refs.splitReferences('<a@x> <b@x>'), ['<a@x>', '<b@x>']);
    assert.deepEqual(refs.splitReferences(''), []);
    assert.deepEqual(refs.splitReferences(null), []);
    assert.deepEqual(refs.threadReferencesOf([], '<p@x> <q@x>'), ['<p@x>']);
    assert.deepEqual(refs.threadReferencesOf(['<a@x>'], '<p@x>'), ['<a@x>']);
    assert.deepEqual(refs.threadReferencesOf([], 'garbage'), []);
  });
});

describe('population on message creation', () => {
  beforeEach(seed);

  test('parseRawMessage returns the References list', async () => {
    const p = await parseRawMessage(raw(['From: a@x', 'Message-ID: <c@x>', 'In-Reply-To: <b@x>', 'References: <a@x> <b@x>', 'Subject: Re: x']));
    assert.deepEqual(p.references, ['<a@x>', '<b@x>']);
    const none = await parseRawMessage(raw(['From: a@x', 'Subject: x']));
    assert.deepEqual(none.references, []);
  });

  // Every writer (SMTP inbound + rule copies, submission/worker local delivery,
  // IMAP APPEND, JMAP create/import, drafts, ActiveSync Sent copy, REST Sent
  // copy, restore) does: parseRawMessage → storeRawMessage → createMessage with
  // the explicit columns and `storagePath`. The message store fills the column.
  test('a writer that passes storagePath but no references gets the column filled', async () => {
    const objects = new Map<string, Buffer>();
    const store = createRawMessageStore({
      download: async (k) => objects.get(k)!,
      upload: async (k, d) => { objects.set(k, d); },
      exists: async (k) => objects.has(k),
    });
    const r = raw(['From: a@x', 'Message-ID: <c@x>', 'References: <a@x> <b@x>', 'Subject: Re: x']);
    const parsed = await parseRawMessage(r);
    const { storagePath } = await store.storeRawMessage(r);
    const msg = await createMessage(tx, 'mb1', 'inbox', {
      flags: [], subject: parsed.subject, fromAddr: parsed.fromAddr, fromName: parsed.fromName,
      toAddrs: [], ccAddrs: [], bccAddrs: [], messageId: parsed.messageId, inReplyTo: parsed.inReplyTo,
      date: parsed.date, rawSize: r.length, storagePath,
    });
    assert.equal(msg.references, '<a@x> <b@x>');

    // Same content stored again (second recipient, object already present): still known.
    const again = await store.storeRawMessage(r);
    const second = await createMessage(tx, 'mb1', 'inbox', { flags: [], toAddrs: [], ccAddrs: [], bccAddrs: [], date: new Date(), storagePath: again.storagePath });
    assert.equal(second.references, '<a@x> <b@x>');

    // A message without References gets '' (indexed, none).
    const plain = raw(['From: a@x', 'Subject: plain']);
    const p2 = await store.storeRawMessage(plain);
    const third = await createMessage(tx, 'mb1', 'inbox', { flags: [], toAddrs: [], ccAddrs: [], bccAddrs: [], date: new Date(), storagePath: p2.storagePath });
    assert.equal(third.references, '');

    // Copies carry the column (message-store copyMessages copies every column).
    const { mapping } = await copyMessages(tx, [msg.id], 'arch');
    assert.equal(db.messages.find((m) => m['id'] === mapping[0]!.newId)!['references'], '<a@x> <b@x>');
  });

  test('explicit references win; unknown storagePath leaves the column for the backfill', async () => {
    refs.rememberReferences('raw/aa/known.eml', ['<a@x>']);
    const explicit = await createMessage(tx, 'mb1', 'inbox', { flags: [], toAddrs: [], ccAddrs: [], bccAddrs: [], date: new Date(), storagePath: 'raw/aa/known.eml', references: '<z@x>' });
    assert.equal(explicit.references, '<z@x>');
    const unknown = await createMessage(tx, 'mb1', 'inbox', { flags: [], toAddrs: [], ccAddrs: [], bccAddrs: [], date: new Date(), storagePath: 'raw/bb/other.eml' });
    assert.equal(unknown.references, undefined); // column default: null (not indexed)
  });

  test('the storagePath cache is bounded', () => {
    for (let i = 0; i < 5000; i++) refs.rememberReferences(`raw/k${i}`, [`<m${i}@x>`]);
    assert.equal(refs.cachedReferencesColumn('raw/k0'), undefined);
    assert.equal(refs.cachedReferencesColumn('raw/k4999'), '<m4999@x>');
  });

  test('internal notifications store References (default: In-Reply-To)', async () => {
    const id = await notifyMailboxInbox('mb1', { fromName: 'S', fromAddr: 's@x', subject: 'n', bodyText: 'b', inReplyTo: '<p@x>' });
    assert.equal(db.messages.find((m) => m['id'] === id)!['references'], '<p@x>');
    const id2 = await notifyMailboxInbox('mb1', { fromName: 'S', fromAddr: 's@x', subject: 'n', bodyText: 'b' });
    assert.equal(db.messages.find((m) => m['id'] === id2)!['references'], '');
    const id3 = await notifyMailboxInbox('mb1', { fromName: 'S', fromAddr: 's@x', subject: 'n', bodyText: 'b', inReplyTo: '<p@x>', references: ['<r@x>', '<p@x>'] });
    assert.equal(db.messages.find((m) => m['id'] === id3)!['references'], '<r@x> <p@x>');
  });
});

describe('backfill', () => {
  const objects = new Map<string, Buffer>();
  let reads = 0;
  const deps = {
    db: fake as never,
    readHeader: async (key: string): Promise<Buffer> => {
      reads++;
      if (key === 'raw/broken') throw new Error('store down');
      const b = objects.get(key);
      if (!b) throw new ObjectNotFoundError(key);
      return b;
    },
  };
  const legacy = (id: string, folderId: string, storagePath: string | null, createdAt = new Date('2026-01-01T00:00:00Z')): void => {
    db.messages.push({ id, folderId, uid: db.messages.length + 1, modSeq: 5n, flags: [], deletedAt: null, createdAt, storagePath });
  };

  beforeEach(() => {
    seed();
    objects.clear();
    reads = 0;
  });

  test('fills rows in batches: References, none, legacy without raw, missing object; failures stay null', async () => {
    objects.set('raw/1', raw(['References: <a@x> <b@x>']));
    objects.set('raw/2', raw(['Subject: none']));
    legacy('m1', 'inbox', 'raw/1');
    legacy('m2', 'inbox', 'raw/2');
    legacy('m3', 'inbox', null);
    legacy('m4', 'inbox', 'raw/missing');
    legacy('m5', 'inbox', 'raw/broken');
    db.messages.push({ id: 'done', folderId: 'inbox', uid: 99, modSeq: 5n, flags: [], deletedAt: null, createdAt: new Date(), storagePath: 'raw/1', references: '<kept@x>' });

    const r = await bf.backfillReferences({}, { limit: 100, deps });
    assert.deepEqual({ scanned: r.scanned, filled: r.filled, failed: r.failed, skipped: r.skipped, deferred: r.deferred, exhausted: r.exhausted },
      { scanned: 5, filled: 4, failed: 1, skipped: 0, deferred: 0, exhausted: true });
    const col = (id: string) => db.messages.find((m) => m['id'] === id)!['references'];
    assert.equal(col('m1'), '<a@x> <b@x>');
    assert.equal(col('m2'), '');
    assert.equal(col('m3'), '');
    assert.equal(col('m4'), '');
    assert.equal(col('m5'), undefined);
    assert.equal(col('done'), '<kept@x>');
    // No modSeq bump (not a client-visible change).
    assert.ok(db.messages.every((m) => m['modSeq'] === 5n));
  });

  test('batch limit and newest-first order', async () => {
    for (let i = 0; i < 7; i++) legacy(`n${i}`, 'inbox', null, new Date(Date.UTC(2026, 0, i + 1)));
    const first = await bf.backfillReferences({}, { limit: 3, deps });
    assert.equal(first.scanned, 3);
    assert.deepEqual(db.messages.filter((m) => m['references'] === '').map((m) => m['id']).sort(), ['n4', 'n5', 'n6']);
    const rest = await bf.backfillReferences({}, { limit: 100, deps });
    assert.equal(rest.scanned, 4);
    assert.equal((await bf.backfillReferences({}, { limit: 100, deps })).scanned, 0);
  });

  test('lazy THREAD backfill: only the selected folder, capped per command, returns the lists', async () => {
    objects.set('raw/1', raw(['References: <a@x>']));
    legacy('i1', 'inbox', 'raw/1');
    legacy('i2', 'inbox', null);
    legacy('i3', 'inbox', 'raw/1');
    legacy('a1', 'arch', 'raw/1');
    const map = await bf.loadThreadReferences('inbox', ['i1', 'i2', 'i3'], { limit: 2, deps });
    // Two rows indexed this command (cap), the third stays unindexed (In-Reply-To fallback).
    assert.equal(map.size, 2);
    assert.equal(db.messages.find((m) => m['id'] === 'a1')!['references'], undefined);
    const again = await bf.loadThreadReferences('inbox', ['i1', 'i2', 'i3'], { deps });
    assert.equal(again.size, 3);
    assert.deepEqual(again.get('i1'), ['<a@x>']);
    assert.deepEqual(again.get('i2'), []);
  });

  test('lazy backfill errors never fail the command', async () => {
    legacy('x1', 'inbox', 'raw/broken');
    const map = await bf.loadThreadReferences('inbox', ['x1'], { deps });
    assert.equal(map.size, 0);
  });

  test('background run takes the Redis lock and stops when done', async () => {
    for (let i = 0; i < 5; i++) legacy(`b${i}`, 'inbox', null);
    const held = new Set<string>();
    const redis = {
      set: async (key: string, _v: string, _px: 'PX', _ttl: number, _nx: 'NX'): Promise<'OK' | null> => {
        if (held.has(key)) return null;
        held.add(key);
        return 'OK';
      },
    };
    const r = await bf.runLockedReferencesBackfill(redis, { batchSize: 2, pauseMs: 0, deps });
    assert.ok(r);
    assert.equal(r.filled, 5);
    assert.equal(r.batches, 3);
    assert.equal(r.more, false);
    assert.ok(held.has(bf.REFERENCES_BACKFILL_LOCK_KEY));
    // Another instance in the same interval does nothing.
    assert.equal(await bf.runLockedReferencesBackfill(redis, { deps }), null);
  });

  test('background run stops when a batch makes no progress (unreadable objects)', async () => {
    for (let i = 0; i < 4; i++) legacy(`f${i}`, 'inbox', 'raw/broken');
    const redis = { set: async (): Promise<'OK'> => 'OK' as const };
    const r = await bf.runLockedReferencesBackfill(redis, { batchSize: 2, pauseMs: 0, maxBatches: 10, deps });
    assert.equal(r!.batches, 1);
    assert.equal(r!.failed, 2);
  });

  test('REFERENCES_BACKFILL switch (default on) and a disabled job is a no-op', () => {
    assert.equal(bf.referencesBackfillEnabled({}), true);
    assert.equal(bf.referencesBackfillEnabled({ REFERENCES_BACKFILL: 'on' }), true);
    assert.equal(bf.referencesBackfillEnabled({ REFERENCES_BACKFILL: 'off' }), false);
    assert.equal(bf.referencesBackfillEnabled({ REFERENCES_BACKFILL: 'FALSE' }), false);
    let called = false;
    const h = bf.startReferencesBackfill({ set: async () => { called = true; return 'OK' as const; } }, { env: { REFERENCES_BACKFILL: 'off' }, initialDelayMs: 0 });
    h.stop();
    assert.equal(called, false);
  });

  // ── 9.1 review fixes: starvation, lazy budget, id chunks, lock refresh ──────

  /** Fake Redis with SET NX PX, EVAL (the two lock scripts), INCR/PEXPIRE/MGET. */
  function fakeRedis() {
    const kv = new Map<string, string>();
    const calls: string[] = [];
    return {
      kv, calls,
      set: async (key: string, value: string, _px: 'PX', _ttl: number, _nx: 'NX'): Promise<'OK' | null> => {
        if (kv.has(key)) return null;
        kv.set(key, value);
        return 'OK';
      },
      eval: async (script: string, _n: number, key: string, token: string | number): Promise<number> => {
        const mine = kv.get(key) === String(token);
        if (script.includes("'pexpire'")) { calls.push('refresh'); return mine ? 1 : 0; }
        calls.push('release');
        if (mine) { kv.delete(key); return 1; }
        return 0;
      },
      incr: async (key: string): Promise<number> => { const n = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(n)); return n; },
      pexpire: async (): Promise<number> => 1,
      mget: async (...keys: string[]): Promise<Array<string | null>> => keys.map((k) => kv.get(k) ?? null),
    };
  }

  test('background: rows that keep failing do not starve older rows; failures are capped per id', async () => {
    // 4 newest rows unreadable, 6 older rows fine.
    for (let i = 0; i < 4; i++) legacy(`bad${i}`, 'inbox', 'raw/broken', new Date(Date.UTC(2026, 5, 10 + i)));
    objects.set('raw/ok', raw(['References: <o@x>']));
    for (let i = 0; i < 6; i++) legacy(`ok${i}`, 'inbox', 'raw/ok', new Date(Date.UTC(2026, 0, 1 + i)));
    const redis = fakeRedis();
    let cursor: { createdAt: Date; id: string } | null = null;
    // Run until the pass is complete: the cursor moves past the failing rows.
    for (let run = 0; run < 10; run++) {
      const r = await bf.runLockedReferencesBackfill(redis, { batchSize: 2, pauseMs: 0, deps, cursor });
      assert.ok(r);
      cursor = r.cursor;
      if (!r.more) break;
    }
    for (let i = 0; i < 6; i++) assert.equal(db.messages.find((m) => m['id'] === `ok${i}`)!['references'], '<o@x>', `ok${i}`);
    assert.equal(cursor, null, 'pass complete');
    assert.equal(redis.kv.get(bf.REFERENCES_BACKFILL_LOCK_KEY), undefined, 'lock released at the end');
    // Further passes re-read each failing object at most MAX_ATTEMPTS times in total.
    for (let pass = 0; pass < 5; pass++) await bf.runLockedReferencesBackfill(redis, { batchSize: 100, pauseMs: 0, deps });
    assert.equal(Number(redis.kv.get(`${bf.REFERENCES_BACKFILL_FAILURE_KEY_PREFIX}bad0`)), bf.REFERENCES_BACKFILL_MAX_ATTEMPTS);
    const before = reads;
    const r = await bf.runLockedReferencesBackfill(redis, { batchSize: 100, pauseMs: 0, deps });
    assert.equal(reads, before, 'no object is read again while its counter lives');
    assert.equal(r!.skipped, 4);
    // The rows themselves stay null (never written as '' — a later pass may still succeed).
    assert.equal(db.messages.find((m) => m['id'] === 'bad0')!['references'], undefined);
  });

  test('background: the lock is refreshed between batches; a lost lock stops the run and is not deleted', async () => {
    for (let i = 0; i < 6; i++) legacy(`l${i}`, 'inbox', null, new Date(Date.UTC(2026, 0, 1 + i)));
    const redis = fakeRedis();
    const r = await bf.runLockedReferencesBackfill(redis, { batchSize: 2, pauseMs: 0, deps });
    assert.equal(r!.filled, 6);
    assert.deepEqual(redis.calls, ['refresh', 'refresh', 'refresh', 'release']);
    assert.equal(redis.kv.has(bf.REFERENCES_BACKFILL_LOCK_KEY), false);

    // Another holder takes over between batches (our TTL ran out): stop, keep its lock.
    for (let i = 0; i < 4; i++) legacy(`t${i}`, 'inbox', null, new Date(Date.UTC(2025, 0, 1 + i)));
    const r2 = fakeRedis();
    const realEval = r2.eval;
    let first = true;
    r2.eval = async (script, n, key, token) => {
      if (first) { first = false; r2.kv.set(key, 'someone-else'); }
      return realEval(script, n, key, token);
    };
    const out = await bf.runLockedReferencesBackfill(r2, { batchSize: 2, pauseMs: 0, deps });
    assert.equal(out!.batches, 1);
    assert.equal(out!.stoppedForLock, true);
    assert.equal(r2.kv.get(bf.REFERENCES_BACKFILL_LOCK_KEY), 'someone-else');
  });

  test('background without EVAL stops before the lock TTL runs out', async () => {
    for (let i = 0; i < 6; i++) legacy(`e${i}`, 'inbox', null, new Date(Date.UTC(2026, 0, 1 + i)));
    const redis = { set: async (): Promise<'OK'> => 'OK' as const };
    const r = await bf.runLockedReferencesBackfill(redis, { batchSize: 2, pauseMs: 0, lockTtlMs: 2000, deps });
    assert.equal(r!.batches, 1);
    assert.equal(r!.stoppedForLock, true);
    assert.equal(r!.more, true);
    assert.ok(r!.cursor, 'continues after the cursor next time');
    const r2 = await bf.runLockedReferencesBackfill(redis, { batchSize: 2, pauseMs: 0, lockTtlMs: 2000, deps, cursor: r!.cursor });
    assert.equal(r2!.filled, 2);
    assert.equal(db.messages.filter((m) => m['references'] === '').length, 4);
  });

  test('lazy THREAD backfill: time budget and row cap; the command never waits for a hanging read', async () => {
    for (let i = 0; i < 250; i++) legacy(`c${i}`, 'inbox', null, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    await bf.loadThreadReferences('inbox', ['c0'], { deps, tracker: bf.createMemoryFailureTracker() });
    assert.equal(db.messages.filter((m) => m['references'] === '').length, bf.REFERENCES_BACKFILL_COMMAND_LIMIT, 'row cap 200');

    seed();
    legacy('h1', 'inbox', 'raw/hang');
    legacy('h2', 'inbox', 'raw/hang');
    const hanging = { db: fake as never, readHeader: (): Promise<Buffer> => new Promise<Buffer>(() => undefined) };
    const t0 = Date.now();
    const map = await bf.loadThreadReferences('inbox', ['h1', 'h2'], { deps: hanging, budgetMs: 50, tracker: bf.createMemoryFailureTracker() });
    assert.ok(Date.now() - t0 < 1000, `returned after ${Date.now() - t0} ms`);
    assert.equal(map.size, 0);
    assert.equal(bf.referencesLazyBudgetMs({}), 1500);
    assert.equal(bf.referencesLazyBudgetMs({ REFERENCES_LAZY_BUDGET_MS: '0' }), 0);
    assert.equal(bf.referencesLazyBudgetMs({ REFERENCES_LAZY_BUDGET_MS: 'x' }), 1500);
    // budget 0 = no lazy step at all
    legacy('z1', 'inbox', null);
    await bf.loadThreadReferences('inbox', ['z1'], { deps, env: { REFERENCES_LAZY_BUDGET_MS: '0' } });
    assert.equal(db.messages.find((m) => m['id'] === 'z1')!['references'], undefined);
  });

  test('lazy THREAD backfill skips ids that failed recently; older rows are still reached', async () => {
    legacy('old', 'inbox', 'raw/old', new Date('2025-01-01T00:00:00Z'));
    objects.set('raw/old', raw(['References: <q@x>']));
    legacy('bad', 'inbox', 'raw/broken', new Date('2026-06-01T00:00:00Z'));
    const tracker = bf.createMemoryFailureTracker();
    await bf.loadThreadReferences('inbox', ['bad', 'old'], { deps, tracker, limit: 1 });
    assert.equal(reads, 1, 'the newest (broken) row was tried');
    const map = await bf.loadThreadReferences('inbox', ['bad', 'old'], { deps, tracker, limit: 1 });
    assert.equal(reads, 2, 'the broken row is excluded, the older one is read');
    assert.deepEqual(map.get('old'), ['<q@x>']);
    assert.equal(map.has('bad'), false);
  });

  test('loadThreadReferences loads only the requested ids, in chunks of 1000', async () => {
    db.messages.push({ id: 'other', folderId: 'inbox', uid: 1, modSeq: 5n, flags: [], deletedAt: null, createdAt: new Date(), storagePath: null, references: '<x@x>' });
    const queries: unknown[] = [];
    const spyDb = {
      message: {
        findMany: async (a: unknown) => { queries.push(a); return (fake as unknown as { message: { findMany(a: unknown): Promise<unknown[]> } }).message.findMany(a); },
        updateMany: (a: unknown) => (fake as unknown as { message: { updateMany(a: unknown): Promise<{ count: number }> } }).message.updateMany(a),
      },
    };
    const ids = Array.from({ length: 2500 }, (_, i) => `q${i}`);
    const map = await bf.loadThreadReferences('inbox', ids, { deps: { db: spyDb, readHeader: deps.readHeader }, budgetMs: 0 });
    assert.equal(map.size, 0, '"other" is not part of the result');
    assert.equal(queries.length, 3);
    for (const q of queries) {
      const inIds = (q as { where: { id: { in: string[] } } }).where.id.in;
      assert.ok(inIds.length <= 1000);
    }
  });

  test('readHeaderSection stops at the blank line (also across chunks) and at the limit', async () => {
    let pulled = 0;
    const chunks = ['References: <a@x>\r', '\n\r\n', 'BODY'.repeat(1000)];
    const stream = new Readable({ read() { const c = chunks[pulled++]; this.push(c === undefined ? null : Buffer.from(c)); } });
    const head = await bf.readHeaderSection(stream);
    assert.equal(head.toString(), 'References: <a@x>\r\n\r\n');
    assert.deepEqual(refs.extractReferences(head), ['<a@x>']);
    const big = Readable.from([Buffer.alloc(300 * 1024, 0x61)]);
    assert.equal((await bf.readHeaderSection(big, 1024)).length, 1024);
  });
});
