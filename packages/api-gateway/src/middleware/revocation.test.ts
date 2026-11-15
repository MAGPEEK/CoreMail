/**
 * 8.0.0 review: requireAuth consults the shared Redis revocation markers, so a
 * gateway restart or a lost invalidation event cannot revive a revoked access
 * token (previously in-process maps only). A slow Redis does not stall requests.
 * Fake Prisma, fake auth Redis, no network.
 * Run: node --import tsx --test --test-force-exit src/middleware/revocation.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma({});
const kv = new Map<string, string>();
let slow = false;
(globalThis as Record<string, unknown>)['__authRedis'] = {
  async get(k: string) {
    if (slow) await new Promise((r) => setTimeout(r, 5_000));
    return kv.get(k) ?? null;
  },
  async setex(k: string, _s: number, v: string) { kv.set(k, v); return 'OK'; },
};

const { requireAuth } = await import('./auth.js');
const { signAccessToken } = await import('@coremail/core');
const { resetRevocationLookupCache } = await import('@coremail/storage/auth');

beforeEach(() => { kv.clear(); slow = false; resetRevocationLookupCache(); });

const token = (sub: string, sessionId: string) => signAccessToken({
  sub, email: `${sub}@ex.test`, role: 'USER', domainId: 'd1', sessionId, mfaVerified: false,
});

function run(tok: string): Promise<{ status: number; body?: unknown }> {
  return new Promise((resolve) => {
    const req = { get: (h: string) => (h === 'Authorization' ? `Bearer ${tok}` : undefined), query: {} } as unknown as Request;
    const res = {
      status(code: number) { return { json: (body: unknown) => resolve({ status: code, body }) }; },
    } as unknown as Response;
    requireAuth(req, res, () => resolve({ status: 200 }));
  });
}

test('valid token without markers → next()', async () => {
  assert.equal((await run(token('u1', 's1'))).status, 200);
});

test('session revoked only in Redis (restart / lost event) → 401 SESSION_REVOKED', async () => {
  const tok = token('u2', 's2');
  kv.set('auth:revoked-session:s2', '1');
  const r = await run(tok);
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: 'Session revoked', code: 'SESSION_REVOKED' });
});

test('revoke-all mark only in Redis (e.g. deactivation by another process) → 401', async () => {
  const tok = token('u3', 's3');
  await new Promise((r) => setTimeout(r, 2));
  const now = Date.now();
  kv.set('auth:revoked:u3', JSON.stringify({ before: Math.floor(now / 1000), beforeMs: now, except: null, expires: now + 900_000 }));
  assert.equal((await run(tok)).status, 401);
  // a token issued after the mark (new login) is accepted
  await new Promise((r) => setTimeout(r, 2));
  assert.equal((await run(token('u3', 's3b'))).status, 200);
});

test('unresponsive Redis: the request is not stalled (in-process verdict after the timeout)', async () => {
  slow = true;
  const t0 = Date.now();
  assert.equal((await run(token('u4', 's4'))).status, 200);
  assert.ok(Date.now() - t0 < 3_000);
});
