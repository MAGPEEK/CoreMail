/**
 * Regression (v8.1 review): POST /auth/refresh is called on every page load and
 * in every new tab (memory-only access token). It must not consume the strict
 * login budget (20 / 15 min / IP), otherwise users got 429 → logout.
 * Run: node --import tsx --test --test-force-exit src/middleware/auth-rate-limit.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma(); // security.ts records rate-limit events through @coremail/storage (10.6)
const express = (await import('express')).default;
const { authRouteRateLimit } = await import('./security.js');

const app = express();
app.use('/auth', authRouteRateLimit);
app.post('/auth/refresh', (req, res) => {
  if (req.get('x-fail') === '1') { res.status(401).json({ code: 'REFRESH_INVALID' }); return; }
  res.json({ accessToken: 'a' });
});
app.post('/auth/login', (_req, res) => { res.status(401).json({ error: 'Invalid credentials' }); });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('refreshes do not count against the login limiter; login keeps the strict limit', async () => {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${base}/auth/refresh`, { method: 'POST' });
    assert.equal(r.status, 200, `refresh #${i + 1}`);
  }
  // failed refreshes have their own (generous) budget
  for (let i = 0; i < 30; i++) {
    assert.equal((await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { 'x-fail': '1' } })).status, 401);
  }
  const codes: number[] = [];
  for (let i = 0; i < 21; i++) codes.push((await fetch(`${base}/auth/login`, { method: 'POST' })).status);
  assert.deepEqual(codes, [...Array(20).fill(401), 429], 'login: 20 attempts, then 429');
  // the strict limit being reached does not block refresh
  assert.equal((await fetch(`${base}/auth/refresh`, { method: 'POST' })).status, 200);
});
