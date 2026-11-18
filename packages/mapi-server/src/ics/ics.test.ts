/**
 * Incremental change synchronization (cached mode): the GLOBSET / IDSET
 * codecs, buffer splitting of FastTransfer streams, and the ROP flows against
 * the in-memory store — initial and incremental contents download (new,
 * changed, deleted, read messages), hierarchy download, the ICS state round
 * trip (upload, final state, checkpoint) and the upload ROPs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeRopBuffer } from '../rop/engine.js';
import { ROP_REGISTRY } from '../rop/registry.js';
import { RopId } from '../rop/codes.js';
import { HANDLE_UNUSED } from '../rop/handles.js';
import { MapiSession } from '../session/session.js';
import { MemoryStore } from '../testing/memory-store.js';
import {
  rop, ropInput, ropOutput, decodeLogon, responseHead, decodeGetBuffer, decodeIcsStream, decodeHierarchyStream,
  readGlobset, readIdset, ICS, TAG, Reader, Writer,
} from '../testing/mapi-client.js';
import { BufferReader, WireFormatError } from '../wire/reader.js';
import { decodeGlobset, encodeGlobset, rangesOf, type Range } from './globset.js';
import { IdSet } from './idset.js';
import { FastTransferSource } from './transfer.js';
import { makeId, replicaGuid } from '../ids.js';
import { LOCAL_ID_BASE } from './keys.js';

const U = HANDLE_UNUSED;
const USER = { userId: 'u1', email: 'user@example.test', displayName: 'User One', domainId: 'd1' };
const REPLICA = replicaGuid('mb1');
const SYNC_FLAGS = ICS.FlagUnicode | ICS.FlagNormal | ICS.FlagReadState;
const EXTRA = ICS.ExtraEid | ICS.ExtraMessageSize | ICS.ExtraCN;

function sourceKey(globcnt: bigint): Buffer {
  const b = Buffer.alloc(22);
  REPLICA.copy(b, 0);
  b.writeUIntBE(Number(globcnt), 16, 6);
  return b;
}

class Harness {
  store = new MemoryStore();
  session = new MapiSession('s1', { user: USER, credential: 'password', authKey: 'k' }, 'seq', Date.now());
  handles: number[] = Array.from({ length: 10 }, () => U);
  folderIds: bigint[] = [];

  constructor() {
    this.store.addMailbox({ mailboxId: 'mb1', kind: 'own', email: USER.email, displayName: USER.displayName, readOnly: false, directoryId: 'u1' });
  }

  folder(name: string): string { return this.store.folderByName('mb1', name).id; }

  async run(...rops: Buffer[]): Promise<Reader> {
    const out = ropOutput(await executeRopBuffer(ropInput(rops, this.handles), { session: this.session, store: this.store, registry: ROP_REGISTRY }, 0x8000));
    this.handles = out.handles;
    return out.responses;
  }

  async logon(): Promise<void> {
    this.folderIds = decodeLogon(await this.run(rop.logon(0))).folderIds;
  }

  get root(): bigint { return this.folderIds[0]!; }
  get ipmSubtree(): bigint { return this.folderIds[3]!; }
  get inbox(): bigint { return this.folderIds[4]!; }
}

function ok(r: Reader, ropId: number): void {
  const head = responseHead(r);
  assert.equal(head.ropId, ropId);
  assert.equal(head.returnValue, 0, `ROP 0x${ropId.toString(16)} returned 0x${head.returnValue.toString(16)}`);
}

interface DownloadOptions { state?: Map<number, Buffer>; bufferSize?: number; flags?: number; extra?: number }

/** OpenFolder + Configure + state upload + GetBuffer until Done. */
async function download(h: Harness, folderId: bigint, type: number, opts: DownloadOptions = {}): Promise<{ stream: Buffer; statuses: number[] }> {
  let r = await h.run(rop.openFolder(0, 1, folderId), rop.syncConfigure(1, 2, type, opts.flags ?? SYNC_FLAGS, opts.extra ?? EXTRA));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationConfigure);
  for (const [tag, value] of opts.state ?? []) {
    r = await h.run(rop.uploadStateBegin(2, tag, value.length), rop.uploadStateContinue(2, value), rop.uploadStateEnd(2));
    ok(r, RopId.SynchronizationUploadStateStreamBegin);
    ok(r, RopId.SynchronizationUploadStateStreamContinue);
    ok(r, RopId.SynchronizationUploadStateStreamEnd);
  }
  const parts: Buffer[] = [];
  const statuses: number[] = [];
  for (let i = 0; i < 10_000; i++) {
    const g = decodeGetBuffer(await h.run(rop.getBuffer(2, opts.bufferSize ?? 0xbabe)));
    assert.equal(g.returnValue, 0);
    parts.push(g.data);
    statuses.push(g.status);
    if (g.status === 0x0003) break;
  }
  return { stream: Buffer.concat(parts), statuses };
}

