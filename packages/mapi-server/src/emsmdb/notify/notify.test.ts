/**
 * Notifications: NotificationData / RopNotify / RopPending byte fixtures
 * (MS-OXCNOTIF 2.2.1.4.1.2, MS-OXCROPS 2.2.14), the per-session queue
 * (coalescing, bound, output space), the planner (subscription matching,
 * counts, tables) and the change bus over the in-memory store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveConnectionRegistry } from '@coremail/core';
import { folderModifiedData, newMailData, ropNotify, ropPending, tableChangedData } from './data.js';
import { MAX_QUEUED_NOTIFICATIONS, NotificationQueue } from './queue.js';
import { planNotifications, type FolderFacts, type PlanInput } from './planner.js';
import { dispatchMailboxChange } from './bus.js';
import { makeId } from '../../ids.js';
import { SessionRegistry, type SessionRedis } from '../../session/registry.js';
import { MemoryStore } from '../../testing/memory-store.js';
import { executeRopBuffer } from '../../rop/engine.js';
import { ROP_REGISTRY } from '../../rop/registry.js';
import { ropInput, rop, HANDLE_UNUSED, decodeLogon, ropOutput } from '../../testing/mapi-client.js';
import type { NotificationSubscription } from '../../objects/state.js';

const hex = (s: string): string => s.replace(/\s+/g, '');
const utf16z = (s: string): string => Buffer.from(`${s}\u0000`, 'utf16le').toString('hex');

test('NotificationData: NewMail (M bit, FID, MID, flags, Unicode class), folder counts (T|U, TagCount 0), TableChanged', () => {
  const fid = makeId(4n);
  const mid = makeId(0x65n);
  assert.equal(newMailData(fid, mid, 0, 'IPM.Note').toString('hex'),
    hex(`0280 0100000000000004 0100000000000065 00000000 01 ${utf16z('IPM.Note')}`));
  assert.equal(folderModifiedData(fid, 7, 2).toString('hex'), hex('1030 0100000000000004 0000 07000000 02000000'));
  assert.equal(tableChangedData().toString('hex'), '00010100');
});

test('RopNotify: RopId 0x2A, NotificationHandle, LogonId, data; RopPending: 0x6E + SessionIndex', () => {
  assert.equal(ropNotify(0x11223344, 2, Buffer.from([0xaa])).toString('hex'), '2a4433221102aa');
  assert.equal(ropPending().toString('hex'), '6e0000');
});

const n = (key: string, handle = 1, size = 4): { key: string; handle: number; logonId: number; data: Buffer } =>
  ({ key, handle, logonId: 0, data: Buffer.alloc(size, 1) });

test('queue: same key replaces (moved to the end), bounded, wakes waiters once, drop by handle / logon', () => {
  const q = new NotificationQueue();
  let woken = 0;
  q.onPending(() => { woken += 1; });
  q.push([n('a'), n('b'), n('a', 1, 6)]);
  assert.equal(woken, 1);
  assert.equal(q.size, 2);
  const out = q.take(1000);
  assert.equal(out.length, 6 + 4 + 6 + 6, 'b, then the newer a (6 data bytes)');
  assert.equal(out[10], 0x2a);
  for (let i = 0; i < MAX_QUEUED_NOTIFICATIONS + 5; i++) q.push([n(`k${i}`)]);
  assert.equal(q.size, MAX_QUEUED_NOTIFICATIONS);
  q.drop({ handle: 1 });
  assert.equal(q.pending, false);
  q.push([{ ...n('x', 9), logonId: 3 }]);
  q.drop({ logonId: 3 });
  assert.equal(q.pending, false);
});

test('queue.take: only what fits, RopPending when some are left', () => {
  const q = new NotificationQueue();
  q.push([n('a'), n('b'), n('c')]);
  const first = q.take(10 + 3 + 10);
  assert.equal(first.length, 10 + 10 + 3);
  assert.equal(first.subarray(20).toString('hex'), '6e0000');
  assert.equal(q.size, 1);
  assert.equal(q.take(5).toString('hex'), '6e0000', 'none fits: only RopPending');
  assert.equal(q.take(100).length, 10);
});

function facts(...list: Array<[bigint, number, number]>): Map<bigint, FolderFacts> {
  return new Map(list.map(([counter, total, unread]) => [counter, { counter, total, unread }]));
}

const whole = (types: number): NotificationSubscription => ({ notificationTypes: types, wholeStore: true, folderId: 0n, messageId: 0n });

function plan(over: Partial<PlanInput>): ReturnType<typeof planNotifications> {
  return planNotifications({
    logonId: 0, kinds: ['messages'], changedFolders: new Set([10n]),
    before: facts([10n, 1, 1], [11n, 5, 0]), after: facts([10n, 2, 2], [11n, 5, 0]),
    newMessages: [{ folderCounter: 10n, uid: 7, read: false }], subscriptions: [], tables: [], ...over,
  });
}

test('planner: whole-store subscription gets NewMail + ObjectModified for the recounted folder only', () => {
  const out = plan({ subscriptions: [{ handle: 5, subscription: whole(0x0002 | 0x0010) }] });
  assert.deepEqual(out.map((x) => x.key), ['5:new:10:7', '5:folder:10']);
  assert.equal(out[1]!.data.toString('hex'), folderModifiedData(makeId(10n), 2, 2).toString('hex'));
});

test('planner: folder subscriptions match their folder; message subscriptions and unwanted types get nothing', () => {
  const folderSub: NotificationSubscription = { notificationTypes: 0x0002, wholeStore: false, folderId: makeId(10n), messageId: 0n };
  const otherSub: NotificationSubscription = { notificationTypes: 0x0002, wholeStore: false, folderId: makeId(11n), messageId: 0n };
  const msgSub: NotificationSubscription = { notificationTypes: 0x0002, wholeStore: false, folderId: makeId(10n), messageId: makeId(7n) };
  const out = plan({ subscriptions: [{ handle: 1, subscription: folderSub }, { handle: 2, subscription: otherSub }, { handle: 3, subscription: msgSub }, { handle: 4, subscription: whole(0x0100) }] });
  assert.deepEqual(out.map((x) => x.handle), [1]);
});

test('planner: TableChanged for contents tables of changed folders and hierarchy tables on folder / count changes', () => {
  const tables = [
    { handle: 20, source: { kind: 'contents' as const, folderCounter: 10n, associated: false } },
    { handle: 21, source: { kind: 'contents' as const, folderCounter: 11n, associated: false } },
    { handle: 22, source: { kind: 'contents' as const, folderCounter: 10n, associated: true } },
    { handle: 23, source: { kind: 'hierarchy' as const, folderCounter: 4n, depth: true } },
  ];
  assert.deepEqual(plan({ tables }).map((x) => x.handle), [20, 23]);
  const flagsOnly = plan({ tables, kinds: ['flags'], after: facts([10n, 1, 1], [11n, 5, 0]) });
  assert.deepEqual(flagsOnly.map((x) => x.handle), [20], 'no count change: hierarchy tables stay');
  const folders = plan({ tables, kinds: ['folders'], changedFolders: null, after: facts([10n, 1, 1], [11n, 5, 0]), newMessages: [] });
  assert.deepEqual(folders.map((x) => x.handle), [23]);
});

class MemoryRedis implements SessionRedis {
  async set(): Promise<unknown> { return 'OK'; }
  async pexpire(): Promise<number> { return 1; }
  async del(): Promise<number> { return 1; }
}

test('bus: a delivery queues NewMail for the subscribed logon; Sent copies never; the next Execute output carries the queue', async () => {
  const store = new MemoryStore();
  store.addMailbox({ mailboxId: 'mb1', kind: 'own', email: 'u@example.test', displayName: 'U', readOnly: false, directoryId: 'u1' });
  const sessions = new SessionRegistry({ redis: new MemoryRedis(), live: new LiveConnectionRegistry('test'), idleMs: 60_000 });
  const { session } = await sessions.create({ user: { userId: 'u1', email: 'u@example.test', displayName: 'U', domainId: 'd' }, credential: 'password', authKey: 'k' }, Date.now());
  const run = (rops: Buffer[], handles: number[]): Promise<Buffer> =>
    executeRopBuffer(ropInput(rops, handles), { session, store, registry: ROP_REGISTRY, tail: (room) => session.notifications.take(room) }, 0x8000);
  const logon = ropOutput(await run([rop.logon(0)], [HANDLE_UNUSED]));
  decodeLogon(logon.responses);
  await run([rop.registerNotification(0, 1, 0x0002)], [logon.handles[0]!, HANDLE_UNUSED]);

  const inbox = store.folderByName('mb1', 'INBOX');
  const sent = store.folderByName('mb1', 'Sent');
  store.addMessage(sent.id, { subject: 'my copy' });
  assert.equal(await dispatchMailboxChange({ mailboxId: 'mb1', kinds: ['messages'], folderIds: [sent.id] }, { sessions, store }), 1);
  assert.equal(session.notifications.pending, false, 'nothing for the Sent copy');
  store.addMessage(inbox.id, { subject: 'new' });
  store.addMessage(inbox.id, { subject: 'newer' });
  await dispatchMailboxChange({ mailboxId: 'mb1', kinds: ['messages'] }, { sessions, store });
  assert.equal(session.notifications.size, 2);
  await dispatchMailboxChange({ mailboxId: 'mb1', kinds: ['messages'] }, { sessions, store });
  assert.equal(session.notifications.size, 2, 'announced messages are not announced again');

  const out = ropOutput(await run([], []));
  assert.equal(out.responses.u8(), 0x2a);
  assert.equal(session.notifications.pending, false);
  await sessions.end(session);
  store.addMessage(inbox.id, { subject: 'after the end' });
  assert.equal(await dispatchMailboxChange({ mailboxId: 'mb1', kinds: ['messages'] }, { sessions, store }), 0);
});
