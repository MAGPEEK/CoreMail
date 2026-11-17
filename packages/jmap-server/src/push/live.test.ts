/**
 * v7.1.0: JMAP push connections end after a credential change.
 *  - WebSocket: close code 1008 ("Credentials changed …"), no further requests;
 *  - EventSource: the stream ends (the reconnect then fails with 401);
 *  - Basic + app password: only connections with THAT app password end;
 *  - Bearer: follows the web session (session revoked / revoke-all mark), the
 *    session that changed the password keeps its connection;
 *  - other users and neutral events are left alone;
 *  - 9.4: JMAP switched off → WebSockets (Basic and Bearer) close with 1008
 *    "JMAP access has been disabled…", new upgrades/requests get 403.
 * Loopback HTTP server, fake Prisma, no Redis.
 * Run: node --import tsx --import ./src/test-env.ts --test src/push/live.test.ts
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env['LOG_LEVEL'] ??= 'error';

const user = (id: string, email: string) => ({
  id, email, displayName: id, domainId: 'd1', role: 'USER', active: true,
  passwordHash: 'hash:secret', authSource: 'LOCAL', mailbox: null, mfa: null,
});
const users = [user('u1', 'bob@example.com'), user('u2', 'carol@example.com')];
/** 9.4: ProtocolPolicy rows (protocol switches). */
const policies: Array<Record<string, unknown>> = [];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  protocolPolicy: { findMany: async () => policies, count: async () => 0 },
  user: {
    findFirst: async ({ where }: { where: { email?: string; id?: string } }) =>
      users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) ?? null,
  },
  appPassword: {
    findMany: async ({ where }: { where: { userId: string } }) => (where.userId === 'u1'
      ? [{ id: 'ap1', userId: 'u1', hash: 'hash:APP-ONE' }, { id: 'ap2', userId: 'u1', hash: 'hash:APP-TWO' }] : []),
    update: async () => ({}),
  },
  domain: { findFirst: async () => ({ name: 'example.com' }) },
  serverSettings: { findUnique: async () => ({ jmapEnabled: true }) },
  mailbox: { findFirst: async () => null },
  sharedMailboxPerm: { findMany: async () => [] },
  mailboxDelegate: { findMany: async () => [] },
};
const kv = new Map<string, string>();
(globalThis as Record<string, unknown>)['__authRedis'] = {
  async get(k: string) { return kv.get(k) ?? null; },
  async setex(k: string, _s: number, v: string) { kv.set(k, v); return 'OK'; },
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
const { WebSocket } = await import('ws');
const { jmapAuthMiddleware } = await import('../auth.js');
const { attachWebSocket } = await import('./websocket.js');
const { eventSourceHandler } = await import('./eventsource.js');
const { jmapLiveConnections, WS_CLOSE_CREDENTIALS_CHANGED } = await import('./live.js');

jmapLiveConnections.attachInvalidation();
const publish = (event: Parameters<typeof core.publishAuthInvalidation>[0]) => core.publishAuthInvalidation(event, { redis: null });

const app = express();
app.get('/jmap/eventsource', jmapAuthMiddleware, eventSourceHandler);
const server = http.createServer(app);
attachWebSocket(server);
server.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = (server.address() as AddressInfo).port;
after(() => { server.closeAllConnections(); server.close(); });

const basic = (login: string, pw: string) => `Basic ${Buffer.from(`${login}:${pw}`).toString('base64')}`;
const bearer = (sub: string, sessionId: string) => `Bearer ${core.signAccessToken({
  sub, email: `${sub}@example.com`, role: 'USER', domainId: 'd1', sessionId, mfaVerified: false,
})}`;

interface WsConn { ws: InstanceType<typeof WebSocket>; closed: Promise<{ code: number; reason: string }> }
async function openWs(authorization: string): Promise<WsConn> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/jmap/ws`, 'jmap', { headers: { authorization } });
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: reason.toString() })));
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  return { ws, closed };
}
async function stillOpen(c: WsConn, ms = 100): Promise<boolean> {
  return Promise.race([c.closed.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);
}
async function expectClosedByChange(c: WsConn): Promise<void> {
  const { code, reason } = await c.closed;
  assert.equal(code, WS_CLOSE_CREDENTIALS_CHANGED);
  assert.match(reason, /Credentials changed/);
}

describe('JMAP WebSocket after credential changes', () => {
  for (const reason of ['password-change', 'password-reset', 'admin-password-reset', 'mfa-change', 'deactivated', 'deleted'] as const) {
    test(`${reason}: Basic (password) WebSocket closes with 1008, another user's stays`, async () => {
      const bob = await openWs(basic('bob@example.com', 'secret'));
      const carol = await openWs(basic('carol@example.com', 'secret'));
      await publish({ userId: 'u1', reason });
      await expectClosedByChange(bob);
      assert.equal(await stillOpen(carol), true);
      carol.ws.close();
    });
  }

  test('app password revoked: only the WebSocket with that app password closes', async () => {
    const one = await openWs(basic('bob@example.com', 'APP-ONE'));
    const two = await openWs(basic('bob@example.com', 'APP-TWO'));
    await publish({ userId: 'u1', reason: 'app-password-revoked', appPasswordId: 'ap1' });
    await expectClosedByChange(one);
    assert.equal(await stillOpen(two), true);
    // MFA enabled: app-password connections stay as well.
    await publish({ userId: 'u1', reason: 'mfa-change' });
    assert.equal(await stillOpen(two), true);
    two.ws.close();
  });

  test('Bearer WebSocket follows its web session', async () => {
    const s1 = await openWs(bearer('u1', 's1'));
    const s2 = await openWs(bearer('u1', 's2'));
    const s3 = await openWs(bearer('u1', 's3'));
    await publish({ userId: 'u1', reason: 'mfa-change' });           // web sessions stay valid
    await publish({ userId: 'u1', reason: 'app-password-revoked' });
    assert.equal(await stillOpen(s1), true);
    await publish({ userId: 'u1', reason: 'sessions-revoked', sessionIds: ['s2'] }); // logout of s2
    await expectClosedByChange(s2);
    assert.equal(await stillOpen(s1), true);
    // Password change from session s1: every other session ends, s1 stays.
    await publish({ userId: 'u1', reason: 'password-change', revokeBefore: { before: Math.floor(Date.now() / 1000) + 5, except: 's1', expires: Date.now() + 60_000 } });
    await expectClosedByChange(s3);
    assert.equal(await stillOpen(s1), true);
    // Role change revokes all web sessions (v7.1.0) → s1 ends too.
    await publish({ userId: 'u1', reason: 'role-change', revokeBefore: { before: Math.floor(Date.now() / 1000) + 5, except: null, expires: Date.now() + 60_000 } });
    await expectClosedByChange(s1);
  });

  test('neutral events keep the WebSocket open', async () => {
    const bob = await openWs(basic('bob@example.com', 'secret'));
    for (const reason of ['role-change', 'app-password-created', 'reactivated'] as const) await publish({ userId: 'u1', reason });
    await publish({ userId: 'u1', reason: 'sessions-revoked', sessionIds: ['web'] });
    assert.equal(await stillOpen(bob), true);
    bob.ws.close();
    await bob.closed;
    for (let i = 0; i < 20 && jmapLiveConnections.count('u1') > 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(jmapLiveConnections.count('u1'), 0, 'closed connections leave the registry');
  });
});