const uidsOf = (values: bigint[]): number[] => values.map(Number).sort((a, b) => a - b);

// ── Codecs ───────────────────────────────────────────────────────────────────

test('GLOBSET: round trip of singletons, ranges and wide spreads; the client decoder reads the server encoding', () => {
  const sets: Range[][] = [
    [],
    [{ low: 5n, high: 5n }],
    [{ low: 1n, high: 100n }],
    rangesOf([1n, 2n, 3n, 7n, 0x1_0000_0000n, 0x8000_1234_5678n, 0xffff_ffff_ffffn]),
    [{ low: 0x10n, high: 0x2fn }, { low: 0x1000n, high: 0x1000n }, { low: 0x4000_0000_0000n, high: 0x4000_0000_00ffn }],
  ];
  for (const set of sets) {
    const encoded = encodeGlobset(set);
    assert.deepEqual(decodeGlobset(new BufferReader(encoded)), set);
    const values = readGlobset(new Reader(encoded));
    const expected: bigint[] = [];
    for (const r of set) for (let v = r.low; v <= r.high && expected.length < 1000; v++) expected.push(v);
    if (expected.length < 1000) assert.deepEqual(values, expected);
  }
});

test('GLOBSET: the Bitmask example of the specification and malformed command sequences', () => {
  // five common bytes, StartingValue 0x01, Bitmask 0xEB → {1-3, 5, 7-9} (MS-OXCFXICS 3.1.5.4.3.1.3)
  const bitmask = Buffer.from([0x05, 0, 0, 0, 0, 0, 0x42, 0x01, 0xeb, 0x50, 0x00]);
  assert.deepEqual(decodeGlobset(new BufferReader(bitmask)), [{ low: 1n, high: 3n }, { low: 5n, high: 5n }, { low: 7n, high: 9n }]);
  // a sixth pushed byte is a singleton and needs no Pop
  assert.deepEqual(decodeGlobset(new BufferReader(Buffer.from([0x04, 0, 0, 0, 0, 0x02, 0, 0x09, 0x50, 0x00]))), [{ low: 9n, high: 9n }]);
  for (const bad of [[0x50, 0x00], [0x04, 0, 0, 0, 0, 0x42, 1, 1, 0x00], [0x07], [0x99], [0x52, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 1, 0]]) {
    assert.throws(() => decodeGlobset(new BufferReader(Buffer.from(bad))), WireFormatError, JSON.stringify(bad));
  }
});

