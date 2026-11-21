/**
 * 10.6: a login refused by the strict auth limiter (20 / 15 min / IP) is
 * recorded for the attack dashboard (IP_RATE_LIMIT, protocol web) — the
 * throttled web brute force stays visible on BCP → Angriffsschutz.
 * Run: node --import tsx --test --test-force-exit src/middleware/auth-rate-limit-event.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma(); // security.ts records rate-limit events through @coremail/storage (10.6)
const rows: Array<{ type: string; ip: string; protocol: string; detail: Record<string, unknown> }> = [];
(globalThis as { __securityEventSink?: unknown }).__securityEventSink = { write: async (row: (typeof rows)[number]) => { rows.push(row); } };

const express = (await import('express')).default;
const { authRouteRateLimit } = await import('./security.js');

const app = express();
app.set('trust proxy', 'loopback'); // the loopback test client names its address in X-Forwarded-For
app.use('/auth', authRouteRateLimit);
app.post('/auth/login', (_req, res) => { res.status(401).json({ error: 'Invalid credentials' }); });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('the 21st login of an address is refused with 429 and recorded as IP_RATE_LIMIT / web', async () => {
  const headers = { 'X-Forwarded-For': '203.0.113.44' };
  for (let i = 0; i < 20; i++) assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', headers })).status, 401);
  assert.equal(rows.length, 0, 'failures below the limit are recorded by the lockout, not by the limiter');
  assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', headers })).status, 429);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, 'IP_RATE_LIMIT');
  assert.equal(rows[0]!.ip, '203.0.113.44');
  assert.equal(rows[0]!.protocol, 'web');
  assert.equal(rows[0]!.detail['reason'], 'auth_rate_limit');
});
