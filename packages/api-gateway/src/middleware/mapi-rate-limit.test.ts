/**
 * 9.4 lead decision: /mapi (classic Outlook, chatty, often many clients behind
 * one NAT address) is not counted by the global API limiter (lib/api-rate-limit.ts) — the MAPI
 * server limits per authenticated account. Every other path keeps the limit.
 * Run: node --import tsx --test --test-force-exit src/middleware/mapi-rate-limit.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
const express = (await import('express')).default;
const { createApiRateLimit, isMapiPath, API_RATE_LIMIT_DEFAULTS } = await import('../lib/api-rate-limit.js');
const perIp = API_RATE_LIMIT_DEFAULTS.perIp;

const app = express();
// The test requests come from loopback; the limiter is told they are a public client.
app.use(createApiRateLimit({
  config: () => ({ enabled: true, windowMs: 15 * 60_000, perIp, perUser: API_RATE_LIMIT_DEFAULTS.perUser }),
  verifyUser: () => null,
  isLoopback: () => false,
}));
app.all('*', (_req, res) => { res.status(204).end(); });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('isMapiPath: /mapi and below, any case; nothing else', () => {
  for (const p of ['/mapi', '/mapi/', '/mapi/emsmdb/', '/MAPI/nspi', '/Mapi/emsmdb']) assert.equal(isMapiPath(p), true, p);
  for (const p of ['/mapiX', '/api/v1/mapi', '/owa/mapi', '/', '/map']) assert.equal(isMapiPath(p), false, p);
});

test('the per-IP API limit does not count /mapi requests, other paths still hit it', async () => {
  for (let i = 0; i < perIp + 20; i++) {
    const r = await fetch(`${base}/mapi/emsmdb/`, { method: 'POST' });
    assert.equal(r.status, 204, `mapi request #${i + 1}`);
  }
  const codes: number[] = [];
  for (let i = 0; i <= perIp; i++) codes.push((await fetch(`${base}/api/v1/ping`, { method: 'POST' })).status);
  assert.deepEqual(codes.slice(0, perIp), Array(perIp).fill(204));
  assert.equal(codes[perIp], 429, 'the request over the per-IP budget on another path is limited');
  assert.equal((await fetch(`${base}/mapi/nspi/`, { method: 'POST' })).status, 204, '/mapi stays open while the IP is limited');
});