test('IDSET: REPLGUID form (state) and REPLID form (deletions) round trip; set operations', () => {
  const set = IdSet.of(REPLICA, [1n, 2n, 3n, 10n]);
  const other = Buffer.alloc(16, 0xab);
  set.add(other, [7n]);
  const decoded = IdSet.decodeGuidForm(set.encodeGuidForm());
  assert.equal(decoded.has(REPLICA, 2n), true);
  assert.equal(decoded.has(other, 7n), true, 'entries of other replicas survive');
  const replid = set.encodeReplidForm((g) => (g.equals(REPLICA) ? 1 : null));
  assert.deepEqual(readIdset(replid, false), [1n, 2n, 3n, 10n], 'only the replica with a REPLID');
  assert.deepEqual(IdSet.decodeReplidForm(replid, () => REPLICA).ranges(REPLICA), [{ low: 1n, high: 3n }, { low: 10n, high: 10n }]);
  const u = set.union(IdSet.of(REPLICA, [4n])).remove(REPLICA, [2n]);
  assert.deepEqual(u.ranges(REPLICA), [{ low: 1n, high: 1n }, { low: 3n, high: 4n }, { low: 10n, high: 10n }]);
  assert.equal(set.has(REPLICA, 4n), false, 'union returns a new set');
});

test('FastTransfer buffers: atoms are never split, variable-size values may be; Done on the last buffer', async () => {
  async function* elements() {
    yield [{ bytes: Buffer.alloc(4, 1), splittable: false }, { bytes: Buffer.alloc(40, 2), splittable: true }];
    yield [{ bytes: Buffer.alloc(8, 3), splittable: false }, { bytes: Buffer.alloc(8, 4), splittable: false }];
  }
  const source = new FastTransferSource(elements(), 2);
  const chunks: Array<{ size: number; done: boolean }> = [];
  for (;;) {
    const c = await source.next(16);
    chunks.push({ size: c.data.length, done: c.done });
    if (c.done) break;
  }
  assert.deepEqual(chunks, [
    { size: 16, done: false }, { size: 16, done: false }, { size: 12, done: false }, { size: 16, done: true },
  ], '4+12 | 16 | 12 (the next 8-byte atom does not fit into 4) | 8+8');
  assert.equal(source.completed, 2);
});

// ── Download ─────────────────────────────────────────────────────────────────

test('initial contents sync: every message with header, properties, recipients and attachments in small buffers; final state', async () => {
  const h = new Harness();
  const inbox = h.folder('INBOX');
  const a = h.store.addMessage(inbox, { subject: 'First', bodyText: 'Hello first', toAddrs: ['x@example.test', 'y@example.test'] });
  const b = h.store.addMessage(inbox, {
    subject: 'With file', flags: ['\\Seen'], attachments: [{ id: 'att1', filename: 'a.txt', mimeType: 'text/plain', size: 600, contentId: null, inline: false, data: Buffer.alloc(600, 0x41) }],
  });
  h.store.addMessage(h.folder('Sent'), { subject: 'Elsewhere' });
  await h.logon();
  const { stream, statuses } = await download(h, h.inbox, ICS.SyncContents, { bufferSize: 128 });
  assert.ok(statuses.length > 5 && statuses.slice(0, -1).every((s) => s === 0x0001), 'Partial until the last buffer');
  const res = decodeIcsStream(stream);
  assert.equal(res.ended, true);
  assert.deepEqual(res.messages.map((m) => m.props.get(TAG.Subject)), ['First', 'With file']);
  const [first, second] = res.messages;
  assert.deepEqual(first!.header.get(ICS.SourceKey), sourceKey(BigInt(a.summary.uid)));
  assert.equal(first!.header.get(TAG.Mid), makeId(BigInt(a.summary.uid)), 'Eid → PidTagMid');
  assert.equal(first!.header.get(ICS.ChangeNumber), makeId(a.summary.modSeq), 'CN → PidTagChangeNumber = modSeq');
  assert.equal(first!.header.get(0x0e080003), 1234, 'MessageSize');
  assert.equal(first!.props.get(TAG.Body), 'Hello first');
  assert.deepEqual(first!.recipients.map((r) => r.get(TAG.SmtpAddress)), ['x@example.test', 'y@example.test']);
  assert.equal((second!.props.get(ICS.MessageFlags) as number) & 1, 1, 'read');
  assert.equal(second!.attachments.length, 1);
  assert.equal((second!.attachments[0]!.get(0x37010102) as Buffer).length, 600, 'attachment data across buffers');
  assert.deepEqual(uidsOf(readIdset(res.state.get(ICS.IdsetGiven)!, true)), [a.summary.uid, b.summary.uid]);
  const seen = readIdset(res.state.get(ICS.CnsetSeen)!, true);
  assert.ok(seen.includes(a.summary.modSeq) && seen.includes(b.summary.modSeq) && seen.includes(1n), 'every CN up to the highest modSeq is seen');
});

