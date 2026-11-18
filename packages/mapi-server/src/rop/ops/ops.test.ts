/**
 * ROP handlers against the in-memory store: request parsing and response
 * bytes per ROP, and the vertical slice Logon → Inbox → contents table →
 * OpenMessage → body stream → CreateMessage → recipients → Save → Submit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeRopBuffer } from '../engine.js';
import { ROP_REGISTRY } from '../registry.js';
import { Ec, RopId } from '../codes.js';
import { HANDLE_UNUSED } from '../handles.js';
import { MapiSession } from '../../session/session.js';
import { MemoryStore } from '../../testing/memory-store.js';
import {
  rop, ropInput, ropOutput, decodeLogon, decodeQueryRows, decodeOpenMessage, readRow, responseHead, Writer, TAG,
  type Reader,
} from '../../testing/mapi-client.js';
import { Tag, PropType, tag } from '../../props/tags.js';
import { makeId } from '../../ids.js';
import { PS_MAPI } from '../../props/named.js';
import { MAX_ATTACHMENTS, MAX_RECIPIENTS } from './message.js';
import { MAX_RESTRICTION_NODES } from './table.js';

const U = HANDLE_UNUSED;
const USER = { userId: 'u1', email: 'user@example.test', displayName: 'User One', domainId: 'd1' };

class Harness {
  store = new MemoryStore();
  session = new MapiSession('s1', { user: USER, credential: 'password', authKey: 'k' }, 'seq', Date.now());
  handles: number[] = [U, U, U, U, U, U, U, U];
  folderIds: bigint[] = [];

  constructor() {
    this.store.addMailbox({ mailboxId: 'mb1', kind: 'own', email: USER.email, displayName: USER.displayName, readOnly: false, directoryId: 'u1' });
  }

  async run(...rops: Buffer[]): Promise<Reader> {
    const out = ropOutput(await executeRopBuffer(ropInput(rops, this.handles), { session: this.session, store: this.store, registry: ROP_REGISTRY }, 0x8000));
    this.handles = out.handles;
    return out.responses;
  }

  async logon(): Promise<void> {
    this.folderIds = decodeLogon(await this.run(rop.logon(0))).folderIds;
  }

  get inbox(): bigint { return this.folderIds[4]!; }
  get outbox(): bigint { return this.folderIds[5]!; }
}

function ok(r: Reader, ropId: number, index?: number): void {
  const head = responseHead(r);
  assert.equal(head.ropId, ropId);
  assert.equal(head.returnValue, 0, `ROP 0x${ropId.toString(16)} returned 0x${head.returnValue.toString(16)}`);
  if (index !== undefined) assert.equal(head.index, index);
}

test('GetReceiveFolder returns the Inbox id and an empty explicit class', async () => {
  const h = new Harness();
  await h.logon();
  const r = await h.run(rop.getReceiveFolder(0));
  ok(r, RopId.GetReceiveFolder, 0);
  assert.equal(r.u64(), h.inbox);
  assert.equal(r.asciiZ(), '');
});

test('OpenFolder + GetHierarchyTable on the IPM subtree lists the CoreMail folders and the Outbox', async () => {
  const h = new Harness();
  await h.logon();
  let r = await h.run(rop.openFolder(0, 1, h.folderIds[3]!), rop.getHierarchyTable(1, 2));
  ok(r, RopId.OpenFolder, 1);
  assert.deepEqual([r.u8(), r.u8()], [0, 0], 'HasRules, IsGhosted');
  ok(r, RopId.GetHierarchyTable, 2);
  assert.equal(r.u32(), 7, 'six default folders + Outbox');
  r = await h.run(rop.setColumns(2, [TAG.DisplayName, TAG.FolderId]), rop.queryRows(2, 50));
  ok(r, RopId.SetColumns, 2);
  assert.equal(r.u8(), 0, 'TableStatus complete');
  const q = decodeQueryRows(r, [TAG.DisplayName, TAG.FolderId]);
  assert.equal(q.origin, 2, 'cursor at the end');
  assert.deepEqual(q.rows.map((x) => x[0]).sort(), ['Archive', 'Drafts', 'INBOX', 'Junk', 'Outbox', 'Sent', 'Trash']);
  assert.ok(q.rows.some((x) => x[1] === h.inbox));
});

test('contents table: SortTable, Restrict, QueryRows paging, SeekRow and QueryPosition', async () => {
  const h = new Harness();
  const inbox = h.store.folderByName('mb1', 'INBOX');
  h.store.addMessage(inbox.id, { subject: 'Beta', rawSize: 20 });
  h.store.addMessage(inbox.id, { subject: 'Alpha', rawSize: 10 });
  h.store.addMessage(inbox.id, { subject: 'Gamma report', rawSize: 30 });
  await h.logon();
  let r = await h.run(rop.openFolder(0, 1, h.inbox), rop.getContentsTable(1, 2));
  ok(r, RopId.OpenFolder);
  r.u8(); r.u8();
  ok(r, RopId.GetContentsTable, 2);
  assert.equal(r.u32(), 3);

  const sort = new Writer().u8(RopId.SortTable).u8(0).u8(2).u8(0).u16(1).u16(0).u16(0).u32(TAG.Subject).u8(0).toBuffer();
  r = await h.run(sort, rop.setColumns(2, [TAG.Subject]), rop.queryRows(2, 2));
  ok(r, RopId.SortTable); r.u8();
  ok(r, RopId.SetColumns); r.u8();
  let q = decodeQueryRows(r, [TAG.Subject]);
  assert.deepEqual(q.rows.map((x) => x[0]), ['Alpha', 'Beta']);
  assert.equal(q.origin, 1);
  r = await h.run(rop.queryRows(2, 2));
  q = decodeQueryRows(r, [TAG.Subject]);
  assert.deepEqual(q.rows.map((x) => x[0]), ['Gamma report']);

  const seek = new Writer().u8(RopId.SeekRow).u8(0).u8(2).u8(0).i32(5).u8(1).toBuffer();
  r = await h.run(seek, new Writer().u8(RopId.QueryPosition).u8(0).u8(2).toBuffer());
  ok(r, RopId.SeekRow);
  assert.equal(r.u8(), 1, 'HasSoughtLess');
  assert.equal(r.i32(), 3, 'RowsSought');
  ok(r, RopId.QueryPosition);
  assert.deepEqual([r.u32(), r.u32()], [3, 3]);

  const restriction = new Writer().u8(0x03).u16(0x0001).u16(0x0001).u32(TAG.Subject).u32(TAG.Subject).utf16Z('REPORT').toBuffer();
  const restrict = new Writer().u8(RopId.Restrict).u8(0).u8(2).u8(0).u16(restriction.length).bytes(restriction).toBuffer();
  r = await h.run(restrict, rop.queryRows(2, 10));
  ok(r, RopId.Restrict); r.u8();
  assert.deepEqual(decodeQueryRows(r, [TAG.Subject]).rows.map((x) => x[0]), ['Gamma report']);
});

test('QueryRows without SetColumns fails with ecNullObject (MS-OXCTABL, Processing RopQueryRows)', async () => {
  const h = new Harness();
  await h.logon();
  const r = await h.run(rop.openFolder(0, 1, h.inbox), rop.getContentsTable(1, 2), rop.queryRows(2, 1));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.GetContentsTable); r.u32();
  assert.equal(responseHead(r).returnValue, Ec.NullObject);
});

test('vertical slice: read a message from the Inbox (contents row, OpenMessage, body stream, read flag)', async () => {
  const h = new Harness();
  const inbox = h.store.folderByName('mb1', 'INBOX');
  const stored = h.store.addMessage(inbox.id, { subject: 'RE: Planning', toAddrs: ['user@example.test'], ccAddrs: ['cc@example.test'], bodyText: 'Plain body ü', bodyHtml: '<p>Hi</p>' });
  await h.logon();
  let r = await h.run(rop.openFolder(0, 1, h.inbox), rop.getContentsTable(1, 2), rop.setColumns(2, [TAG.Mid, TAG.Subject, TAG.MessageFlags, TAG.SenderEmailAddress]), rop.queryRows(2, 10));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.GetContentsTable); assert.equal(r.u32(), 1);
  ok(r, RopId.SetColumns); r.u8();
  const row = decodeQueryRows(r, [TAG.Mid, TAG.Subject, TAG.MessageFlags, TAG.SenderEmailAddress]).rows[0]!;
  assert.equal(row[0], makeId(BigInt(stored.summary.uid)));
  assert.deepEqual(row.slice(1), ['RE: Planning', 0, 'sender@example.test']);

  r = await h.run(rop.openMessage(1, 3, h.inbox, row[0] as bigint));
  const opened = decodeOpenMessage(r);
  assert.equal(opened.returnValue, 0);
  assert.equal(opened.subject, 'RE: Planning');
  assert.deepEqual(opened.recipients, [
    { type: 1, email: 'user@example.test', name: 'user@example.test' },
    { type: 2, email: 'cc@example.test', name: 'cc@example.test' },
  ]);

  r = await h.run(rop.getPropertiesSpecific(3, [TAG.Subject, TAG.NativeBody, tag(0x0037, PropType.String8), TAG.DisplayName]));
  ok(r, RopId.GetPropertiesSpecific, 3);
  assert.deepEqual(readRow(r, [TAG.Subject, TAG.NativeBody, tag(0x0037, PropType.String8), TAG.DisplayName]), ['RE: Planning', 3, 'RE: Planning', { error: 0x8004010f }]);

  r = await h.run(rop.openStream(3, 4, TAG.Body), rop.readStream(4, 4), rop.readStream(4, 1000));
  ok(r, RopId.OpenStream, 4);
  const size = r.u32();
  assert.equal(size, Buffer.byteLength('Plain body ü', 'utf16le'));
  ok(r, RopId.ReadStream);
  const first = r.bytes(r.u16());
  ok(r, RopId.ReadStream);
  const rest = r.bytes(r.u16());
  assert.equal(Buffer.concat([first, rest]).toString('utf16le'), 'Plain body ü');

  r = await h.run(new Writer().u8(RopId.SetMessageReadFlag).u8(0).u8(3).u8(3).u8(0x00).toBuffer());
  ok(r, RopId.SetMessageReadFlag, 3);
  assert.equal(r.u8(), 0, 'ReadStatusChanged only reports public folders');
  assert.ok(stored.summary.flags.includes('\\Seen'));
});

test('vertical slice: compose in Drafts, save, submit (recipients by type, Sent copy requested, draft removed)', async () => {
  const h = new Harness();
  await h.logon();
  const drafts = h.store.folderByName('mb1', 'Drafts');
  const rowsR = await h.run(rop.openFolder(0, 1, h.folderIds[3]!), rop.getHierarchyTable(1, 2), rop.setColumns(2, [TAG.DisplayName, TAG.FolderId]), rop.queryRows(2, 50));
  ok(rowsR, RopId.OpenFolder); rowsR.u8(); rowsR.u8();
  ok(rowsR, RopId.GetHierarchyTable); rowsR.u32();
  ok(rowsR, RopId.SetColumns); rowsR.u8();
  const draftsId = decodeQueryRows(rowsR, [TAG.DisplayName, TAG.FolderId]).rows.find((x) => x[0] === 'Drafts')![1] as bigint;

  let r = await h.run(
    rop.openFolder(0, 1, draftsId),
    rop.createMessage(1, 3, draftsId),
    rop.setProperties(3, [{ tag: TAG.Subject, value: 'Status' }, { tag: TAG.Body, value: 'Weekly status' }]),
    rop.modifyRecipients(3, [
      { rowId: 0, type: 1, email: 'bob@example.test', name: 'Bob' },
      { rowId: 1, type: 3, email: 'hidden@example.test', name: 'Hidden' },
    ]),
    rop.saveChangesMessage(3, 3),
  );
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.CreateMessage, 3);
  assert.equal(r.u8(), 0, 'no message id before the first save');
  ok(r, RopId.SetProperties, 3);
  assert.equal(r.u16(), 0, 'no property problems');
  ok(r, RopId.ModifyRecipients, 3);
  ok(r, RopId.SaveChangesMessage, 3);
  assert.equal(r.u8(), 3);
  const mid = r.u64();
  const saved = h.store.messages.find((m) => m.summary.folderId === drafts.id && !m.deleted)!;
  assert.equal(mid, makeId(BigInt(saved.summary.uid)));
  assert.equal(saved.summary.subject, 'Status');
  assert.deepEqual(saved.summary.flags, ['\\Draft', '\\Seen']);

  r = await h.run(rop.submitMessage(3));
  ok(r, RopId.SubmitMessage, 3);
  assert.equal(h.store.sent.length, 1);
  const sent = h.store.sent[0]!;
  assert.deepEqual([sent.message.to, sent.message.bcc, sent.message.subject, sent.message.bodyText], [['bob@example.test'], ['hidden@example.test'], 'Status', 'Weekly status']);
  assert.equal(sent.saveCopy, true);
  assert.equal(saved.deleted, true, 'the draft row is removed after sending');

  r = await h.run(rop.submitMessage(3));
  assert.equal(responseHead(r).returnValue, Ec.AccessDenied, 'a message is sent once');
});

test('submit from the Outbox without recipients fails ecNoRecipients; DeleteAfterSubmit skips the Sent copy', async () => {
  const h = new Harness();
  await h.logon();
  let r = await h.run(rop.openFolder(0, 1, h.outbox), rop.createMessage(1, 2, h.outbox), rop.submitMessage(2));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.CreateMessage); r.u8();
  assert.equal(responseHead(r).returnValue, Ec.NoRecipients);
  r = await h.run(
    rop.setProperties(2, [{ tag: Tag.DeleteAfterSubmit, value: true }]),
    rop.modifyRecipients(2, [{ rowId: 0, type: 1, email: 'bob@example.test', name: 'Bob' }]),
    rop.submitMessage(2),
  );
  ok(r, RopId.SetProperties); r.u16();
  ok(r, RopId.ModifyRecipients);
  ok(r, RopId.SubmitMessage);
  assert.equal(h.store.sent[0]!.saveCopy, false);
});

test('attachments: CreateAttachment + SetProperties + SaveChangesAttachment, then GetAttachmentTable', async () => {
  const h = new Harness();
  await h.logon();
  let r = await h.run(rop.openFolder(0, 1, h.outbox), rop.createMessage(1, 2, h.outbox), new Writer().u8(RopId.CreateAttachment).u8(0).u8(2).u8(3).toBuffer());
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.CreateMessage); r.u8();
  ok(r, RopId.CreateAttachment, 3);
  assert.equal(r.u32(), 0, 'attachment number');
  r = await h.run(
    rop.setProperties(3, [{ tag: Tag.AttachLongFilename, value: 'a.txt' }, { tag: Tag.AttachDataBinary, value: Buffer.from('data') }]),
    new Writer().u8(RopId.SaveChangesAttachment).u8(0).u8(3).u8(3).u8(0).toBuffer(),
    new Writer().u8(RopId.GetAttachmentTable).u8(0).u8(2).u8(4).u8(0).toBuffer(),
    rop.setColumns(4, [Tag.AttachNumber, Tag.AttachLongFilename]),
    rop.queryRows(4, 10),
    rop.modifyRecipients(2, [{ rowId: 0, type: 1, email: 'bob@example.test', name: 'Bob' }]),
    rop.submitMessage(2),
  );
  ok(r, RopId.SetProperties); r.u16();
  ok(r, RopId.SaveChangesAttachment, 3);
  ok(r, RopId.GetAttachmentTable, 4);
  ok(r, RopId.SetColumns); r.u8();
  assert.deepEqual(decodeQueryRows(r, [Tag.AttachNumber, Tag.AttachLongFilename]).rows, [[0, 'a.txt']]);
  ok(r, RopId.ModifyRecipients);
  ok(r, RopId.SubmitMessage);
  const att = h.store.sent[0]!.message.attachments[0]!;
  assert.deepEqual([att.filename, att.content.toString()], ['a.txt', 'data']);
});

test('WriteStream + CommitStream on the body of a new message; read-only streams refuse writes', async () => {
  const h = new Harness();
  await h.logon();
  let r = await h.run(
    rop.openFolder(0, 1, h.outbox), rop.createMessage(1, 2, h.outbox), rop.openStream(2, 3, TAG.Body, 0x02),
    new Writer().u8(RopId.WriteStream).u8(0).u8(3).u16(6).bytes(Buffer.from('Hey', 'utf16le')).toBuffer(),
    new Writer().u8(RopId.CommitStream).u8(0).u8(3).toBuffer(),
    new Writer().u8(RopId.GetStreamSize).u8(0).u8(3).toBuffer(),
    rop.getPropertiesSpecific(2, [TAG.Body]),
  );
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.CreateMessage); r.u8();
  ok(r, RopId.OpenStream); assert.equal(r.u32(), 0);
  ok(r, RopId.WriteStream); assert.equal(r.u16(), 6);
  ok(r, RopId.CommitStream);
  ok(r, RopId.GetStreamSize); assert.equal(r.u32(), 6);
  ok(r, RopId.GetPropertiesSpecific);
  assert.deepEqual(readRow(r, [TAG.Body]), ['Hey']);

  const inbox = h.store.folderByName('mb1', 'INBOX');
  const m = h.store.addMessage(inbox.id);
  r = await h.run(rop.openMessage(1, 4, h.outbox, makeId(BigInt(m.summary.uid))));
  assert.equal(responseHead(r).returnValue, Ec.NotFound, 'messages are addressed within their folder');
  r = await h.run(rop.openFolder(0, 1, h.inbox), rop.openMessage(1, 4, h.inbox, makeId(BigInt(m.summary.uid)), 0x00), rop.openStream(4, 5, TAG.Body, 0x00),
    new Writer().u8(RopId.WriteStream).u8(0).u8(5).u16(2).bytes(Buffer.from('x', 'utf16le')).toBuffer());
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  assert.equal(decodeOpenMessage(r).returnValue, 0);
  ok(r, RopId.OpenStream); r.u32();
  const w = responseHead(r);
  assert.equal(w.returnValue, 0x80030005);
  assert.equal(r.u16(), 0, 'WrittenSize 0 on failure');
});

test('CreateFolder (and OpenExisting), DeleteFolder; default folders are protected', async () => {
  const h = new Harness();
  await h.logon();
  const create = (name: string, openExisting: boolean): Buffer =>
    new Writer().u8(RopId.CreateFolder).u8(0).u8(1).u8(2).u8(1).u8(1).u8(openExisting ? 1 : 0).u8(0).utf16Z(name).utf16Z('').toBuffer();
  let r = await h.run(rop.openFolder(0, 1, h.inbox), create('Projects', false));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.CreateFolder, 2);
  const fid = r.u64();
  assert.equal(r.u8(), 0, 'IsExistingFolder');
  assert.ok(h.store.folders.some((f) => f.name === 'INBOX.Projects' && f.displayName === 'Projects'));
  r = await h.run(create('Projects', false));
  assert.equal(responseHead(r).returnValue, Ec.CollidingNames);
  r = await h.run(create('projects', true));
  ok(r, RopId.CreateFolder);
  assert.equal(r.u64(), fid);
  assert.deepEqual([r.u8(), r.u8(), r.u8()], [1, 0, 0]);

  r = await h.run(new Writer().u8(RopId.DeleteFolder).u8(0).u8(1).u8(0x05).u64(fid).toBuffer());
  ok(r, RopId.DeleteFolder, 1);
  assert.equal(r.u8(), 0, 'PartialCompletion');
  r = await h.run(rop.openFolder(0, 1, h.folderIds[3]!), new Writer().u8(RopId.DeleteFolder).u8(0).u8(1).u8(0x05).u64(h.inbox).toBuffer());
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  const head = responseHead(r);
  assert.equal(head.returnValue, Ec.AccessDenied);
  assert.equal(r.u8(), 0, 'failure response keeps PartialCompletion');
});

test('DeleteMessages and MoveCopyMessages (including the null-destination failure)', async () => {
  const h = new Harness();
  const inbox = h.store.folderByName('mb1', 'INBOX');
  const a = h.store.addMessage(inbox.id);
  const b = h.store.addMessage(inbox.id);
  await h.logon();
  const archiveFolder = h.store.folderByName('mb1', 'Archive');
  const del = new Writer().u8(RopId.DeleteMessages).u8(0).u8(1).u8(0).u8(0).u16(1).u64(makeId(BigInt(a.summary.uid))).toBuffer();
  let r = await h.run(rop.openFolder(0, 1, h.inbox), del);
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.DeleteMessages, 1);
  assert.equal(r.u8(), 0);
  assert.equal(a.deleted, true);

  const move = (dest: number): Buffer => new Writer().u8(RopId.MoveCopyMessages).u8(0).u8(1).u8(dest).u16(1).u64(makeId(BigInt(b.summary.uid))).u8(0).u8(0).toBuffer();
  r = await h.run(move(6));
  assert.deepEqual(responseHead(r), { ropId: RopId.MoveCopyMessages, index: 1, returnValue: Ec.NullDestinationObject });
  assert.deepEqual([r.u32(), r.u8()], [6, 0]);

  const archiveFid = (await (async () => {
    const q = await h.run(rop.openFolder(0, 2, h.folderIds[3]!), rop.getHierarchyTable(2, 3), rop.setColumns(3, [TAG.DisplayName, TAG.FolderId]), rop.queryRows(3, 50));
    ok(q, RopId.OpenFolder); q.u8(); q.u8(); ok(q, RopId.GetHierarchyTable); q.u32(); ok(q, RopId.SetColumns); q.u8();
    return decodeQueryRows(q, [TAG.DisplayName, TAG.FolderId]).rows.find((x) => x[0] === 'Archive')![1] as bigint;
  })());
  r = await h.run(rop.openFolder(0, 4, archiveFid), move(4));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.MoveCopyMessages, 1);
  assert.equal(r.u8(), 0);
  assert.equal(b.summary.folderId, archiveFolder.id);
});

test('read-only mailbox (shared, READ_ONLY): writes are refused with ecAccessDenied', async () => {
  const h = new Harness();
  h.store.addMailbox({ mailboxId: 'mb2', kind: 'shared', email: 'team@example.test', displayName: 'Team', readOnly: true, directoryId: 'sm1' });
  h.store.access.set('u1', [h.store.mailboxes.get('mb2')!]);
  const r0 = await h.run(rop.logon(0, '/o=CoreMail/ou=X/cn=Recipients/cn=sm1'));
  const ids = decodeLogon(r0).folderIds;
  assert.equal(ids.length, 13);
  const r = await h.run(rop.openFolder(0, 1, ids[4]!), rop.createMessage(1, 2, ids[4]!));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  assert.equal(responseHead(r).returnValue, Ec.AccessDenied);
});

test('named properties: ids from names (create flag), names from ids, unknown names warn', async () => {
  const h = new Harness();
  await h.logon();
  const guid = Buffer.from('0820060000000000c000000000000046', 'hex');
  const names = new Writer().u8(0).bytes(guid).u32(0x8503).u8(1).bytes(guid).u8(8).utf16Z('abc').toBuffer();
  let r = await h.run(new Writer().u8(RopId.GetPropertyIdsFromNames).u8(0).u8(0).u8(0x02).u16(2).bytes(names).toBuffer());
  ok(r, RopId.GetPropertyIdsFromNames, 0);
  assert.equal(r.u16(), 2);
  const [id1, id2] = [r.u16(), r.u16()];
  assert.ok(id1 > 0x8000 && id2 === id1 + 1, 'registered IDs are greater than 0x8000');
  r = await h.run(new Writer().u8(RopId.GetPropertyIdsFromNames).u8(0).u8(0).u8(0x00).u16(1).u8(0).bytes(guid).u32(0x9999).toBuffer());
  assert.equal(responseHead(r).returnValue, Ec.WarnWithErrors);
  assert.deepEqual([r.u16(), r.u16()], [1, 0]);
  r = await h.run(new Writer().u8(RopId.GetNamesFromPropertyIds).u8(0).u8(0).u16(2).u16(id1).u16(0x0037).toBuffer());
  ok(r, RopId.GetNamesFromPropertyIds);
  assert.equal(r.u16(), 2);
  assert.equal(r.u8(), 0);
  assert.deepEqual(r.bytes(16), guid);
  assert.equal(r.u32(), 0x8503);
  assert.equal(r.u8(), 0x00, 'an ID below 0x8000 is named PS_MAPI / LID');
  assert.deepEqual(r.bytes(16), PS_MAPI);
  assert.equal(r.u32(), 0x0037);
});

test('GetNamesFromPropertyIds (MS-OXCPRPT 3.2.5.9): an ID without a name is the Kind byte 0xFF alone, the next entry follows at once', async () => {
  const h = new Harness();
  await h.logon();
  const guid = Buffer.from('0820060000000000c000000000000046', 'hex');
  let r = await h.run(new Writer().u8(RopId.GetPropertyIdsFromNames).u8(0).u8(0).u8(0x02).u16(1).u8(0).bytes(guid).u32(0x8503).toBuffer());
  ok(r, RopId.GetPropertyIdsFromNames, 0);
  r.u16();
  const known = r.u16();
  r = await h.run(new Writer().u8(RopId.GetNamesFromPropertyIds).u8(0).u8(0).u16(3).u16(0xfffe).u16(known).u16(0xfffd).toBuffer());
  ok(r, RopId.GetNamesFromPropertyIds);
  const body = r.bytes(r.remaining);
  const expected = Buffer.concat([
    Buffer.from([0x03, 0x00]), // PropertyNameCount
    Buffer.from([0xff]), // unnamed ID: Kind only
    Buffer.from([0x00]), guid, Buffer.from([0x03, 0x85, 0x00, 0x00]), // Kind 0x00, GUID, LID 0x8503
    Buffer.from([0xff]),
  ]);
  assert.deepEqual(body, expected);
});

test('GetPropertiesAll on the store object returns tagged values incl. the IPM subtree EntryID', async () => {
  const h = new Harness();
  await h.logon();
  const r = await h.run(new Writer().u8(RopId.GetPropertiesAll).u8(0).u8(0).u16(0).u16(1).toBuffer());
  ok(r, RopId.GetPropertiesAll, 0);
  const n = r.u16();
  const tags = new Map<number, unknown>();
  for (let i = 0; i < n; i++) {
    const t = r.u32();
    const type = t & 0xffff;
    tags.set(t, type === PropType.String ? r.utf16Z() : type === PropType.Binary ? r.bytes(r.u16()) : type === PropType.Boolean ? r.u8() : r.u32());
  }
  assert.equal(tags.get(Tag.MailboxOwnerName), 'User One');
  assert.equal((tags.get(Tag.IpmSubtreeEntryId) as Buffer).length, 46);
});

test('GetPropertiesSpecific: large values come back as ecMAPIOOM below the size limit', async () => {
  const h = new Harness();
  const inbox = h.store.folderByName('mb1', 'INBOX');
  const m = h.store.addMessage(inbox.id, { bodyText: 'x'.repeat(5000) });
  await h.logon();
  const r = await h.run(rop.openFolder(0, 1, h.inbox), rop.openMessage(1, 2, h.inbox, makeId(BigInt(m.summary.uid))), rop.getPropertiesSpecific(2, [TAG.Body, TAG.Subject], 1000));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  decodeOpenMessage(r);
  ok(r, RopId.GetPropertiesSpecific);
  assert.deepEqual(readRow(r, [TAG.Body, TAG.Subject]), [{ error: Ec.OutOfMemory }, 'Hello']);
});

// ── Review 9.4: limits on hostile / oversized input, spec corrections ───────

/** Harness whose session has a small memory budget. */
function smallBudget(bytes: number): Harness {
  const h = new Harness();
  h.session = new MapiSession('s-small', { user: USER, credential: 'password', authKey: 'k' }, 'seq', Date.now(), bytes);
  return h;
}

