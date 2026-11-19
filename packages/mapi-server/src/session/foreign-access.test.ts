/**
 * 9.5 review: revoking a Shared Mailbox permission or a delegation ends the
 * access to that mailbox in open MAPI sessions at once (the logon and its
 * objects go); a permission reduced to read-only applies to the next write;
 * a deactivated owner ends the delegates' logons to the owner's mailbox.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveConnectionRegistry } from '@coremail/core';
import { executeRopBuffer } from '../rop/engine.js';
import { ROP_REGISTRY } from '../rop/registry.js';
import { RopId } from '../rop/codes.js';
import { HANDLE_UNUSED } from '../rop/handles.js';
import { SessionRegistry } from './registry.js';
import { applyForeignAccessChange, sessionsConcerned } from './foreign-access.js';
import { MemoryRedis } from '../testing/memory-redis.js';
import { MemoryStore } from '../testing/memory-store.js';
import { decodeLogon, ropInput, ropOutput, responseHead, Writer, type Reader } from '../testing/mapi-client.js';
import type { MailboxRef } from '../store/types.js';
import type { MapiSession } from './session.js';

const U = HANDLE_UNUSED;
const USER = { userId: 'u1', email: 'user@example.test', displayName: 'User', domainId: 'd1' };
const DN = '/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=';

function logon(logonId: number, out: number, essdn: string): Buffer {
  const dn = Buffer.from(`${essdn}\u0000`, 'ascii');
  return new Writer().u8(RopId.Logon).u8(logonId).u8(out).u8(0x01).u32(0x01000000).u32(0).u16(dn.length).bytes(dn).toBuffer();
}

const openFolder = (logonId: number, input: number, out: number, fid: bigint): Buffer =>
  new Writer().u8(RopId.OpenFolder).u8(logonId).u8(input).u8(out).u64(fid).u8(0).toBuffer();

const createFolder = (logonId: number, input: number, out: number, name: string): Buffer =>
  new Writer().u8(RopId.CreateFolder).u8(logonId).u8(input).u8(out).u8(1).u8(1).u8(0).u8(0).utf16Z(name).utf16Z('').toBuffer();

async function setup(foreign: MailboxRef) {
  const store = new MemoryStore();
  store.addMailbox({ mailboxId: 'mb1', kind: 'own', email: USER.email, displayName: USER.displayName, readOnly: false, directoryId: 'u1' });
  store.addMailbox(foreign);
  store.access.set('u1', [foreign]);
  const sessions = new SessionRegistry({ redis: new MemoryRedis(), live: new LiveConnectionRegistry('test'), idleMs: 60_000 });
  const { session } = await sessions.create({ user: USER, credential: 'password', authKey: 'k' }, Date.now());
  let handles: number[] = Array.from({ length: 8 }, () => U);
  const run = async (...rops: Buffer[]): Promise<Reader> => {
    const out = ropOutput(await executeRopBuffer(ropInput(rops, handles), { session, store, registry: ROP_REGISTRY }, 0x8000));
    handles = out.handles;
    return out.responses;
  };
  const own = decodeLogon(await run(logon(0, 0, ''))).folderIds;
  const shared = decodeLogon(await run(logon(1, 1, DN + foreign.directoryId))).folderIds;
  const r = await run(openFolder(1, 1, 2, shared[4]!), openFolder(0, 0, 3, own[4]!));
  assert.equal(responseHead(r).returnValue, 0); r.u8(); r.u8();
  assert.equal(responseHead(r).returnValue, 0); r.u8(); r.u8();
  return { store, sessions, session, run };
}

const SHARED: MailboxRef = { mailboxId: 'mbS', kind: 'shared', email: 'team@example.test', displayName: 'Team', readOnly: false, directoryId: 'sm1' };

test('a revoked shared mailbox permission ends that logon and its objects at once; the own mailbox stays', async () => {
  const { store, sessions, session, run } = await setup(SHARED);
  assert.equal(session.logons.size, 2);
  store.access.set('u1', []);
  assert.equal(await applyForeignAccessChange({ userId: 'u1', reason: 'permission-change' }, { sessions, store }), 1);
  assert.deepEqual([...session.logons.keys()], [0]);
  const r = await run(new Writer().u8(RopId.GetHierarchyTable).u8(1).u8(2).u8(4).u8(0).toBuffer(), new Writer().u8(RopId.GetHierarchyTable).u8(0).u8(3).u8(5).u8(0).toBuffer());
  assert.notEqual(responseHead(r).returnValue, 0, 'the shared Inbox handle is gone');
  assert.equal(responseHead(r).returnValue, 0, 'the own Inbox still works');
});

test('a permission reduced to read-only applies to the next write; an unrelated event changes nothing', async () => {
  const { store, sessions, session, run } = await setup(SHARED);
  assert.equal(await applyForeignAccessChange({ userId: 'other', reason: 'permission-change' }, { sessions, store }), 0);
  store.access.set('u1', [{ ...SHARED, readOnly: true }]);
  await applyForeignAccessChange({ userId: 'u1', reason: 'permission-change' }, { sessions, store });
  assert.equal(session.logons.get(1)!.mailbox.readOnly, true);
  const r = await run(createFolder(1, 2, 4, 'New'));
  assert.equal(responseHead(r).returnValue, 0x80070005, 'AccessDenied');
});

test('a deactivated owner ends the delegate logon to the owner mailbox (the event names the owner)', async () => {
  const delegated: MailboxRef = { mailboxId: 'mbO', kind: 'delegated', email: 'owner@example.test', displayName: 'Owner', readOnly: false, directoryId: 'owner1' };
  const { store, sessions, session } = await setup(delegated);
  assert.deepEqual(sessionsConcerned(sessions.sessionsOf('emsmdb'), 'owner1'), [session] as MapiSession[]);
  store.access.set('u1', []);
  assert.equal(await applyForeignAccessChange({ userId: 'owner1', reason: 'deactivated' }, { sessions, store }), 1);
  assert.equal(session.logons.has(1), false);
});