test('incremental contents sync: new, changed, deleted and read messages; then nothing to send', async () => {
  const h = new Harness();
  const inbox = h.folder('INBOX');
  const keep = h.store.addMessage(inbox, { subject: 'Keep' });
  const gone = h.store.addMessage(inbox, { subject: 'Gone' });
  const replied = h.store.addMessage(inbox, { subject: 'Replied' });
  await h.logon();
  const initial = decodeIcsStream((await download(h, h.inbox, ICS.SyncContents)).stream);

  await h.store.setRead(h.store.mailboxes.get('mb1')!, keep.summary, true);
  await h.store.deleteMessages(h.store.mailboxes.get('mb1')!, inbox, [gone.summary.uid]);
  replied.summary.flags.push('\\Answered');
  await h.store.setRead(h.store.mailboxes.get('mb1')!, replied.summary, true); // a new modSeq; the icon changed too
  const fresh = h.store.addMessage(inbox, { subject: 'Fresh' });

  const delta = decodeIcsStream((await download(h, h.inbox, ICS.SyncContents, { state: initial.state })).stream);
  assert.deepEqual(delta.messages.map((m) => m.props.get(TAG.Subject)), ['Replied', 'Fresh'], 'full changes: the replied one and the new one');
  assert.deepEqual(uidsOf(delta.read), [keep.summary.uid], 'IncrSyncRead: only the read state of "Keep"');
  assert.deepEqual(delta.unread, []);
  assert.deepEqual(uidsOf(delta.deleted), [gone.summary.uid], 'IncrSyncDel');
  assert.deepEqual(uidsOf(readIdset(delta.state.get(ICS.IdsetGiven)!, true)), [keep.summary.uid, replied.summary.uid, fresh.summary.uid]);

  const quiet = decodeIcsStream((await download(h, h.inbox, ICS.SyncContents, { state: delta.state })).stream);
  assert.deepEqual([quiet.messages.length, quiet.read.length, quiet.deleted.length], [0, 0, 0]);
  assert.equal(quiet.ended, true);

  const noReadState = decodeIcsStream((await download(h, h.inbox, ICS.SyncContents, { state: initial.state, flags: ICS.FlagUnicode | ICS.FlagNormal })).stream);
  assert.ok(noReadState.messages.some((m) => m.props.get(TAG.Subject) === 'Keep'), 'without ReadState a read change is a full change');
});