/** Opens the Outbox at index 1 and creates a message at index 2. */
async function outboxMessage(h: Harness): Promise<void> {
  const r = await h.run(rop.openFolder(0, 1, h.outbox), rop.createMessage(1, 2, h.outbox));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.CreateMessage); r.u8();
}

const writeStream = (index: number, data: Buffer): Buffer =>
  new Writer().u8(RopId.WriteStream).u8(0).u8(index).u16(data.length).bytes(data).toBuffer();

/** Opens a folder of the IPM subtree by display name at `out`. */
async function openByName(h: Harness, name: string, out: number): Promise<bigint> {
  const t = await h.run(rop.openFolder(0, 6, h.folderIds[3]!), rop.getHierarchyTable(6, 7), rop.setColumns(7, [TAG.DisplayName, TAG.FolderId]), rop.queryRows(7, 50));
  ok(t, RopId.OpenFolder); t.u8(); t.u8(); ok(t, RopId.GetHierarchyTable); t.u32(); ok(t, RopId.SetColumns); t.u8();
  const id = decodeQueryRows(t, [TAG.DisplayName, TAG.FolderId]).rows.find((x) => x[0] === name)![1] as bigint;
  const r = await h.run(rop.openFolder(0, out, id));
  ok(r, RopId.OpenFolder, out);
  return id;
}