describe('JMAP EventSource after credential changes', () => {
  async function openEs(authorization: string): Promise<{ ended: Promise<void>; abort: () => void }> {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/jmap/eventsource?types=*&closeafter=no&ping=0`, { headers: { authorization }, signal: ctrl.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const ended = (async () => { try { for (;;) { const { done } = await reader.read(); if (done) return; } } catch { /* aborted */ } })();
    return { ended, abort: () => ctrl.abort() };
  }
  const pendingFor = (p: Promise<void>, ms = 100) =>
    Promise.race([p.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);

  test('password reset ends the stream; another user\'s stream continues', async () => {
    const bob = await openEs(basic('bob@example.com', 'secret'));
    const carol = await openEs(basic('carol@example.com', 'secret'));
    await publish({ userId: 'u1', reason: 'password-reset' });
    await bob.ended;
    assert.equal(await pendingFor(carol.ended), true);
    carol.abort();
  });

  test('app password revoked: only the stream with that app password ends', async () => {
    const one = await openEs(basic('bob@example.com', 'APP-ONE'));
    const two = await openEs(basic('bob@example.com', 'APP-TWO'));
    await publish({ userId: 'u1', reason: 'app-password-revoked', appPasswordId: 'ap1' });
    await one.ended;
    assert.equal(await pendingFor(two.ended), true);
    two.abort();
  });
});

describe('JMAP protocol switch (9.4)', () => {
  // carol (u2): bob's web sessions were revoked by the tests above.
  test('JMAP off: Basic and Bearer WebSockets close, new upgrades and requests get 403; inherit → works', async () => {
    const pw = await openWs(basic('carol@example.com', 'secret'));
    const web = await openWs(bearer('u2', 'c1'));
    const bob = await openWs(basic('bob@example.com', 'APP-TWO'));
    policies.push({ id: 'p-u2', userId: 'u2', domainId: null, jmap: 'OFF' });
    try {
      // What @coremail/storage updateProtocolSettings() publishes for carol.
      await publish({ userId: 'u2', reason: 'protocol-access-change', disabledProtocols: ['jmap', 'mapi'] });
      for (const c of [pw, web]) {
        const { code, reason } = await c.closed;
        assert.equal(code, WS_CLOSE_CREDENTIALS_CHANGED);
        assert.equal(reason, 'JMAP access has been disabled for this account');
      }
      assert.equal(await stillOpen(bob), true);
      await assert.rejects(openWs(basic('carol@example.com', 'secret')), /Unexpected server response: 403/);
      const es = await fetch(`http://127.0.0.1:${port}/jmap/eventsource?types=*&closeafter=no&ping=0`, { headers: { authorization: bearer('u2', 'c1') } });
      assert.equal(es.status, 403);
      const wrong = await fetch(`http://127.0.0.1:${port}/jmap/eventsource`, { headers: { authorization: basic('carol@example.com', 'nope') } });
      assert.equal(wrong.status, 401, 'a wrong password never learns the switch');
    } finally {
      policies.length = 0;
      bob.ws.close();
    }
    await publish({ userId: 'u2', reason: 'protocol-access-change', disabledProtocols: ['mapi'] });
    const again = await openWs(basic('carol@example.com', 'secret'));
    again.ws.close();
  });
});