test('ICS state round trip: GetTransferState returns the uploaded state, then the final state; a checkpoint holds only what was sent', async () => {
  const h = new Harness();
  const inbox = h.folder('INBOX');
  for (let i = 0; i < 3; i++) h.store.addMessage(inbox, { subject: `M${i}`, bodyText: 'x'.repeat(2000) });
  await h.logon();
  const initial = decodeIcsStream((await download(h, h.inbox, ICS.SyncContents)).stream);
  h.store.addMessage(inbox, { subject: 'M3' });

  const transferState = async (): Promise<Map<number, Buffer>> => {
    ok(await h.run(rop.getTransferState(2, 3)), RopId.SynchronizationGetTransferState);
    const parts: Buffer[] = [];
    for (;;) {
      const g = decodeGetBuffer(await h.run(rop.getBuffer(3, 0xbabe)));
      parts.push(g.data);
      if (g.status === 3) break;
    }
    return decodeIcsStream(Buffer.concat(parts)).state;
  };

  let r = await h.run(rop.openFolder(0, 1, h.inbox), rop.syncConfigure(1, 2, ICS.SyncContents, SYNC_FLAGS, EXTRA));
  ok(r, RopId.OpenFolder); r.u8(); r.u8(); ok(r, RopId.SynchronizationConfigure);
  for (const [tag, value] of initial.state) {
    r = await h.run(rop.uploadStateBegin(2, tag, value.length), rop.uploadStateContinue(2, value), rop.uploadStateEnd(2));
  }
  const uploaded = await transferState();
  for (const tag of [ICS.IdsetGiven, ICS.CnsetSeen, ICS.CnsetRead]) assert.deepEqual(uploaded.get(tag), initial.state.get(tag), `0x${tag.toString(16)}`);

  const parts: Buffer[] = [];
  for (;;) {
    const g = decodeGetBuffer(await h.run(rop.getBuffer(2, 0xbabe)));
    parts.push(g.data);
    if (g.status === 3) break;
  }
  const final = decodeIcsStream(Buffer.concat(parts)).state;
  const checkpoint = await transferState();
  for (const tag of [ICS.IdsetGiven, ICS.CnsetSeen, ICS.CnsetRead]) assert.deepEqual(checkpoint.get(tag), final.get(tag), 'after Done: the final state');

  // mid-download: only completely sent messages count
  const h2 = new Harness();
  for (const size of [10, 20_000, 10]) h2.store.addMessage(h2.folder('INBOX'), { subject: 'B', bodyText: 'y'.repeat(size) });
  await h2.logon();
  r = await h2.run(rop.openFolder(0, 1, h2.inbox), rop.syncConfigure(1, 2, ICS.SyncContents, SYNC_FLAGS, 0));
  decodeGetBuffer(await h2.run(rop.getBuffer(2, 4000)));
  r = await h2.run(rop.getTransferState(2, 3));
  const cp: Buffer[] = [];
  for (;;) { const g = decodeGetBuffer(await h2.run(rop.getBuffer(3, 0xbabe))); cp.push(g.data); if (g.status === 3) break; }
  const given = readIdset(decodeIcsStream(Buffer.concat(cp)).state.get(ICS.IdsetGiven)!, true);
  assert.equal(given.length, 1, 'only the small first message was sent completely in the first 4000 bytes');
});

test('hierarchy sync: the folder tree (parents first, empty parent key at the root), then a rename and a deletion', async () => {
  const h = new Harness();
  const mailbox = h.store.mailboxes.get('mb1')!;
  const projects = h.store.addFolder('mb1', 'INBOX.Projects', h.folder('INBOX'), 'Projects');
  const old = h.store.addFolder('mb1', 'Old', null);
  await h.logon();
  const initialStream = (await download(h, h.ipmSubtree, ICS.SyncHierarchy, { flags: ICS.FlagUnicode })).stream;
  const folders = decodeHierarchyStream(initialStream);
  const names = folders.map((f) => f.get(TAG.DisplayName));
  assert.ok(names.includes('INBOX') && names.includes('Projects') && names.includes('Outbox') && names.includes('Old'));
  assert.ok(names.indexOf('INBOX') < names.indexOf('Projects'), 'parents before children');
  const inboxRow = folders.find((f) => f.get(TAG.DisplayName) === 'INBOX')!;
  assert.equal((inboxRow.get(ICS.ParentSourceKey) as Buffer).length, 0, 'child of the synchronization root');
  assert.deepEqual(folders.find((f) => f.get(TAG.DisplayName) === 'Projects')!.get(ICS.ParentSourceKey), inboxRow.get(ICS.SourceKey));
  const state = decodeIcsStream(initialStream).state;
  assert.equal(state.has(ICS.CnsetRead), false, 'hierarchy state: IdsetGiven + CnsetSeen only');

  await h.store.renameFolder(mailbox, projects.id, null, 'Projects 2026');
  await h.store.deleteFolder(mailbox, old.id);
  const deltaStream = (await download(h, h.ipmSubtree, ICS.SyncHierarchy, { flags: ICS.FlagUnicode, state })).stream;
  assert.deepEqual(decodeHierarchyStream(deltaStream).map((f) => f.get(TAG.DisplayName)), ['Projects 2026']);
  const deleted = decodeIcsStream(deltaStream).deleted;
  assert.equal(deleted.length, 1);
  assert.deepEqual(sourceKey(deleted[0]!), folders.find((f) => f.get(TAG.DisplayName) === 'Old')!.get(ICS.SourceKey));
});

