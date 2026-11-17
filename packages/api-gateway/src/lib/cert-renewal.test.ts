/**
 * Renewal guards: per-certificate lock (no concurrent renewals), backoff
 * bookkeeping, and the ACME timeout really cancelling the work (no late write
 * over the ERROR state, lock released only after the work settled).
 * No network, no real Redis, no DB (Prisma via the globalThis.__prisma seam).
 * Run: node --import tsx --test src/lib/cert-renewal.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  certificate: {
    findUnique: async () => ({ acmeAccount: null }),
    update: async (args: { where: unknown; data: Record<string, unknown> }) => { updates.push(args); return {}; },
  },
};

const { acquireRenewLock, releaseRenewLock, isRenewLockHeld, getBackoff, recordRenewFailure, clearBackoff } =
  await import('./cert-renewal.js');
const { runAcmeIssuance, AcmeTimeoutError } = await import('./cert-acme.js');

/** In-memory ioredis subset (SET NX PX, GET, DEL, EXISTS, SETEX, compare-and-delete EVAL). */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(k: string, v: string, _px: 'PX', _ttl: number, _nx: 'NX') {
      if (store.has(k)) return null;
      store.set(k, v);
      return 'OK' as const;
    },
    async get(k: string) { return store.get(k) ?? null; },
    async setex(k: string, _s: number, v: string) { store.set(k, v); return 'OK'; },
    async del(k: string) { return store.delete(k) ? 1 : 0; },
    async exists(k: string) { return store.has(k) ? 1 : 0; },
    async eval(_script: string, _n: number, key: string, token: string) {
      if (store.get(key) === token) { store.delete(key); return 1; }
      return 0;
    },
  };
}

test('per-certificate lock: second acquire fails until the owner releases', async () => {
  const r = fakeRedis();
  const t1 = await acquireRenewLock(r, 'cert-1');
  assert.ok(t1);
  assert.equal(await acquireRenewLock(r, 'cert-1'), null);
  assert.equal(await isRenewLockHeld(r, 'cert-1'), true);
  // another cert is independent
  assert.ok(await acquireRenewLock(r, 'cert-2'));

  // a foreign token cannot release the lock
  await releaseRenewLock(r, 'cert-1', 'not-the-owner');
  assert.equal(await isRenewLockHeld(r, 'cert-1'), true);

  await releaseRenewLock(r, 'cert-1', t1);
  assert.equal(await isRenewLockHeld(r, 'cert-1'), false);
  assert.ok(await acquireRenewLock(r, 'cert-1'));
});

test('backoff state counts consecutive failures and is cleared on success', async () => {
  const r = fakeRedis();
  assert.equal(await getBackoff(r, 'c'), null);
  await recordRenewFailure(r, 'c', 1000);
  const b = await recordRenewFailure(r, 'c', 2000);
  assert.deepEqual(b, { failures: 2, lastFailureAt: 2000 });
  assert.deepEqual(await getBackoff(r, 'c'), { failures: 2, lastFailureAt: 2000 });
  await clearBackoff(r, 'c');
  assert.equal(await getBackoff(r, 'c'), null);
});

test('ACME timeout cancels the work: ERROR recorded once, no late success write, onSettled after the work stopped', async () => {
  updates.length = 0;
  let settled = false;
  await assert.rejects(
    runAcmeIssuance('cert-t', ['mail.example.com'], 'admin@example.com', true, true, {
      isRenewal: true,
      timeoutMs: 1,
      onSettled: () => { settled = true; },
    }),
    (err: unknown) => err instanceof AcmeTimeoutError,
  );
  // wait for the background work to observe the abort and settle
  for (let i = 0; i < 200 && !settled; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(settled, true, 'onSettled must fire once the cancelled work ended');

  const statusWrites = updates.filter(u => 'status' in u.data);
  assert.deepEqual(statusWrites.map(u => u.data['status']), ['ERROR'], 'only the timeout ERROR — the cancelled work must not write');
  assert.match(String(statusWrites[0]!.data['lastError']), /ACME timeout/);
  assert.equal(statusWrites[0]!.data['lastErrorCode'], 'timeout');
});
