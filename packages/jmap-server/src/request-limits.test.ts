/**
 * v8.1 JMAP limit enforcement: maxConcurrentRequests / maxConcurrentUpload,
 * upload quota, no uploads into read-only accounts, soft-deleted messages are
 * not reachable through m-/a-/p- blob ids.
 * Infra-free: Prisma via the globalThis.__prisma seam, in-memory Redis fake.
 */
import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

type Row = Record<string, unknown>;
const queries: Array<{ model: string; where: Row }> = [];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  message: {
    findFirst: async (a: { where: Row }) => { queries.push({ model: 'message', where: a.where }); return null; },
  },
  attachment: {
    findFirst: async (a: { where: Row }) => { queries.push({ model: 'attachment', where: a.where }); return null; },
  },
};

const express = (await import('express')).default;
const {
  ConcurrencyGate, concurrencyLimit, reserveUploadQuota, UploadQuotaError, uploadQuotaBytes,
} = await import('./request-limits.js');
type QuotaRedis = import('./request-limits.js').QuotaRedis;
const { createUploadRouter } = await import('./upload-route.js');
const { resolveBlob, lookupBlobReferences } = await import('./blobs.js');
const { parseRequest, processRequest } = await import('./dispatcher.js');
const { CAP_CORE, CAP_BLOB } = await import('./capabilities.js');
await import('./methods/blob.js');
type AccountContext = import('./types.js').AccountContext;
type JmapUser = import('./types.js').JmapUser;

const user: JmapUser = { userId: 'u1', email: 'a@b.de', displayName: 'A', domainId: 'd', role: 'USER' };
const account = (accountId: string, readOnly = false): AccountContext => ({
  accountId, mailboxId: `mb-${accountId}`, ownerUserId: null, sharedMailboxId: null, name: accountId, email: `${accountId}@b.de`,
  readOnly, isPersonal: !readOnly, maySend: !readOnly,
});
const fakeAuth: import('express').RequestHandler = (req, _res, next) => { (req as unknown as { jmapUser: JmapUser }).jmapUser = user; next(); };

async function serve(t: TestContext, app: import('express').Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function memoryZsetRedis(): QuotaRedis & { members(key: string): string[] } {
  const sets = new Map<string, Map<string, number>>();
  const set = (k: string) => { let s = sets.get(k); if (!s) { s = new Map(); sets.set(k, s); } return s; };
  return {
    async zremrangebyscore(k, _min, max) { const s = set(k); for (const [m, sc] of s) if (sc <= Number(max)) s.delete(m); return 0; },
    async zadd(k, score, member) { set(k).set(member, score); return 1; },
    async zrange(k) { return [...set(k).keys()]; },
    async zrem(k, member) { return set(k).delete(member) ? 1 : 0; },
    async pexpire() { return 1; },
    members(k) { return [...set(k).keys()]; },
  };
}

describe('concurrency limits', () => {
  test('ConcurrencyGate counts per key and releases idempotently', () => {
    const gate = new ConcurrencyGate();
    const a = gate.tryAcquire('u1', 2);
    const b = gate.tryAcquire('u1', 2);
    assert.ok(a && b);
    assert.equal(gate.tryAcquire('u1', 2), null);
    assert.ok(gate.tryAcquire('u2', 2), 'other users are unaffected');
    a!(); a!();
    assert.equal(gate.count('u1'), 1);
    assert.ok(gate.tryAcquire('u1', 2));
  });

  test('maxConcurrentRequests: the request above the limit gets a "limit" problem, the slot is freed afterwards', async (t) => {
    const gate = new ConcurrencyGate();
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => { unblock = r; });
    const app = express();
    app.post('/jmap/api', fakeAuth, concurrencyLimit(gate, () => 2, 'maxConcurrentRequests'), async (_req, res) => {
      await blocked;
      res.json({ ok: true });
    });
    const base = await serve(t, app);
    const first = [fetch(`${base}/jmap/api`, { method: 'POST' }), fetch(`${base}/jmap/api`, { method: 'POST' })];
    while (gate.count('u1') < 2) await new Promise((r) => setTimeout(r, 5));
    const third = await fetch(`${base}/jmap/api`, { method: 'POST' });
    assert.equal(third.status, 400);
    const body = await third.json() as Row;
    assert.equal(body['type'], 'urn:ietf:params:jmap:error:limit');
    assert.equal(body['limit'], 'maxConcurrentRequests');
    unblock();
    for (const r of await Promise.all(first)) assert.equal(r.status, 200);
    while (gate.count('u1') > 0) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await fetch(`${base}/jmap/api`, { method: 'POST' })).status, 200);
  });
});