// ── Upload ───────────────────────────────────────────────────────────────────

test('upload: a new message (client ID), read state, deletion and move through the collector; the next download swaps the client copy', async () => {
  const h = new Harness();
  const inbox = h.folder('INBOX');
  const mark = h.store.addMessage(inbox, { subject: 'Mark me' });
  const drop = h.store.addMessage(inbox, { subject: 'Drop me' });
  const moveUid = h.store.addMessage(inbox, { subject: 'Move me' }).summary.uid;
  await h.logon();
  const initial = decodeIcsStream((await download(h, h.inbox, ICS.SyncContents)).stream);

  let r = await h.run(rop.getLocalReplicaIds(0, 4));
  ok(r, RopId.GetLocalReplicaIds);
  assert.deepEqual(r.bytes(16), REPLICA);
  const localId = BigInt(r.bytes(6).readUIntBE(0, 6));
  assert.ok(localId >= LOCAL_ID_BASE, 'client IDs above every UID');

  r = await h.run(
    rop.openFolder(0, 1, h.inbox), rop.openCollector(1, 4, true),
    rop.importMessageChange(4, 5, sourceKey(localId)),
    rop.setProperties(5, [{ tag: TAG.Subject, value: 'Written offline' }, { tag: TAG.Body, value: 'Offline body' }, { tag: ICS.MessageFlags, value: 1 }]),
    rop.saveChangesMessage(5, 5),
    rop.importReadStateChanges(4, [{ sourceKey: sourceKey(BigInt(mark.summary.uid)), read: true }]),
    rop.importDeletes(4, 0, [sourceKey(BigInt(drop.summary.uid))]),
  );
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationOpenCollector);
  ok(r, RopId.SynchronizationImportMessageChange);
  assert.equal(r.u64(), 0n, 'MessageId 0');
  ok(r, RopId.SetProperties); r.u16();
  ok(r, RopId.SaveChangesMessage); r.u8(); r.u64();
  ok(r, RopId.SynchronizationImportReadStateChanges);
  ok(r, RopId.SynchronizationImportDeletes);
  assert.equal(h.store.imported[0]!.message.subject, 'Written offline');
  assert.equal(h.store.imported[0]!.opts.read, true);
  assert.equal((await h.store.findMessage(inbox, mark.summary.uid))!.flags.includes('\\Seen'), true);
  assert.equal(await h.store.findMessage(inbox, drop.summary.uid), null);

  const inboxKey = decodeHierarchyStream((await download(h, h.ipmSubtree, ICS.SyncHierarchy, { flags: ICS.FlagUnicode })).stream)
    .find((f) => f.get(TAG.DisplayName) === 'INBOX')!.get(ICS.SourceKey) as Buffer;
  const archiveId = decodeHierarchyStream((await download(h, h.ipmSubtree, ICS.SyncHierarchy, { flags: ICS.FlagUnicode, extra: ICS.ExtraEid })).stream)
    .find((f) => f.get(TAG.DisplayName) === 'Archive')!.get(0x67480014) as bigint;
  r = await h.run(rop.openFolder(0, 6, archiveId), rop.openCollector(6, 7, true),
    rop.importMessageMove(7, inboxKey, sourceKey(BigInt(moveUid)), sourceKey(localId + 1n)));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationOpenCollector);
  ok(r, RopId.SynchronizationImportMessageMove);
  assert.equal((await h.store.listMessages(h.folder('Archive'))).length, 1, 'moved through the message store');

  // The client's state now also names its own copy (localId): the next download replaces it.
  const given = IdSet.decodeGuidForm(initial.state.get(ICS.IdsetGiven)!).add(REPLICA, [localId]);
  const state = new Map(initial.state).set(ICS.IdsetGiven, given.encodeGuidForm());
  const next = decodeIcsStream((await download(h, h.inbox, ICS.SyncContents, { state })).stream);
  assert.ok(next.deleted.includes(localId), 'the client-created copy is reported deleted');
  assert.ok(next.deleted.includes(BigInt(drop.summary.uid)) && next.deleted.includes(BigInt(moveUid)));
  assert.deepEqual(next.messages.map((m) => m.props.get(TAG.Subject)), ['Written offline'], 'the server copy arrives');
  assert.deepEqual(uidsOf(next.read), [mark.summary.uid]);
});