test('session memory budget: WriteStream past it fails with STG_E_MEDIUMFULL, SetProperties with ecMAPIOOM', async () => {
  const h = smallBudget(64 * 1024);
  await h.logon();
  await outboxMessage(h);
  let r = await h.run(rop.openStream(2, 3, Tag.Html, 0x02), writeStream(3, Buffer.alloc(30_000, 0x61)));
  ok(r, RopId.OpenStream); r.u32();
  ok(r, RopId.WriteStream); assert.equal(r.u16(), 30_000);
  r = await h.run(writeStream(3, Buffer.alloc(30_000, 0x62)), writeStream(3, Buffer.alloc(30_000, 0x63)));
  ok(r, RopId.WriteStream); assert.equal(r.u16(), 30_000, 'the capacity falls back to the exact size');
  assert.equal(responseHead(r).returnValue, Ec.StreamSizeError);
  assert.equal(r.u16(), 0, 'WrittenSize 0');
  r = await h.run(rop.setProperties(2, [{ tag: TAG.Body, value: 'x'.repeat(10_000) }]));
  assert.equal(responseHead(r).returnValue, Ec.OutOfMemory);
  // Release commits the stream into the message; releasing the message frees both.
  r = await h.run(rop.release(3), rop.release(2), rop.createMessage(1, 2, h.outbox), rop.setProperties(2, [{ tag: TAG.Body, value: 'x'.repeat(10_000) }]));
  ok(r, RopId.CreateMessage, 2); r.u8();
  ok(r, RopId.SetProperties, 2);
  assert.equal(r.u16(), 0);
});

