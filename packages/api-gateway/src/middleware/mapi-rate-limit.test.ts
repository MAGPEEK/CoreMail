/**
 * 9.4 lead decision: /mapi (classic Outlook, chatty, often many clients behind
 * one NAT address) is not counted by the per-IP general limiter — the MAPI
 * server limits per authenticated account. Every other path keeps the limit.
 * Run: node --import tsx --test --test-force-exit src/middleware/mapi-rate-limit.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
const express = (await import('express')).default;
const { generalRateLimit, isMapiPath } = await import('./security.js');

const app = express();
// The limiter exempts loopback peers; present the test requests as a public client.
app.use((req, _res, next) => {
  Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.7', configurable: true });
  next();
});
app.use(generalRateLimit);
app.all('*', (_req, res) => { res.status(204).end(); });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('isMapiPath: /mapi and below, any case; nothing else', () => {
  for (const p of ['/mapi', '/mapi/', '/mapi/emsmdb/', '/MAPI/nspi', '/Mapi/emsmdb']) assert.equal(isMapiPath(p), true, p);
  for (const p of ['/mapiX', '/api/v1/mapi', '/owa/mapi', '/', '/map']) assert.equal(isMapiPath(p), false, p);
});

test('the per-IP general limit does not count /mapi requests, other paths still hit it', async () => {
  for (let i = 0; i < 520; i++) {
    const r = await fetch(`${base}/mapi/emsmdb/`, { method: 'POST' });
    assert.equal(r.status, 204, `mapi request #${i + 1}`);
  }
  const codes: number[] = [];
  for (let i = 0; i < 501; i++) codes.push((await fetch(`${base}/api/v1/ping`)).status);
  assert.deepEqual(codes.slice(0, 500), Array(500).fill(204));
  assert.equal(codes[500], 429, 'request 501 on another path is limited');
  assert.equal((await fetch(`${base}/mapi/nspi/`, { method: 'POST' })).status, 204, '/mapi stays open while the IP is limited');
});