test('upload: hierarchy import creates a folder (client ID replaced); default folders cannot be renamed or deleted; read-only mailboxes refuse imports', async () => {
  const h = new Harness();
  await h.logon();
  let r = await h.run(rop.getLocalReplicaIds(0, 1));
  ok(r, RopId.GetLocalReplicaIds); r.bytes(16);
  const localId = BigInt(r.bytes(6).readUIntBE(0, 6));
  r = await h.run(rop.openFolder(0, 1, h.ipmSubtree), rop.openCollector(1, 4, false),
    rop.importHierarchyChange(4, Buffer.alloc(0), sourceKey(localId), 'Offline Folder'));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationOpenCollector);
  ok(r, RopId.SynchronizationImportHierarchyChange);
  assert.ok(h.store.folders.some((f) => f.displayName === 'Offline Folder'));
  assert.equal((await h.store.replacedLocalIds('mb1')).has(localId), true);

  const tree = decodeHierarchyStream((await download(h, h.ipmSubtree, ICS.SyncHierarchy, { flags: ICS.FlagUnicode })).stream);
  const inboxKey = tree.find((f) => f.get(TAG.DisplayName) === 'INBOX')!.get(ICS.SourceKey) as Buffer;
  r = await h.run(rop.openFolder(0, 1, h.ipmSubtree), rop.openCollector(1, 4, false),
    rop.importHierarchyChange(4, Buffer.alloc(0), inboxKey, 'Renamed Inbox'), rop.importDeletes(4, 0x01, [inboxKey]));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationOpenCollector);
  assert.equal(responseHead(r).returnValue, 0x80070005, 'rename of the Inbox → AccessDenied');
  assert.equal(responseHead(r).returnValue, 0x80070005, 'deleting the Inbox → AccessDenied');

  const ro = new Harness();
  ro.store.mailboxes.get('mb1')!.readOnly = true;
  await ro.logon();
  r = await ro.run(rop.openFolder(0, 1, ro.inbox), rop.openCollector(1, 4, true), rop.importDeletes(4, 0, [sourceKey(1n)]));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationOpenCollector);
  assert.equal(responseHead(r).returnValue, 0x80070005, 'read-only mailbox');
});

test('LongTermIdFromId / IdFromLongTermId map IDs of this replica both ways', async () => {
  const h = new Harness();
  await h.logon();
  const id = h.inbox;
  const r = await h.run(new Writer().u8(RopId.LongTermIdFromId).u8(0).u8(0).u64(id).toBuffer());
  ok(r, RopId.LongTermIdFromId);
  const longTerm = r.bytes(24);
  assert.deepEqual(longTerm.subarray(0, 16), REPLICA);
  const back = await h.run(new Writer().u8(RopId.IdFromLongTermId).u8(0).u8(0).bytes(longTerm).toBuffer());
  ok(back, RopId.IdFromLongTermId);
  assert.equal(back.u64(), id);
});