test('ModifyRecipients: at most MAX_RECIPIENTS per message (ecMAPIOOM); rows replace by RowId', async () => {
  const h = new Harness();
  await h.logon();
  await outboxMessage(h);
  const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ rowId: from + i, type: 1, email: `r${from + i}@example.test`, name: `R${from + i}` }));
  for (let start = 0; start < MAX_RECIPIENTS; start += 200) ok(await h.run(rop.modifyRecipients(2, rows(start, 200))), RopId.ModifyRecipients);
  ok(await h.run(rop.modifyRecipients(2, rows(0, 10))), RopId.ModifyRecipients, 2);
  const r = await h.run(rop.modifyRecipients(2, rows(MAX_RECIPIENTS, 1)));
  assert.equal(responseHead(r).returnValue, Ec.OutOfMemory);
  h.store.limits = { maxMessageBytes: 25 * 1024 * 1024, maxRecipients: 5000 };
  ok(await h.run(rop.submitMessage(2)), RopId.SubmitMessage);
  assert.equal(h.store.sent[0]!.message.to.length, MAX_RECIPIENTS, 'replaced rows are not duplicated');
});

test('CreateAttachment: at most MAX_ATTACHMENTS per message', async () => {
  const h = new Harness();
  await h.logon();
  await outboxMessage(h);
  const create = new Writer().u8(RopId.CreateAttachment).u8(0).u8(2).u8(3).toBuffer();
  for (let i = 0; i < MAX_ATTACHMENTS; i++) ok(await h.run(create, rop.release(3)), RopId.CreateAttachment, 3);
  assert.equal(responseHead(await h.run(create)).returnValue, Ec.OutOfMemory);
});

