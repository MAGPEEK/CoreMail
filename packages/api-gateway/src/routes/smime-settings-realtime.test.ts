/**
 * 9.4 review: saving the S/MIME options reaches the user's other tabs and
 * devices live (`settings` / `security` user event); a refused save does not.
 * Prisma faked via globalThis.__prisma, realtime transport via __realtimeRedis.
 * Run: node --import tsx --test --test-force-exit src/routes/smime-settings-realtime.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const published: Array<{ channel: string; message: Row }> = [];
globalThis.__realtimeRedis = {
  publish: async (channel: string, message: string) => { published.push({ channel, message: JSON.parse(message) as Row }); },
};

installFakePrisma({
  user: { findUnique: () => ({ role: 'USER', active: true }) },
  userCertificate: { findFirst: () => null },
  smimeSettings: {
    upsert: (a) => ({ autoSign: false, autoEncrypt: false, verifyIncoming: true, decryptIncoming: true, ...(a as { update: Row }).update }),
  },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { smimeRouter } = await import('./smime.js');

const token = core.signAccessToken({ sub: 'alice', email: 'alice@ex.com', role: 'USER', domainId: 'd1', sessionId: 's-alice', mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/smime', smimeRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

const put = (body: Row) => fetch(`${base}/api/v1/smime/settings`, {
  method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
});

test('PUT /smime/settings announces a security settings event; a refused save announces nothing', async () => {
  const ok = await put({ verifyIncoming: false });
  assert.equal(ok.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  const mine = () => published.filter((p) => p.channel === core.userEventsChannel('alice')).map((p) => p.message);
  assert.deepEqual(mine(), [{ type: 'settings', action: 'update', section: 'security' }]);
  const refused = await put({ autoSign: true });   // no default signing certificate → 400
  assert.equal(refused.status, 400);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mine().length, 1);
});
