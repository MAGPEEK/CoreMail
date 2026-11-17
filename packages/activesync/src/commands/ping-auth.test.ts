/**
 * v7.1.0: an ActiveSync Ping long-poll ends with HTTP 401 (WWW-Authenticate)
 * as soon as the credentials of the request become invalid; other users'
 * Pings and Pings with another app password keep running; a Ping whose
 * credentials were checked before the change but registered after it ends too.
 * 9.4: ActiveSync switched off → the Ping ends with 403, new requests get 403
 * after correct credentials only; back to inherit → works.
 * Loopback Express app (requireAuth + handlePing), fake Prisma.
 * Run: node --import tsx --test src/commands/ping-auth.test.ts (in packages/activesync)
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Request, RequestHandler } from 'express';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';

const user = (id: string, email: string) => ({
  id, email, active: true, displayName: id, domainId: 'd1', role: 'USER',
  passwordHash: 'hash:pw', authSource: 'LOCAL', mfa: null, mailbox: null,
});
const users = [user('u1', 'bob@example.com'), user('u2', 'carol@example.com')];
let countGate: Promise<void> | null = null;
/** 9.4: ProtocolPolicy rows (protocol switches). */
const policies: Array<Record<string, unknown>> = [];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  protocolPolicy: { findMany: async () => policies, count: async () => 0 },
  serverSettings: { findUnique: async () => null },
  user: { findFirst: async ({ where }: { where: { email: string } }) => users.find((u) => u.email === where.email) ?? null },
  appPassword: {
    findMany: async ({ where }: { where: { userId: string } }) => (where.userId === 'u1'
      ? [{ id: 'ap1', hash: 'hash:APP-ONE' }, { id: 'ap2', hash: 'hash:APP-TWO' }] : []),
    update: async () => ({}),
  },
  domain: { findFirst: async () => ({ name: 'example.com' }) },
  // the folder check runs before the long-poll registers (gate = "still validating")
  folder: { findMany: async () => { if (countGate) await countGate; return [{ id: 'f1', mailboxId: 'mb1' }]; } },
  mailbox: { findUnique: async () => ({ highestModSeq: 0n }) },
  message: { findFirst: async () => null, findMany: async () => [] },
};

const core = await import('@coremail/core');
const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
  limits: { accountMaxFailures: 1000, ipMaxFailures: 1000 },
});
const express = (await import('express')).default;
const { requireAuth } = await import('../auth.js');
const { handlePing } = await import('./ping.js');
const { el } = await import('../wbxml.js');
const { easLiveRequests } = await import('../live-sessions.js');
type EasUser = import('../auth.js').EasUser;

easLiveRequests.attachInvalidation();
const publish = (event: Parameters<typeof core.publishAuthInvalidation>[0]) => core.publishAuthInvalidation(event, { redis: null });

const app = express();
app.post('/eas', requireAuth as RequestHandler, async (req, res) => {
  const u = (req as Request & { easUser: EasUser }).easUser;
  const heartbeat = String(req.query['hb'] ?? '60');
  const body = el('Ping', undefined, [
    el('HeartbeatInterval', heartbeat),
    el('Folders', undefined, [el('Folder', undefined, [el('Id', 'f1'), el('Class', 'Email')])]),
  ]);
  await handlePing(body, u.userId, res, u, { pollIntervalMs: 20, minHeartbeatSec: 1 });
});
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const auth = (login: string, pw: string) => ({ authorization: `Basic ${Buffer.from(`${login}:${pw}`).toString('base64')}` });
function ping(login: string, pw: string, hb = 60) {
  return fetch(`${base}/eas?hb=${hb}`, { method: 'POST', headers: auth(login, pw) });
}
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80));
}
async function expect401(p: Promise<Response>): Promise<void> {
  const r = await p;
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') ?? '', /^Basic /);
}
/** The Ping is still pending after `ms`. */
async function pending(p: Promise<Response>, ms = 150): Promise<boolean> {
  return Promise.race([p.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);
}

describe('ActiveSync Ping after credential changes', () => {
  for (const reason of ['password-change', 'password-reset', 'admin-password-reset', 'mfa-change', 'deactivated', 'deleted'] as const) {
    test(`${reason}: the Ping ends with 401, another user's Ping keeps running`, async () => {
      const bob = ping('bob@example.com', 'pw');
      const carol = ping('carol@example.com', 'pw', 1);
      await settle();
      await publish({ userId: 'u1', reason });
      await expect401(bob);
      assert.equal(await pending(carol, 100), true);
      const r = await carol;
      assert.equal(r.status, 200, 'heartbeat expiry, not 401');
    });
  }

  test('app password revoked: only the Ping that used it ends', async () => {
    const one = ping('bob@example.com', 'APP-ONE');
    const two = ping('bob@example.com', 'APP-TWO', 1);
    await settle();
    await publish({ userId: 'u1', reason: 'app-password-revoked', appPasswordId: 'ap1' });
    await expect401(one);
    assert.equal((await two).status, 200);
  });

  test('neutral events keep the Ping running', async () => {
    const bob = ping('bob@example.com', 'pw', 1);
    await settle();
    for (const reason of ['role-change', 'app-password-created', 'reactivated'] as const) await publish({ userId: 'u1', reason });
    await publish({ userId: 'u1', reason: 'sessions-revoked', sessionIds: ['web'] });
    assert.equal((await bob).status, 200);
  });

  test('a change between the credential check and the start of the long-poll ends the Ping', async () => {
    let release!: () => void;
    countGate = new Promise<void>((r) => { release = r; });
    try {
      const bob = ping('bob@example.com', 'pw');
      await settle(); // authenticated, the folder check is blocked → not registered yet
      await publish({ userId: 'u1', reason: 'password-change' });
      countGate = null;
      release();
      await expect401(bob);
    } finally {
      countGate = null;
    }
  });

  test('finished Pings leave the registry', async () => {
    await (await ping('bob@example.com', 'pw', 1)).arrayBuffer();
    assert.equal(easLiveRequests.count('u1'), 0);
  });
});

describe('ActiveSync protocol switch (9.4)', () => {
  test('ActiveSync off: the Ping ends with 403, new requests 403 after correct credentials only; inherit → works', async () => {
    const bob = ping('bob@example.com', 'APP-ONE');
    const carol = ping('carol@example.com', 'pw', 1);
    await settle();
    policies.push({ id: 'p-u1', userId: 'u1', domainId: null, activesync: 'OFF' });
    try {
      // What @coremail/storage updateProtocolSettings() publishes for bob.
      await publish({ userId: 'u1', reason: 'protocol-access-change', disabledProtocols: ['activesync', 'mapi'] });
      const ended = await bob;
      assert.equal(ended.status, 403);
      assert.equal(ended.headers.get('www-authenticate'), null, 'no password prompt');
      assert.equal((await carol).status, 200);
      assert.equal((await ping('bob@example.com', 'pw', 1)).status, 403);
      assert.equal((await ping('bob@example.com', 'wrong', 1)).status, 401, 'a wrong password never learns the switch');
    } finally {
      policies.length = 0;
    }
    await publish({ userId: 'u1', reason: 'protocol-access-change', disabledProtocols: ['mapi'] });
    assert.equal((await ping('bob@example.com', 'pw', 1)).status, 200);
  });
});