test('SubmitMessage (MS-OXOMSG): ecTooManyRecips, ecMaxSubmissionExceeded from the server limits; FAI → ecAccessDenied', async () => {
  const h = new Harness();
  await h.logon();
  h.store.limits = { maxMessageBytes: 100, maxRecipients: 1 };
  await outboxMessage(h);
  let r = await h.run(
    rop.modifyRecipients(2, [{ rowId: 0, type: 1, email: 'a@example.test', name: 'A' }, { rowId: 1, type: 2, email: 'b@example.test', name: 'B' }]),
    rop.submitMessage(2),
  );
  ok(r, RopId.ModifyRecipients);
  assert.equal(responseHead(r).returnValue, Ec.TooManyRecips);
  const removeRow1 = new Writer().u8(RopId.ModifyRecipients).u8(0).u8(2).u16(0).u16(1).u32(1).u8(2).u16(0).toBuffer();
  r = await h.run(removeRow1, rop.setProperties(2, [{ tag: TAG.Body, value: 'y'.repeat(200) }]), rop.submitMessage(2));
  ok(r, RopId.ModifyRecipients); ok(r, RopId.SetProperties); r.u16();
  assert.equal(responseHead(r).returnValue, Ec.MaxSubmissionExceeded);
  assert.equal(h.store.sent.length, 0);

  const fai = new Writer().u8(RopId.CreateMessage).u8(0).u8(1).u8(4).u16(1252).u64(h.outbox).u8(1).toBuffer();
  r = await h.run(fai, rop.modifyRecipients(4, [{ rowId: 0, type: 1, email: 'a@example.test', name: 'A' }]), rop.submitMessage(4));
  ok(r, RopId.CreateMessage); r.u8();
  ok(r, RopId.ModifyRecipients);
  assert.equal(responseHead(r).returnValue, Ec.AccessDenied, 'folder associated information is never sent');
});

