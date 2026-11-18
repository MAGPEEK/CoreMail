/**
 * ROP input/output buffers and the engine (MS-OXCROPS 2.2.1, 3.2.4.3, 3.2.5):
 * parsing, ecRpcFormat for unknown/malformed requests, RopRelease without a
 * response, handle table updates, failure responses and RopBufferTooSmall.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRopOutput, parseRopInput } from './buffer.js';
import { executeRopBuffer } from './engine.js';
import { ROP_REGISTRY } from './registry.js';
import { Ec, RopId } from './codes.js';
import { HANDLE_UNUSED } from './handles.js';
import { WireFormatError } from '../wire/reader.js';
import { MapiSession } from '../session/session.js';
import { MemoryStore } from '../testing/memory-store.js';
import { rop, ropInput, ropOutput, decodeLogon, responseHead, TAG } from '../testing/mapi-client.js';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const USER = { userId: 'u1', email: 'user@example.test', displayName: 'User One', domainId: 'd1' };

function setup(): { store: MemoryStore; session: MapiSession; run: (rops: Buffer[], handles: number[], maxOut?: number) => Promise<Buffer> } {
  const store = new MemoryStore();
  store.addMailbox({ mailboxId: 'mb1', kind: 'own', email: USER.email, displayName: USER.displayName, readOnly: false, directoryId: 'u1' });
  const session = new MapiSession('s1', { user: USER, credential: 'password', authKey: 'k' }, 'seq', Date.now());
  const run = (rops: Buffer[], handles: number[], maxOut = 0x8000): Promise<Buffer> =>
    executeRopBuffer(ropInput(rops, handles), { session, store, registry: ROP_REGISTRY }, maxOut);
  return { store, session, run };
}

test('ROP input buffer: RopSize counts itself; the handle table follows', () => {
  const parsed = parseRopInput(hex('0500 010001 01000000 ffffffff'));
  assert.deepEqual(parsed.ropsList, hex('010001'));
  assert.deepEqual(parsed.handles, [1, HANDLE_UNUSED]);
  assert.deepEqual(buildRopOutput(hex('aa'), [7]), hex('0300 aa 07000000'));
  assert.throws(() => parseRopInput(hex('0900 0100')), WireFormatError);
  assert.throws(() => parseRopInput(hex('0200 010203')), WireFormatError, 'handle table not a multiple of 4');
});

test('engine: an unknown RopId fails the whole buffer (ecRpcFormat) before anything runs', async () => {
  const { run, session } = setup();
  await assert.rejects(run([rop.logon(0), Buffer.from([0x3c, 0x00, 0x00])], [HANDLE_UNUSED]), WireFormatError);
  assert.equal(session.logons.size, 0, 'the logon before it was not executed');
});

test('engine: a truncated request is a wire format error', async () => {
  const { run } = setup();
  await assert.rejects(run([rop.logon(0).subarray(0, 8)], [HANDLE_UNUSED]), WireFormatError);
});

test('RopLogon: private mailbox response, handle stored at the output index', async () => {
  const { run, session } = setup();
  const out = ropOutput(await run([rop.logon(0)], [HANDLE_UNUSED]));
  const logon = decodeLogon(out.responses);
  assert.equal(logon.returnValue, 0);
  assert.equal(logon.folderIds.length, 13);
  assert.ok(logon.folderIds[4]! > 0n, 'Inbox id');
  assert.equal(logon.folderIds[5], 0x0500000000000001n, 'Outbox = replica 1, counter 5');
  assert.notEqual(out.handles[0], HANDLE_UNUSED);
  assert.equal(session.logons.get(0)?.mailbox.mailboxId, 'mb1');
  assert.equal(out.responses.remaining, 0);
});

test('RopLogon to a mailbox without access: ecLoginPerm failure response', async () => {
  const { run } = setup();
  const out = ropOutput(await run([rop.logon(0, '/o=CoreMail/ou=X/cn=Recipients/cn=someone-else')], [HANDLE_UNUSED]));
  assert.deepEqual(responseHead(out.responses), { ropId: RopId.Logon, index: 0, returnValue: Ec.LoginPerm });
  assert.equal(out.handles[0], HANDLE_UNUSED);
});

test('RopRelease has no response and frees the handle; a released handle then fails ecInvalidObject', async () => {
  const { run, session } = setup();
  const first = ropOutput(await run([rop.logon(0)], [HANDLE_UNUSED]));
  const handle = first.handles[0]!;
  const second = ropOutput(await run([rop.release(0), rop.getReceiveFolder(0)], [handle]));
  assert.deepEqual(responseHead(second.responses), { ropId: RopId.GetReceiveFolder, index: 0, returnValue: Ec.InvalidObject });
  assert.equal(session.objects.size, 0);
  assert.equal(session.logons.size, 0, 'releasing the logon removes it from the logon map');
});

test('a ROP on an unused handle slot answers ecNullObject; later ROPs still run', async () => {
  const { run } = setup();
  const out = ropOutput(await run([rop.getReceiveFolder(1), rop.logon(0)], [HANDLE_UNUSED, HANDLE_UNUSED]));
  assert.equal(responseHead(out.responses).returnValue, Ec.NullObject);
  assert.equal(decodeLogon(out.responses).returnValue, 0);
});

test('RopBufferTooSmall: QueryRows that cannot fit one row returns the unexecuted requests', async () => {
  const { run, store } = setup();
  const inbox = store.folderByName('mb1', 'INBOX');
  store.addMessage(inbox.id, { subject: 'x'.repeat(200) });
  const logon = decodeLogon(ropOutput(await run([rop.logon(0)], [HANDLE_UNUSED])).responses);
  const inboxFid = logon.folderIds[4]!;
  const prep = ropOutput(await run([
    rop.logon(0), rop.openFolder(0, 1, inboxFid), rop.getContentsTable(1, 2), rop.setColumns(2, [TAG.Subject]),
  ], [HANDLE_UNUSED, HANDLE_UNUSED, HANDLE_UNUSED]));
  const query = rop.queryRows(2, 10);
  const release = rop.release(1);
  const small = ropOutput(await run([query, release], prep.handles, 2 + 12 + 40));
  const r = small.responses;
  assert.equal(r.u8(), RopId.BufferTooSmall);
  const sizeNeeded = r.u16();
  assert.ok(sizeNeeded > 54, `SizeNeeded ${sizeNeeded}`);
  assert.deepEqual(r.bytes(r.remaining), Buffer.concat([query, release]), 'RequestBuffers = the unexecuted requests');
  const big = ropOutput(await run([query], prep.handles, 0x8000));
  assert.equal(responseHead(big.responses).returnValue, 0);
});
