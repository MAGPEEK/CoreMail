/**
 * The HTTP endpoints end to end, in process: envelope validation, Basic
 * authentication outcomes, the protocol switch (403 + session dropped),
 * Connect / Execute / Disconnect / PING with cookies and sequencing, the
 * PROCESSING/DONE framing, the address book stub.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createFixedWindowLimiter, LiveConnectionRegistry, type CounterStore } from '@coremail/core';
import { createApp } from './app.js';
import { SessionRegistry, type SessionRedis } from './session/registry.js';
import { ROP_REGISTRY } from './rop/registry.js';
import { MemoryStore } from './testing/memory-store.js';
import {
  MapiHttpClient, rop, decodeLogon, decodeQueryRows, responseHead, TAG, HANDLE_UNUSED, connectBody, type ClientResult,
} from './testing/mapi-client.js';
import type { AuthOutcome } from './http/auth.js';
import type { NotificationSource } from './emsmdb/notification-wait.js';

const USERS: Record<string, { password: string; userId: string; mapi: boolean }> = {
  'alice@example.test': { password: 'pw-a', userId: 'ua', mapi: true },
  'bob@example.test': { password: 'pw-b', userId: 'ub', mapi: false },
  'carol@example.test': { password: 'pw-c', userId: 'uc', mapi: true },
};

class MemoryRedis implements SessionRedis {
  keys = new Set<string>();
  async set(key: string): Promise<unknown> { this.keys.add(key); return 'OK'; }
  async pexpire(key: string): Promise<number> { return this.keys.has(key) ? 1 : 0; }
  async del(key: string): Promise<number> { return this.keys.delete(key) ? 1 : 0; }
}

async function fakeAuthenticate(header: string | undefined): Promise<AuthOutcome> {
  if (!header?.startsWith('Basic ')) return { ok: false, status: 401, reason: 'credentials required' };
  const [login, password] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  const u = USERS[login!];
  if (!u || u.password !== password) return { ok: false, status: 401, reason: 'invalid credentials' };
  if (!u.mapi) return { ok: false, status: 403, reason: 'MAPI access is disabled for this account', userId: u.userId };
  return {
    ok: true, startedAt: Date.now(),
    auth: { user: { userId: u.userId, email: login!, displayName: 'Alice', domainId: 'd' }, credential: 'password', authKey: `${login}:${password}` },
  };
}

const store = new MemoryStore();
store.addMailbox({ mailboxId: 'mba', kind: 'own', email: 'alice@example.test', displayName: 'Alice', readOnly: false, directoryId: 'ua' });
store.addMessage(store.folderByName('mba', 'INBOX').id, { subject: 'Welcome' });
const sessions = new SessionRegistry({ redis: new MemoryRedis(), live: new LiveConnectionRegistry('test'), idleMs: 60_000 });
const instantNotify: NotificationSource = { wait: async () => false };

function memoryCounter(): CounterStore {
  const n = new Map<string, number>();
  return { incr: async (k) => { const v = (n.get(k) ?? 0) + 1; n.set(k, v); return v; }, expire: async () => 1 };
}
const unlimitedCounter = memoryCounter();
const unlimited = createFixedWindowLimiter({ scope: 't', limit: 0, windowSec: 60, store: () => unlimitedCounter });
let server: Server;
let base = '';

before(async () => {
  const app = createApp({
    sessions, store, rops: ROP_REGISTRY, notifications: instantNotify, authenticate: fakeAuthenticate, limiter: unlimited,
    config: { pendingMs: 15_000, idleMs: 60_000 },
  });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const alice = (): MapiHttpClient => new MapiHttpClient(base, 'alice@example.test', 'pw-a');

function assertOk(r: ClientResult): void {
  assert.equal(r.status, 200, r.text);
  assert.equal(r.responseCode, 0, r.text);
}

test('Connect: PROCESSING/DONE framing, cookies, Connect body with the display name', async () => {
  const c = alice();
  const r = await c.connect('/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=ua');
  assertOk(r);
  assert.deepEqual(r.mapi!.metaTags, ['PROCESSING', 'DONE']);
  assert.ok(r.mapi!.headers['x-elapsedtime'] !== undefined && r.mapi!.headers['x-starttime']);
  assert.equal(r.headers.get('x-requesttype'), 'Connect');
  assert.equal(r.headers.get('x-requestid'), `${c.clientInfo}:1`);
  assert.equal(r.headers.get('x-pendingperiod'), '15000');
  assert.equal(r.headers.get('x-expirationinfo'), '60000');
  assert.ok(c.cookies.get('MapiContext') && c.cookies.get('MapiSequence'));
  const body = r.mapi!.body;
  assert.equal(body.readUInt32LE(0), 0);
  assert.equal(body.readUInt32LE(4), 0);
});

test('Connect for another account\'s DN fails with ecLoginPerm and no session', async () => {
  const c = alice();
  const r = await c.connect('/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=ub');
  assertOk(r);
  assert.equal(r.mapi!.body.readUInt32LE(4), 0x3f2);
  assert.equal(c.cookies.size, 0);
});

test('Execute: Logon → OpenFolder Inbox → contents table → QueryRows; sequence cookie rotates', async () => {
  const c = alice();
  assertOk(await c.connect());
  const seq1 = c.cookies.get('MapiSequence');
  const r1 = await c.execute([rop.logon(0)], [HANDLE_UNUSED]);
  assertOk(r1);
  assert.equal(r1.errorCode, 0);
  const logon = decodeLogon(r1.rop!.responses);
  assert.equal(logon.returnValue, 0);
  assert.notEqual(c.cookies.get('MapiSequence'), seq1);
  const r2 = await c.execute([
    rop.openFolder(0, 1, logon.folderIds[4]!), rop.getContentsTable(1, 2), rop.setColumns(2, [TAG.Subject]), rop.queryRows(2, 10),
  ], [r1.rop!.handles[0]!, HANDLE_UNUSED, HANDLE_UNUSED]);
  const resp = r2.rop!.responses;
  responseHead(resp); resp.u8(); resp.u8();
  responseHead(resp); assert.equal(resp.u32(), 1);
  responseHead(resp); resp.u8();
  assert.deepEqual(decodeQueryRows(resp, [TAG.Subject]).rows, [['Welcome']]);
});

test('sequence: a replayed sequence cookie gets 15, a missing one 13', async () => {
  const c = alice();
  assertOk(await c.connect());
  const old = c.cookies.get('MapiSequence')!;
  assertOk(await c.execute([rop.logon(0)], [HANDLE_UNUSED]));
  c.cookies.set('MapiSequence', old);
  const replay = await c.execute([rop.logon(0)], [HANDLE_UNUSED]);
  assert.equal(replay.responseCode, 15);
  c.cookies.delete('MapiSequence');
  assert.equal((await c.execute([rop.logon(0)], [HANDLE_UNUSED])).responseCode, 13);
});

test('Execute with a malformed ROP buffer: ErrorCode ecRpcFormat, session stays usable', async () => {
  const c = alice();
  assertOk(await c.connect());
  const r = await c.execute([Buffer.from([0x3c, 0, 0])], [HANDLE_UNUSED]);
  assertOk(r);
  assert.equal(r.errorCode, 0x4b6);
  assert.equal((await c.execute([rop.logon(0)], [HANDLE_UNUSED])).errorCode, 0);
});

test('Disconnect ends the session; the cookies are cleared and further requests get 10 / 13', async () => {
  const c = alice();
  assertOk(await c.connect());
  const ctx = c.cookies.get('MapiContext')!;
  assertOk(await c.disconnect());
  assert.equal(c.cookies.size, 0);
  assert.equal((await c.execute([rop.logon(0)], [HANDLE_UNUSED])).responseCode, 13);
  c.cookies.set('MapiContext', ctx);
  c.cookies.set('MapiSequence', 'A'.repeat(43));
  const gone = await c.execute([rop.logon(0)], [HANDLE_UNUSED]);
  assert.equal(gone.responseCode, 10);
});

test('a session is bound to its credentials: another account with the cookie gets 10', async () => {
  const c = alice();
  assertOk(await c.connect());
  const other = new MapiHttpClient(base, 'alice@example.test', 'pw-a');
  other.authorization = `Basic ${Buffer.from('alice@example.test:other-app-password').toString('base64')}`;
  USERS['alice@example.test']!.password = 'other-app-password';
  try {
    other.cookies = new Map(c.cookies);
    assert.equal((await other.execute([rop.logon(0)], [HANDLE_UNUSED])).responseCode, 10);
  } finally {
    USERS['alice@example.test']!.password = 'pw-a';
  }
});

test('authentication: no credentials → 401 with a Basic challenge; MAPI switched off → 403 and no challenge', async () => {
  const anon = alice();
  anon.authorization = '';
  const r = await anon.connect();
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') ?? '', /^Basic /);
  const bob = new MapiHttpClient(base, 'bob@example.test', 'pw-b');
  const denied = await bob.connect();
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('www-authenticate'), null);
  assert.equal(denied.responseCode, 11);
});

test('MAPI switched off while connected: the next request is 403 and the session is gone', async () => {
  const c = alice();
  assertOk(await c.connect());
  const before = sessions.size;
  USERS['alice@example.test']!.mapi = false;
  try {
    const r = await c.execute([rop.logon(0)], [HANDLE_UNUSED]);
    assert.equal(r.status, 403);
    assert.equal(sessions.size, before - 1);
  } finally {
    USERS['alice@example.test']!.mapi = true;
  }
  assert.equal((await c.execute([rop.logon(0)], [HANDLE_UNUSED])).responseCode, 10);
});

test('envelope errors: GET → 2, unknown request type → 5, missing request id → 7, wrong content type → 4', async () => {
  const get = await fetch(`${base}/mapi/emsmdb/`);
  assert.equal(get.headers.get('x-responsecode'), '2');
  const c = alice();
  assert.equal((await c.request('emsmdb', 'Bind', Buffer.alloc(0))).responseCode, 5);
  const noId = await fetch(`${base}/mapi/emsmdb/`, { method: 'POST', headers: { 'X-RequestType': 'Connect', 'Content-Type': 'application/mapi-http', Authorization: c.authorization }, body: connectBody('') });
  assert.equal(noId.headers.get('x-responsecode'), '7');
  const ct = await fetch(`${base}/mapi/emsmdb/`, { method: 'POST', headers: { 'X-RequestType': 'Connect', 'X-RequestId': '{x}:1', 'Content-Type': 'text/plain', Authorization: c.authorization }, body: connectBody('') });
  assert.equal(ct.headers.get('x-responsecode'), '4');
});

test('an invalid Connect body → 12; an oversized body → 9', async () => {
  const c = alice();
  assert.equal((await c.request('emsmdb', 'Connect', Buffer.from([0x41]))).responseCode, 12);
  assert.equal((await c.request('emsmdb', 'Execute', Buffer.alloc(0x50000))).responseCode, 9);
});

test('PING and NotificationWait on a live session; the address book answers PING, other types 16', async () => {
  const c = alice();
  assertOk(await c.connect());
  const ping = await c.request('emsmdb', 'PING', Buffer.alloc(0));
  assertOk(ping);
  assert.equal(ping.mapi!.body.length, 0);
  const wait = await c.request('emsmdb', 'NotificationWait', Buffer.alloc(8));
  assertOk(wait);
  assert.equal(wait.mapi!.body.readUInt32LE(8), 0, 'EventPending');
  assertOk(await c.request('nspi', 'PING', Buffer.alloc(0)));
  assert.equal((await c.request('nspi', 'Bind', Buffer.alloc(0))).responseCode, 16);
});

test('per-account request limit: over the limit → 429 + Retry-After (X-ResponseCode 1), other accounts unaffected', async () => {
  const counter = memoryCounter();
  const limited = createApp({
    sessions, store, rops: ROP_REGISTRY, notifications: instantNotify, authenticate: fakeAuthenticate,
    limiter: createFixedWindowLimiter({ scope: 'limited', limit: 3, windowSec: 60, store: () => counter }),
    config: { pendingMs: 15_000, idleMs: 60_000 },
  });
  const s = await new Promise<Server>((resolve) => { const x = limited.listen(0, '127.0.0.1', () => resolve(x)); });
  try {
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const c = new MapiHttpClient(url, 'alice@example.test', 'pw-a');
    assertOk(await c.connect());
    assertOk(await c.request('emsmdb', 'PING', Buffer.alloc(0)));
    assertOk(await c.request('nspi', 'PING', Buffer.alloc(0)));
    const over = await c.request('emsmdb', 'PING', Buffer.alloc(0));
    assert.equal(over.status, 429);
    assert.equal(over.responseCode, 1);
    assert.ok(Number(over.headers.get('retry-after')) >= 1);
    assert.equal(over.headers.get('www-authenticate'), null);
    assertOk(await new MapiHttpClient(url, 'carol@example.test', 'pw-c').connect());
    // Failed logins are not counted per account (the mail-login lockout covers them).
    const wrong = new MapiHttpClient(url, 'carol@example.test', 'nope');
    for (let i = 0; i < 5; i++) assert.equal((await wrong.connect()).status, 401);
  } finally {
    s.close();
  }
});