test('store properties: PidTagMaximumSubmitMessageSize follows the server limit (in KB)', async () => {
  const h = new Harness();
  h.store.limits = { maxMessageBytes: 10 * 1024 * 1024, maxRecipients: 100 };
  await h.logon();
  const r = await h.run(rop.getPropertiesSpecific(0, [Tag.MaximumSubmitMessageSize]));
  ok(r, RopId.GetPropertiesSpecific);
  assert.deepEqual(readRow(r, [Tag.MaximumSubmitMessageSize]), [10 * 1024]);
});

test('QueryRows Origin (MS-OXCTABL): END when a forward read leaves no rows, BEGINNING for a backward one, else CURRENT', async () => {
  const h = new Harness();
  const inbox = h.store.folderByName('mb1', 'INBOX');
  for (const s of ['A', 'B', 'C']) h.store.addMessage(inbox.id, { subject: s });
  await h.logon();
  let r = await h.run(rop.openFolder(0, 1, h.inbox), rop.getContentsTable(1, 2), rop.setColumns(2, [TAG.Subject]), rop.queryRows(2, 2));
  ok(r, RopId.OpenFolder); r.u8(); r.u8(); ok(r, RopId.GetContentsTable); r.u32(); ok(r, RopId.SetColumns); r.u8();
  assert.equal(decodeQueryRows(r, [TAG.Subject]).origin, 1, 'rows left → CURRENT');
  assert.equal(decodeQueryRows(await h.run(rop.queryRows(2, 5)), [TAG.Subject]).origin, 2, 'forward read reached the end → END');
  const back = decodeQueryRows(await h.run(rop.queryRows(2, 2, false)), [TAG.Subject]);
  assert.deepEqual([back.origin, back.rows.map((x) => x[0])], [1, ['B', 'C']], 'backward rows in table order, rows left → CURRENT');
  assert.equal(decodeQueryRows(await h.run(rop.queryRows(2, 5, false)), [TAG.Subject]).origin, 0, 'backward read reached the start → BEGINNING');

  await openByName(h, 'Archive', 3);
  r = await h.run(rop.getContentsTable(3, 4), rop.setColumns(4, [TAG.Subject]), rop.queryRows(4, 5));
  ok(r, RopId.GetContentsTable); r.u32(); ok(r, RopId.SetColumns); r.u8();
  const none = decodeQueryRows(r, [TAG.Subject]);
  assert.deepEqual([none.origin, none.rows.length], [2, 0], 'empty table, forward read → END');
});

