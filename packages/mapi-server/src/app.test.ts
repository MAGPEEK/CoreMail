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
import { SessionRegistry } from './session/registry.js';
import { MemoryRedis } from './testing/memory-redis.js';
import { ROP_REGISTRY } from './rop/registry.js';
import { MemoryDirectory, MemoryStore } from './testing/memory-store.js';
import {
  MapiHttpClient, rop, decodeLogon, decodeQueryRows, responseHead, TAG, HANDLE_UNUSED, connectBody, AB, nspiBody, nspiDecode,
  parseExecuteResponse, readNotifications, ropOutput, ICS, decodeGetBuffer, decodeIcsStream, type ClientResult,
} from './testing/mapi-client.js';
import { authenticate, type AuthOutcome } from './http/auth.js';
import { queueNotificationSource, type NotificationSource } from './emsmdb/notification-wait.js';
import { dispatchMailboxChange } from './emsmdb/notify/bus.js';

const USERS: Record<string, { password: string; userId: string; mapi: boolean }> = {
  'alice@example.test': { password: 'pw-a', userId: 'ua', mapi: true },
  'bob@example.test': { password: 'pw-b', userId: 'ub', mapi: false },
  'carol@example.test': { password: 'pw-c', userId: 'uc', mapi: true },
};

async function fakeAuthenticate(header: string | undefined): Promise<AuthOutcome> {
  if (!header?.startsWith('Basic ')) return { ok: false, status: 401, reason: 'credentials required' };
  const [login, password] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  // the shared mail-login lockout as http/auth.ts reports it
  if (login === 'locked@example.test') return { ok: false, status: 503, reason: 'too many failed logins', retryAfterSec: 120 };
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
const directory = new MemoryDirectory();
directory.records = [
  { id: 'ua', kind: 'user', email: 'alice@example.test', displayName: 'Alice', aliases: [], hidden: false },
  { id: 'ub', kind: 'user', email: 'bob@example.test', displayName: 'Bob Builder', aliases: ['b@example.test'], hidden: false },
  { id: 'uh', kind: 'user', email: 'hidden@example.test', displayName: 'Hidden Person', aliases: [], hidden: true },
  { id: 'sx', kind: 'shared', email: 'team@example.test', displayName: 'Team', aliases: [], hidden: false },
];
const ENDPOINTS = { mailStore: 'https://mail.example.test/mapi/emsmdb/', addressBook: 'https://mail.example.test/mapi/nspi/' };
const nspiDeps = { directory, endpoints: async () => ENDPOINTS };

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
    config: { pendingMs: 15_000, idleMs: 60_000 }, ...nspiDeps,
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

test('PING and NotificationWait on a live session; the address book answers PING', async () => {
  const c = alice();
  assertOk(await c.connect());
  const ping = await c.request('emsmdb', 'PING', Buffer.alloc(0));
  assertOk(ping);
  assert.equal(ping.mapi!.body.length, 0);
  const wait = await c.request('emsmdb', 'NotificationWait', Buffer.alloc(8));
  assertOk(wait);
  assert.equal(wait.mapi!.body.readUInt32LE(8), 0, 'EventPending');
  assertOk(await c.request('nspi', 'PING', Buffer.alloc(0)));
});

test('per-account request limit: over the limit → 503 + Retry-After (X-ResponseCode 1), other accounts unaffected', async () => {
  const counter = memoryCounter();
  const limited = createApp({
    sessions, store, rops: ROP_REGISTRY, notifications: instantNotify, authenticate: fakeAuthenticate,
    limiter: createFixedWindowLimiter({ scope: 'limited', limit: 3, windowSec: 60, store: () => counter }),
    config: { pendingMs: 15_000, idleMs: 60_000 }, ...nspiDeps,
  });
  const s = await new Promise<Server>((resolve) => { const x = limited.listen(0, '127.0.0.1', () => resolve(x)); });
  try {
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const c = new MapiHttpClient(url, 'alice@example.test', 'pw-a');
    assertOk(await c.connect());
    assertOk(await c.request('emsmdb', 'PING', Buffer.alloc(0)));
    assertOk(await c.request('nspi', 'PING', Buffer.alloc(0)));
    const over = await c.request('emsmdb', 'PING', Buffer.alloc(0));
    assert.equal(over.status, 503, 'throttling is a 5xx with Retry-After, never 401 / 429');
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

test('locked account: 503 + Retry-After, X-ResponseCode 1, no password prompt (never 401 / 429 / X-ResponseCode 11)', async () => {
  for (const endpoint of ['emsmdb', 'nspi'] as const) {
    const r = await new MapiHttpClient(base, 'locked@example.test', 'pw').request(endpoint, 'PING', Buffer.alloc(0));
    assert.equal(r.status, 503, endpoint);
    assert.equal(r.responseCode, 1, endpoint);
    assert.equal(r.headers.get('retry-after'), '120', endpoint);
    assert.equal(r.headers.get('www-authenticate'), null, endpoint);
  }
});

async function heldServer(): Promise<{ s: Server; url: string }> {
  const held = createApp({
    sessions, store, rops: ROP_REGISTRY, notifications: queueNotificationSource(30_000), authenticate: fakeAuthenticate,
    limiter: unlimited, config: { pendingMs: 15_000, idleMs: 60_000 }, ...nspiDeps,
  });
  const s = await new Promise<Server>((resolve) => { const x = held.listen(0, '127.0.0.1', () => resolve(x)); });
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

test('NotificationWait: a second outstanding wait is rejected at once (ecRejected); Disconnect ends the first', async () => {
  const { s, url } = await heldServer();
  try {
    const c = new MapiHttpClient(url, 'alice@example.test', 'pw-a');
    assertOk(await c.connect());
    const first = c.request('emsmdb', 'NotificationWait', Buffer.alloc(8));
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    const second = await c.request('emsmdb', 'NotificationWait', Buffer.alloc(8));
    assertOk(second);
    assert.equal(second.mapi!.body.readUInt32LE(4), 0x7ee, 'ErrorCode ecRejected');
    assert.equal(second.mapi!.body.readUInt32LE(8), 0, 'EventPending 0');
    assert.ok(Date.now() - started < 5000, 'answered at once');
    assertOk(await c.disconnect());
    const r1 = await first;
    assertOk(r1);
    assert.equal(r1.mapi!.body.readUInt32LE(4), 0, 'the first wait ends normally');
    assert.equal(r1.mapi!.body.readUInt32LE(8), 0);
  } finally {
    s.close();
  }
});

test('NotificationWait wakes on new mail; the next (empty) Execute carries RopNotify NewMail + folder counts + TableChanged', async () => {
  const { s, url } = await heldServer();
  try {
    const c = new MapiHttpClient(url, 'alice@example.test', 'pw-a');
    assertOk(await c.connect());
    const logon = await c.execute([rop.logon(0)], [HANDLE_UNUSED]);
    const { folderIds } = decodeLogon(logon.rop!.responses);
    const inbox = folderIds[4]!;
    const reg = await c.execute([
      rop.registerNotification(0, 1, 0x0002 | 0x0010), rop.openFolder(0, 2, inbox), rop.getContentsTable(2, 3),
    ], [logon.rop!.handles[0]!, HANDLE_UNUSED, HANDLE_UNUSED, HANDLE_UNUSED]);
    assertOk(reg);
    const [, subscription, , table] = reg.rop!.handles;
    const waiting = c.request('emsmdb', 'NotificationWait', Buffer.alloc(8));
    await new Promise((r) => setTimeout(r, 30));
    const started = Date.now();
    const inboxRow = store.folderByName('mba', 'INBOX');
    store.addMessage(inboxRow.id, { subject: 'Arrived' });
    const notified = await dispatchMailboxChange({ mailboxId: 'mba', kinds: ['messages'], folderIds: [inboxRow.id] }, { sessions, store });
    assert.ok(notified >= 1, 'every mailbox session with a logon on the mailbox');
    assert.equal(await dispatchMailboxChange({ mailboxId: 'other', kinds: ['messages'] }, { sessions, store }), 0);
    const woke = await waiting;
    assertOk(woke);
    assert.equal(woke.mapi!.body.readUInt32LE(8), 1, 'EventPending 1');
    assert.ok(Date.now() - started < 3000, 'woken within 3 s');

    const events = await c.request('emsmdb', 'Execute', Buffer.alloc(0));
    assertOk(events);
    const exec = parseExecuteResponse(events.mapi!.body);
    assert.equal(exec.errorCode, 0);
    const { notifications, pending } = readNotifications(ropOutput(exec.ropBuffer).responses);
    assert.equal(pending, false);
    const byType = new Map(notifications.map((n) => [n.flags & 0x0fff, n]));
    assert.equal(byType.get(0x0002)?.handle, subscription, 'NewMail on the subscription handle');
    assert.equal(byType.get(0x0010)?.flags, 0x0010 | 0x1000 | 0x2000, 'ObjectModified with total + unread counts');
    assert.equal(byType.get(0x0100)?.handle, table, 'TableChanged on the contents table handle');
    const newMail = byType.get(0x0002)!.data;
    assert.equal(newMail.readBigUInt64LE(2), inbox, 'FolderId of the Inbox');
  } finally {
    s.close();
  }
});

test('address book: Bind / GetSpecialTable / QueryRows (sorted, paged, hidden left out) / ResolveNames / DNToMId / GetProps / Unbind', async () => {
  const c = alice();
  const bind = await c.request('nspi', 'Bind', nspiBody.bind());
  assertOk(bind);
  assert.equal(nspiDecode.bind(bind.mapi!.body).errorCode, 0);
  assert.ok(c.cookies.get('NspiContext') && c.cookies.get('NspiSequence'));
  assert.match(bind.headers.getSetCookie().join('\n'), /NspiContext=[^;]+; Path=\/mapi\/nspi;/);

  const special = await c.request('nspi', 'GetSpecialTable', nspiBody.getSpecialTable());
  assertOk(special);

  const cols = [TAG.DisplayName, 0x39fe001f, 0x3003001f];
  const page1 = nspiDecode.table((await c.request('nspi', 'QueryRows', nspiBody.queryRows({}, 2, cols))).mapi!.body);
  assert.equal(page1.errorCode, 0);
  assert.deepEqual(page1.rowSet!.rows.map((r) => r[0]), ['Alice', 'Bob Builder']);
  assert.equal(page1.stat!.totalRecs, 3, 'the hidden entry is not in the table');
  assert.equal(page1.stat!.numPos, 2);
  const page2 = nspiDecode.table((await c.request('nspi', 'QueryRows', nspiBody.queryRows(page1.stat!, 2, cols))).mapi!.body);
  assert.deepEqual(page2.rowSet!.rows.map((r) => r[0]), ['Team']);
  assert.equal(page2.stat!.currentRec, AB.MID_END_OF_TABLE);

  const resolved = nspiDecode.resolveNames((await c.request('nspi', 'ResolveNames', nspiBody.resolveNames(['bob', 'b@example.test', 'nobody', 'hidden'], cols))).mapi!.body);
  assert.equal(resolved.errorCode, 0);
  const [bob, alias, nobody, hidden] = resolved.mids!;
  assert.ok(bob! >= 0x10 && bob === alias, 'name prefix and alias resolve to the same MID');
  assert.equal(nobody, AB.MID_UNRESOLVED);
  assert.equal(hidden, AB.MID_UNRESOLVED, 'hidden entries are never found by name');
  assert.deepEqual(resolved.rowSet!.rows.map((r) => r[1]), ['bob@example.test', 'bob@example.test']);

  const dn = '/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=uh';
  const dnMids = nspiDecode.dnToMId((await c.request('nspi', 'DNToMId', nspiBody.dnToMId([dn, '/o=Other/cn=x']))).mapi!.body);
  assert.ok(dnMids.mids![0]! >= 0x10, 'a hidden entry is still found by its DN');
  assert.equal(dnMids.mids![1], 0);
  const props = nspiDecode.getProps((await c.request('nspi', 'GetProps', nspiBody.getProps(bob!, [0x39fe001f, 0x3002001f, 0x0e1d001f]))).mapi!.body);
  assert.equal(props.errorCode, 0x00040380, 'ErrorsReturned: one property does not exist');
  assert.equal(props.values!.get(0x39fe001f), 'bob@example.test');
  assert.equal(props.values!.get(0x3002001f), 'EX');
  assert.deepEqual(props.values!.get(0x0e1d000a), { error: 0x8004010f });

  const unbind = await c.request('nspi', 'Unbind', nspiBody.unbind());
  assertOk(unbind);
  assert.equal(unbind.mapi!.body.readUInt32LE(4), 1, 'UnbindSuccess');
  assert.equal(c.cookies.has('NspiContext'), false);
});

test('address book: the session is bound to its endpoint and sequence; a mailbox cookie is no address book session', async () => {
  const c = alice();
  assertOk(await c.connect());
  const mapiContext = c.cookies.get('MapiContext')!;
  c.cookies.set('NspiContext', mapiContext);
  assert.equal((await c.request('nspi', 'QueryRows', nspiBody.queryRows({}, 1, [TAG.DisplayName]))).responseCode, 10);
  const fresh = alice();
  assertOk(await fresh.request('nspi', 'Bind', nspiBody.bind()));
  const seq = fresh.cookies.get('NspiSequence')!;
  assertOk(await fresh.request('nspi', 'QueryRows', nspiBody.queryRows({}, 1, [TAG.DisplayName])));
  fresh.cookies.set('NspiSequence', seq);
  assert.equal((await fresh.request('nspi', 'QueryRows', nspiBody.queryRows({}, 1, [TAG.DisplayName]))).responseCode, 15);
  const noSession = alice();
  assert.equal((await noSession.request('nspi', 'GetProps', nspiBody.getProps(0x10, null))).responseCode, 13);
});

test('address book: a malformed body ends with X-ResponseCode 12 after PROCESSING', async () => {
  const c = alice();
  assertOk(await c.request('nspi', 'Bind', nspiBody.bind()));
  const r = await c.request('nspi', 'QueryRows', Buffer.from([1, 2, 3]));
  assert.equal(r.status, 200);
  assert.equal(r.responseCode, 12);
});

test('address book: another account cannot use a session cookie; a malformed Bind creates no session; one directory load per domain', async () => {
  const a = alice();
  assertOk(await a.request('nspi', 'Bind', nspiBody.bind()));
  const carol = new MapiHttpClient(base, 'carol@example.test', 'pw-c');
  carol.cookies.set('NspiContext', a.cookies.get('NspiContext')!);
  carol.cookies.set('NspiSequence', a.cookies.get('NspiSequence')!);
  assert.equal((await carol.request('nspi', 'QueryRows', nspiBody.queryRows({}, 1, [TAG.DisplayName]))).responseCode, 10, 'Context Not Found');
  assertOk(await a.request('nspi', 'QueryRows', nspiBody.queryRows({}, 1, [TAG.DisplayName])));

  const before = sessions.size;
  const bad = alice();
  const r = await bad.request('nspi', 'Bind', Buffer.from([1]));
  assert.equal(r.responseCode, 12);
  assert.equal(bad.cookies.has('NspiContext'), false);
  assert.equal(sessions.size, before, 'no session context for a malformed Bind');

  const loads = directory.loads;
  const second = new MapiHttpClient(base, 'carol@example.test', 'pw-c');
  assertOk(await second.request('nspi', 'Bind', nspiBody.bind()));
  assertOk(await second.request('nspi', 'QueryRows', nspiBody.queryRows({}, 1, [TAG.DisplayName])));
  const third = alice();
  assertOk(await third.request('nspi', 'Bind', nspiBody.bind()));
  assertOk(await third.request('nspi', 'QueryRows', nspiBody.queryRows({}, 1, [TAG.DisplayName])));
  assert.ok(directory.loads - loads <= 1, 'sessions of one domain share the address book snapshot');
});

test('cached mode over HTTP: ICS initial sync in partial buffers, then an incremental sync with the uploaded state', async () => {
  const c = alice();
  assertOk(await c.connect(''));
  const sync = async (state: Map<number, Buffer>): Promise<ReturnType<typeof decodeIcsStream>> => {
    const logon = await c.execute([rop.logon(0)], [HANDLE_UNUSED]);
    const inbox = decodeLogon(logon.rop!.responses).folderIds[4]!;
    const rops = [rop.openFolder(0, 1, inbox), rop.syncConfigure(1, 2, ICS.SyncContents, ICS.FlagUnicode | ICS.FlagNormal | ICS.FlagReadState, ICS.ExtraEid)];
    for (const [tag, value] of state) rops.push(rop.uploadStateBegin(2, tag, value.length), rop.uploadStateContinue(2, value), rop.uploadStateEnd(2));
    let handles = (await c.execute(rops, [logon.rop!.handles[0]!, HANDLE_UNUSED, HANDLE_UNUSED])).rop!.handles;
    const parts: Buffer[] = [];
    for (;;) {
      const g = await c.execute([rop.getBuffer(2, 64)], handles);
      handles = g.rop!.handles;
      const chunk = decodeGetBuffer(g.rop!.responses);
      assert.equal(chunk.returnValue, 0);
      parts.push(chunk.data);
      if (chunk.status === 3) return decodeIcsStream(Buffer.concat(parts));
    }
  };
  const first = await sync(new Map());
  assert.ok(first.messages.some((m) => m.props.get(TAG.Subject) === 'Welcome'));
  const inbox = store.folderByName('mba', 'INBOX').id;
  store.addMessage(inbox, { subject: 'Synced later' });
  const delta = await sync(first.state);
  assert.deepEqual(delta.messages.map((m) => m.props.get(TAG.Subject)), ['Synced later']);
  assert.equal(delta.ended, true);
});

test('review 9.4: a Bind with CP_WINUNICODE or an unserved code page → InvalidCodepage and no session; a Western Bind works', async () => {
  const before = sessions.size;
  for (const codePage of [AB.CP_WINUNICODE, 4711]) {
    const c = alice();
    const r = await c.request('nspi', 'Bind', nspiBody.bind({ codePage }));
    assertOk(r);
    assert.equal(nspiDecode.bind(r.mapi!.body).errorCode, 0x8004011e, `code page ${codePage}`);
    assert.equal(c.cookies.has('NspiContext'), false);
  }
  assert.equal(sessions.size, before, 'no session context');
  const ok = alice();
  const r = await ok.request('nspi', 'Bind', nspiBody.bind({ codePage: 1251 }));
  assert.equal(nspiDecode.bind(r.mapi!.body).errorCode, 0);
  assertOk(await ok.request('nspi', 'QueryRows', nspiBody.queryRows({}, 1, [TAG.DisplayName])));
});

test('no Negotiate / NTLM: such a header gets the Basic challenge only', async () => {
  for (const header of ['Negotiate YIIGhgYGKwYBBQUCoIIGejCCBnag', 'NTLM TlRMTVNTUAABAAAAB4IIog==']) {
    const outcome = await authenticate(header, { ip: '127.0.0.1', plainHttp: false });
    assert.deepEqual(outcome, { ok: false, status: 401, reason: 'credentials required' });
  }
  const anon = alice();
  anon.authorization = 'Negotiate YIIGhgYGKwYBBQUCoIIGejCCBnag';
  for (const endpoint of ['emsmdb', 'nspi'] as const) {
    const r = await anon.request(endpoint, 'PING', Buffer.alloc(0));
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), 'Basic realm="CoreMail"', 'Basic only — no Negotiate / NTLM offered');
  }
});
