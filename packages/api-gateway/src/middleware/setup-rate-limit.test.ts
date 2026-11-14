/**
 * Regression (e2e 7.0.0): GET /api/v1/setup/status is called by MWA and BCP on
 * every page load and must not consume the setup attempt budget (5 POSTs/hour).
 * Run: node --import tsx --test --test-force-exit src/middleware/setup-rate-limit.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
const express = (await import('express')).default;
const { setupRateLimit } = await import('./security.js');

const app = express();
app.use('/api/v1/setup', setupRateLimit);
app.get('/api/v1/setup/status', (_req, res) => { res.json({ setupRequired: true }); });
app.post('/api/v1/setup/complete', (_req, res) => { res.status(403).json({ error: 'token' }); });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('status reads do not count against the setup limit; POST attempts still do', async () => {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${base}/api/v1/setup/status`);
    assert.equal(r.status, 200, `GET #${i + 1}`);
  }
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await fetch(`${base}/api/v1/setup/complete`, { method: 'POST' })).status);
  assert.deepEqual(codes, [403, 403, 403, 403, 403, 429]);
});