test('a row larger than any output buffer: QueryRows fails with ecBufferTooSmall, the next ROP still runs', async () => {
  const h = new Harness();
  const inbox = h.store.folderByName('mb1', 'INBOX');
  h.store.addMessage(inbox.id, { subject: 'S'.repeat(400) });
  await h.logon();
  const cols = Array<number>(100).fill(TAG.Subject);
  const r = await h.run(rop.openFolder(0, 1, h.inbox), rop.getContentsTable(1, 2), rop.setColumns(2, cols), rop.queryRows(2, 1), rop.getReceiveFolder(0));
  ok(r, RopId.OpenFolder); r.u8(); r.u8(); ok(r, RopId.GetContentsTable); r.u32(); ok(r, RopId.SetColumns); r.u8();
  const head = responseHead(r);
  assert.deepEqual([head.ropId, head.returnValue], [RopId.QueryRows, Ec.BufferTooSmall]);
  ok(r, RopId.GetReceiveFolder, 0);
});

test('Restrict: more than MAX_RESTRICTION_NODES nodes → ecTooComplex', async () => {
  const h = new Harness();
  await h.logon();
  const exist = new Writer().u8(0x08).u32(TAG.Subject).toBuffer();
  const or = (n: number): Buffer => Buffer.concat([new Writer().u8(0x01).u16(n).toBuffer(), ...Array<Buffer>(n).fill(exist)]);
  const restrict = (data: Buffer): Buffer => new Writer().u8(RopId.Restrict).u8(0).u8(2).u8(0).u16(data.length).bytes(data).toBuffer();
  const r = await h.run(rop.openFolder(0, 1, h.inbox), rop.getContentsTable(1, 2), restrict(or(MAX_RESTRICTION_NODES)), restrict(or(MAX_RESTRICTION_NODES - 1)));
  ok(r, RopId.OpenFolder); r.u8(); r.u8(); ok(r, RopId.GetContentsTable); r.u32();
  assert.equal(responseHead(r).returnValue, Ec.TooComplex, 'OR + 1024 children = 1025 nodes');
  ok(r, RopId.Restrict); r.u8();
});