describe('upload endpoint', () => {
  const accounts = new Map([['rw', account('rw')], ['ro', account('ro', true)]]);
  const app = (store: Parameters<typeof createUploadRouter>[0]['store'], extra: Partial<Parameters<typeof createUploadRouter>[0]> = {}) => {
    const a = express();
    a.use(createUploadRouter({ auth: fakeAuth, resolveAccounts: async () => accounts, store, ...extra }));
    return a;
  };

  test('read-only account: 403 forbidden, nothing is stored', async (t) => {
    let stored = 0;
    const base = await serve(t, app(async () => { stored++; return { blobId: 'u-1', size: 1, type: 'x' }; }));
    const r = await fetch(`${base}/jmap/upload/ro`, { method: 'POST', body: 'hello' });
    assert.equal(r.status, 403);
    assert.equal(((await r.json()) as Row)['type'], 'urn:ietf:params:jmap:error:forbidden');
    assert.equal(stored, 0);
    const ok = await fetch(`${base}/jmap/upload/rw`, { method: 'POST', body: 'hello' });
    assert.equal(ok.status, 201);
    assert.equal(stored, 1);
  });

  test('quota exceeded: 403 overQuota', async (t) => {
    const base = await serve(t, app(async () => { throw new UploadQuotaError(100, 100, false); }));
    const r = await fetch(`${base}/jmap/upload/rw`, { method: 'POST', body: 'hello' });
    assert.equal(r.status, 403);
    assert.equal(((await r.json()) as Row)['type'], 'urn:ietf:params:jmap:error:overQuota');
  });

  test('unknown account: 404 accountNotFound', async (t) => {
    const base = await serve(t, app(async () => ({ blobId: 'u-1', size: 1, type: 'x' })));
    assert.equal((await fetch(`${base}/jmap/upload/nope`, { method: 'POST', body: 'x' })).status, 404);
  });

  test('maxConcurrentUpload: an upload above the limit is refused before its body is read', async (t) => {
    const gate = new ConcurrencyGate();
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => { unblock = r; });
    const base = await serve(t, app(async (_a, data) => { await blocked; return { blobId: 'u-1', size: data.length, type: 'x' }; },
      { gate, maxConcurrentUpload: () => 1 }));
    const first = fetch(`${base}/jmap/upload/rw`, { method: 'POST', body: 'a' });
    while (gate.count('u1') < 1) await new Promise((r) => setTimeout(r, 5));
    const second = await fetch(`${base}/jmap/upload/rw`, { method: 'POST', body: 'b' });
    assert.equal(second.status, 400);
    assert.equal(((await second.json()) as Row)['limit'], 'maxConcurrentUpload');
    unblock();
    assert.equal((await first).status, 201);
  });
});

describe('upload quota', () => {
  test('reservations count live uploads; over the quota the reservation is rolled back', async () => {
    const redis = memoryZsetRedis();
    const opts = { quotaBytes: 100, maxBlobs: 0, now: 1_000 };
    await reserveUploadQuota(redis, 'acc', 'u-a', 60, opts);
    await assert.rejects(reserveUploadQuota(redis, 'acc', 'u-b', 50, opts), (e: unknown) => e instanceof UploadQuotaError && e.used === 60);
    assert.deepEqual(redis.members('jmap:upload:usage:acc'), ['u-a:60']);
    // another account has its own budget
    await reserveUploadQuota(redis, 'other', 'u-c', 90, opts);
    // a failed store frees the reservation
    const undo = await reserveUploadQuota(redis, 'acc', 'u-d', 40, opts);
    await undo();
    assert.deepEqual(redis.members('jmap:upload:usage:acc'), ['u-a:60']);
  });

  test('expired uploads (7 days) no longer count', async () => {
    const redis = memoryZsetRedis();
    await reserveUploadQuota(redis, 'acc', 'u-a', 90, { quotaBytes: 100, maxBlobs: 0, now: 0 });
    await reserveUploadQuota(redis, 'acc', 'u-b', 90, { quotaBytes: 100, maxBlobs: 0, now: 7 * 24 * 3600 * 1000 + 1 });
    assert.deepEqual(redis.members('jmap:upload:usage:acc'), ['u-b:90']);
  });

  test('the number of live uploads per account is capped', async () => {
    const redis = memoryZsetRedis();
    const opts = { quotaBytes: 0, maxBlobs: 2, now: 1 };
    await reserveUploadQuota(redis, 'acc', 'u-1', 1, opts);
    await reserveUploadQuota(redis, 'acc', 'u-2', 1, opts);
    await assert.rejects(reserveUploadQuota(redis, 'acc', 'u-3', 1, opts), (e: unknown) => e instanceof UploadQuotaError && e.blobs);
  });

  test('JMAP_UPLOAD_QUOTA_MB: default 500 MB, 0 disables', () => {
    assert.equal(uploadQuotaBytes({}), 500 * 1024 * 1024);
    assert.equal(uploadQuotaBytes({ JMAP_UPLOAD_QUOTA_MB: '0' }), 0);
    assert.equal(uploadQuotaBytes({ JMAP_UPLOAD_QUOTA_MB: '10' }), 10 * 1024 * 1024);
  });
});

describe('Blob/upload method', () => {
  test('read-only account → accountReadOnly', async () => {
    const accounts = new Map([['ro', account('ro', true)]]);
    const req = parseRequest({
      using: [CAP_CORE, CAP_BLOB],
      methodCalls: [['Blob/upload', { accountId: 'ro', create: { c1: { data: [{ 'data:asText': 'hi' }] } } }, 'c0']],
    });
    const res = await processRequest(req, user, accounts, 's');
    const [name, args] = res.methodResponses[0]!;
    assert.equal(name, 'error');
    assert.equal((args as Row)['type'], 'accountReadOnly');
  });
});

describe('blob ids of soft-deleted messages', () => {
  test('m-, a- and p- blob ids only resolve live messages', async () => {
    queries.length = 0;
    const acc = account('rw');
    assert.equal(await resolveBlob(acc, 'm-msg1'), null);
    assert.equal(await resolveBlob(acc, 'a-att1'), null);
    assert.equal(await resolveBlob(acc, 'p-msg1-text'), null);
    assert.equal(await lookupBlobReferences(acc, 'm-msg1', ['Email']), null);
    assert.equal(await lookupBlobReferences(acc, 'a-att1', ['Email']), null);
    assert.equal(await lookupBlobReferences(acc, 'p-msg1-html', ['Email']), null);
    assert.equal(queries.length, 6);
    for (const q of queries) {
      const where = q.model === 'message' ? q.where : (q.where['message'] as Row);
      assert.equal(where['deletedAt'], null, JSON.stringify(q));
    }
  });
});