test('named properties (MS-OXCPRPT): a read-only logon never registers names; no names on a Logon object lists every ID', async () => {
  const h = new Harness();
  h.store.addMailbox({ mailboxId: 'mb-ro', kind: 'shared', email: 'ro@example.test', displayName: 'RO', readOnly: true, directoryId: 'smro' });
  h.store.access.set('u1', [h.store.mailboxes.get('mb-ro')!]);
  await h.logon();
  const guid = Buffer.from('0820060000000000c000000000000046', 'hex');
  const dn = Buffer.from('/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=smro\u0000', 'ascii');
  const roLogon = new Writer().u8(RopId.Logon).u8(1).u8(1).u8(0x01).u32(0).u32(0).u16(dn.length).bytes(dn).toBuffer();
  const ask = (logonId: number, index: number, lid: number): Buffer =>
    new Writer().u8(RopId.GetPropertyIdsFromNames).u8(logonId).u8(index).u8(0x02).u16(1).u8(0).bytes(guid).u32(lid).toBuffer();
  let r = await h.run(roLogon, ask(1, 1, 0x8540));
  ok(r, RopId.Logon, 1); r.bytes(1 + 13 * 8 + 1 + 16 + 2 + 16 + 8 + 8 + 4);
  assert.equal(responseHead(r).returnValue, Ec.WarnWithErrors);
  assert.deepEqual([r.u16(), r.u16()], [1, 0], 'not registered for a read-only mailbox');
  r = await h.run(ask(0, 0, 0x8541), ask(0, 0, 0x8542));
  ok(r, RopId.GetPropertyIdsFromNames); r.u16(); const a = r.u16();
  ok(r, RopId.GetPropertyIdsFromNames); r.u16(); const b = r.u16();
  r = await h.run(new Writer().u8(RopId.GetPropertyIdsFromNames).u8(0).u8(0).u8(0).u16(0).toBuffer());
  ok(r, RopId.GetPropertyIdsFromNames);
  const all = Array.from({ length: r.u16() }, () => r.u16());
  assert.ok(all.includes(a) && all.includes(b) && a > 0x8000);
});

test('folders of a read-only mailbox: PidTagRights ReadAny | FolderVisible, PidTagAccess read', async () => {
  const h = new Harness();
  h.store.addMailbox({ mailboxId: 'mb2', kind: 'shared', email: 'team@example.test', displayName: 'Team', readOnly: true, directoryId: 'sm1' });
  h.store.access.set('u1', [h.store.mailboxes.get('mb2')!]);
  const ids = decodeLogon(await h.run(rop.logon(0, '/o=CoreMail/ou=X/cn=Recipients/cn=sm1'))).folderIds;
  const r = await h.run(rop.openFolder(0, 1, ids[4]!), rop.getPropertiesSpecific(1, [Tag.Rights, Tag.Access]));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.GetPropertiesSpecific);
  assert.deepEqual(readRow(r, [Tag.Rights, Tag.Access]), [0x401, 0x02]);
});
