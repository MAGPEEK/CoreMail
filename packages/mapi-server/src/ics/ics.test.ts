/**
 * Incremental change synchronization (cached mode): the GLOBSET / IDSET
 * codecs, buffer splitting of FastTransfer streams, and the ROP flows against
 * the in-memory store — initial and incremental contents download (new,
 * changed, deleted, read messages), hierarchy download, the ICS state round
 * trip (upload, final state, checkpoint) and the upload ROPs. Review 9.5:
 * property-based GLOBSET / buffer-splitting / contents-synchronization checks
 * (seeded, reproducible) and the bounds of hostile ICS states.
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
  readGlobset, readIdset, ICS, TAG, Reader, Writer, clientChange, globcntOfId, mergeSizedXids, CLIENT_NAMESPACE,
} from '../testing/mapi-client.js';
import { BufferReader, WireFormatError } from '../wire/reader.js';
import {
  decodeGlobset, encodeGlobset, normalize, rangesOf, GLOBCNT_MAX, IdsetTooLargeError, RANGE_BYTES, type Range,
} from './globset.js';
import { IdSet } from './idset.js';
import { FastTransferSource } from './transfer.js';
import { makeId, replicaGuid, storeGuids } from '../ids.js';
import { LOCAL_ID_BASE } from './keys.js';
import { contentsStateAfter, isRead, planContents, type ContentsInput } from './plan.js';
import { emptyState, type IcsState } from './state.js';
import type { FxPiece } from './fx-stream.js';
import { sessionFootprint } from '../objects/footprint.js';
import { MemoryRedis } from '../testing/memory-redis.js';
import { createRedisLocalIdStore, MAX_REPLACED_IDS } from '../store/local-ids.js';
import { encoderFor } from '../nspi/codepage.js';
import type { MessageSummary } from '../store/types.js';

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

/** The checkpoint state of an upload context (RopSynchronizationGetTransferState + GetBuffer). */
async function collectorState(h: Harness, collectorIndex: number): Promise<Map<number, Buffer>> {
  ok(await h.run(rop.getTransferState(collectorIndex, 9)), RopId.SynchronizationGetTransferState);
  const parts: Buffer[] = [];
  for (;;) {
    const g = decodeGetBuffer(await h.run(rop.getBuffer(9, 0xbabe)));
    parts.push(g.data);
    if (g.status === 3) break;
  }
  return decodeIcsStream(Buffer.concat(parts)).state;
}

/** A download state with an upload context's state merged in (what the client does after uploading). */
function mergeStates(download: Map<number, Buffer>, upload: Map<number, Buffer>): Map<number, Buffer> {
  const out = new Map(download);
  for (const [tag, value] of upload) {
    const mine = out.get(tag);
    out.set(tag, mine ? IdSet.decodeGuidForm(mine).union(IdSet.decodeGuidForm(value)).encodeGuidForm() : value);
  }
  return out;
}

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
  assert.ok(names.includes('Inbox') && names.includes('Projects') && names.includes('Outbox') && names.includes('Old'));
  assert.ok(names.indexOf('Inbox') < names.indexOf('Projects'), 'parents before children');
  const inboxRow = folders.find((f) => f.get(TAG.DisplayName) === 'Inbox')!;
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

test('upload: a new message keeps its client ID (openable at once); read state, deletion and move through the collector; nothing comes back', async () => {
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
  ok(r, RopId.SaveChangesMessage); r.u8();
  assert.equal(r.u64(), makeId(localId), 'SaveChangesMessage returns the client-assigned ID');
  ok(r, RopId.SynchronizationImportReadStateChanges);
  ok(r, RopId.SynchronizationImportDeletes);
  assert.equal(h.store.imported[0]!.message.subject, 'Written offline');
  assert.equal(h.store.imported[0]!.opts.read, true);
  assert.equal((await h.store.findMessage(inbox, mark.summary.uid))!.flags.includes('\\Seen'), true);
  assert.equal(await h.store.findMessage(inbox, drop.summary.uid), null);
  assert.deepEqual(h.store.mapiObjects.filter((o) => o.clientId === localId).length, 1, 'the client ID is kept (persistent MapiObject)');

  // openable by the client's ID at once
  r = await h.run(rop.openMessage(1, 6, h.inbox, makeId(localId)));
  ok(r, RopId.OpenMessage);
  const uploadState = await collectorState(h, 4);
  const server = await h.store.listMessages(inbox);

  const inboxKey = decodeHierarchyStream((await download(h, h.ipmSubtree, ICS.SyncHierarchy, { flags: ICS.FlagUnicode })).stream)
    .find((f) => f.get(TAG.DisplayName) === 'Inbox')!.get(ICS.SourceKey) as Buffer;
  const archiveId = decodeHierarchyStream((await download(h, h.ipmSubtree, ICS.SyncHierarchy, { flags: ICS.FlagUnicode, extra: ICS.ExtraEid })).stream)
    .find((f) => f.get(TAG.DisplayName) === 'Archive')!.get(0x67480014) as bigint;
  r = await h.run(rop.openFolder(0, 6, archiveId), rop.openCollector(6, 7, true),
    rop.importMessageMove(7, inboxKey, sourceKey(BigInt(moveUid)), sourceKey(localId + 1n)));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationOpenCollector);
  ok(r, RopId.SynchronizationImportMessageMove);
  const archived = await h.store.listMessages(h.folder('Archive'));
  assert.equal(archived.length, 1, 'moved through the message store');
  assert.equal(archived[0]!.clientId, localId + 1n, 'the moved message takes the destination ID the client assigned');

  // The client's state: its own message (localId) added by checkpointing, the upload state merged in.
  const state = mergeStates(new Map(initial.state).set(ICS.IdsetGiven,
    IdSet.decodeGuidForm(initial.state.get(ICS.IdsetGiven)!).add(REPLICA, [localId]).encodeGuidForm()), uploadState);
  const next = decodeIcsStream((await download(h, h.inbox, ICS.SyncContents, { state })).stream);
  assert.deepEqual(next.messages, [], 'no echo: neither the uploaded message nor the read change come back');
  assert.deepEqual(next.read, []);
  assert.deepEqual(uidsOf(next.deleted), [drop.summary.uid, moveUid].sort((a, b) => a - b), 'only the deleted and the moved message');
  assert.equal(server.filter((m) => m.subject === 'Written offline').length, 1, 'one copy on the server');
});

test('upload: hierarchy import keeps the client ID of a new folder (openable at once, its messages upload by that ID); default folders cannot be renamed or deleted; read-only mailboxes refuse imports', async () => {
  const h = new Harness();
  await h.logon();
  const before = decodeIcsStream((await download(h, h.ipmSubtree, ICS.SyncHierarchy, { flags: ICS.FlagUnicode })).stream).state;
  let r = await h.run(rop.getLocalReplicaIds(0, 4));
  ok(r, RopId.GetLocalReplicaIds); r.bytes(16);
  const localId = BigInt(r.bytes(6).readUIntBE(0, 6));
  r = await h.run(rop.openFolder(0, 1, h.ipmSubtree), rop.openCollector(1, 4, false),
    rop.importHierarchyChange(4, Buffer.alloc(0), sourceKey(localId), 'Offline Folder'));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationOpenCollector);
  ok(r, RopId.SynchronizationImportHierarchyChange);
  const created = h.store.folders.find((f) => f.displayName === 'Offline Folder')!;
  assert.ok(created);
  assert.equal((await h.store.replacedLocalIds('mb1')).has(localId), false, 'kept, not replaced');
  const hierarchyUpload = await collectorState(h, 4);

  // The folder answers to the client's ID: a message created offline in it uploads through a collector on that ID.
  r = await h.run(rop.openFolder(0, 6, makeId(localId)), rop.openCollector(6, 7, true),
    rop.importMessageChange(7, 8, sourceKey(localId + 1n)), rop.setProperties(8, [{ tag: TAG.Subject, value: 'Filed offline' }]),
    rop.saveChangesMessage(8, 8));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationOpenCollector);
  ok(r, RopId.SynchronizationImportMessageChange); r.u64();
  ok(r, RopId.SetProperties); r.u16();
  ok(r, RopId.SaveChangesMessage);
  assert.deepEqual((await h.store.listMessages(created.id)).map((m) => [m.subject, m.clientId]), [['Filed offline', localId + 1n]]);

  // The folder keeps the client's ID in every download.
  const tree = decodeHierarchyStream((await download(h, h.ipmSubtree, ICS.SyncHierarchy, { flags: ICS.FlagUnicode })).stream);
  assert.deepEqual(tree.find((f) => f.get(TAG.DisplayName) === 'Offline Folder')!.get(ICS.SourceKey), sourceKey(localId));
  // The client's state from before the upload, its own folder added, the upload state merged in: no echo, no deletion.
  const state = mergeStates(new Map(before).set(ICS.IdsetGiven,
    IdSet.decodeGuidForm(before.get(ICS.IdsetGiven)!).add(REPLICA, [localId]).encodeGuidForm()), hierarchyUpload);
  const again = (await download(h, h.ipmSubtree, ICS.SyncHierarchy, { flags: ICS.FlagUnicode, state })).stream;
  assert.deepEqual([decodeHierarchyStream(again).length, decodeIcsStream(again).deleted.length], [0, 0]);

  const inboxKey = tree.find((f) => f.get(TAG.DisplayName) === 'Inbox')!.get(ICS.SourceKey) as Buffer;
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

// ── Cached-mode client model: offline create + edit, server changes, no duplicates, no echo ──

const PCL_TAG = 0x65e30102;
const UNSENT = 0x08;
const UNSENT_READ = UNSENT | 0x01;

/** The MAPI folder ID of a folder row (its counter in the logon's view). */
function folderIdOf(h: Harness, recordId: string): bigint {
  return makeId(h.session.logons.get(0)!.view.ofRecord(recordId)!.counter);
}

interface ClientItem { subject: string; read: boolean; pcl: Buffer | null }

/** A cached-mode client's view of the Drafts folder: its items, pending changes and ICS state. */
class CachedClient {
  readonly items = new Map<bigint, ClientItem>();
  readonly pendingEdits = new Set<bigint>();
  readonly pendingReads = new Map<bigint, boolean>();
  readonly created = new Set<bigint>();
  state = new Map<number, Buffer>();
  pool: bigint[] = [];
  private n = 0;

  constructor(readonly h: Harness, readonly folderId: bigint) {}

  async reserve(): Promise<void> {
    const r = await this.h.run(rop.getLocalReplicaIds(0, 32));
    ok(r, RopId.GetLocalReplicaIds); r.bytes(16);
    const first = BigInt(r.bytes(6).readUIntBE(0, 6));
    this.pool = Array.from({ length: 32 }, (_, i) => first + BigInt(i));
  }

  createOffline(): void {
    const id = this.pool.shift()!;
    this.items.set(id, { subject: `client ${++this.n}`, read: true, pcl: null });
    this.created.add(id);
    this.pendingEdits.add(id);
  }

  edit(id: bigint): void {
    this.items.get(id)!.subject = `edited ${++this.n}`;
    this.pendingEdits.add(id);
  }

  async upload(): Promise<{ uploaded: Set<bigint> }> {
    const uploaded = new Set<bigint>();
    let r = await this.h.run(rop.openFolder(0, 1, this.folderId), rop.openCollector(1, 4, true));
    ok(r, RopId.OpenFolder); r.u8(); r.u8();
    ok(r, RopId.SynchronizationOpenCollector);
    for (const id of this.pendingEdits) {
      const item = this.items.get(id)!;
      const change = clientChange(item.pcl);
      r = await this.h.run(rop.importMessageChange(4, 5, sourceKey(id), 0, change),
        rop.setProperties(5, [{ tag: TAG.Subject, value: item.subject }, { tag: ICS.MessageFlags, value: item.read ? UNSENT_READ : UNSENT }]),
        rop.saveChangesMessage(5, 5), rop.release(5)); // a failed import leaves no object behind
      if (responseHead(r).returnValue === 0) { item.pcl = change.pcl; uploaded.add(id); }
    }
    if (this.pendingReads.size > 0) {
      r = await this.h.run(rop.importReadStateChanges(4, [...this.pendingReads].map(([id, read]) => ({ sourceKey: sourceKey(id), read }))));
      ok(r, RopId.SynchronizationImportReadStateChanges);
    }
    const upload = await collectorState(this.h, 4);
    // Checkpointing: the client's own new objects join IdsetGiven; the upload state is merged in.
    const given = this.state.get(ICS.IdsetGiven);
    const own = [...this.created].filter((id) => uploaded.has(id));
    const merged = (given ? IdSet.decodeGuidForm(given) : new IdSet()).add(REPLICA, own);
    this.state = mergeStates(new Map(this.state).set(ICS.IdsetGiven, merged.encodeGuidForm()), upload);
    this.created.clear();
    this.pendingEdits.clear();
    this.pendingReads.clear();
    return { uploaded };
  }

  async download(): Promise<ReturnType<typeof decodeIcsStream>> {
    const result = decodeIcsStream((await download(this.h, this.folderId, ICS.SyncContents, {
      state: this.state, flags: SYNC_FLAGS, extra: ICS.ExtraEid | ICS.ExtraCN,
    })).stream);
    for (const m of result.messages) {
      const id = globcntOfId(m.header.get(TAG.Mid) as bigint);
      this.items.set(id, {
        subject: m.props.get(TAG.Subject) as string, read: ((m.props.get(ICS.MessageFlags) as number) & 1) !== 0,
        pcl: m.header.get(PCL_TAG) as Buffer,
      });
    }
    for (const id of result.deleted) this.items.delete(id);
    for (const id of result.read) this.items.get(id)!.read = true;
    for (const id of result.unread) this.items.get(id)!.read = false;
    this.state = result.state;
    return result;
  }
}

test('model: offline-created and edited drafts keep their client IDs — no duplicates, no echo of the client\'s own changes, server changes arrive (seeded)', async () => {
  for (const seed of [11, 12, 13]) {
    const rnd = prng(seed);
    const h = new Harness();
    const drafts = h.folder('Drafts');
    const mailbox = h.store.mailboxes.get('mb1')!;
    await h.logon();
    const draftsId = folderIdOf(h, drafts);
    const client = new CachedClient(h, draftsId);
    await client.reserve();
    await client.download();
    let serverDirty = new Set<bigint>();
    const live = async (): Promise<MessageSummary[]> => h.store.listMessages(drafts);
    for (let step = 0; step < 60; step++) {
      const op = Math.floor(rnd() * 7);
      const mine = [...client.items.keys()];
      if (op <= 1 && client.pool.length > 0) client.createOffline();
      else if (op === 2 && mine.length > 0) client.edit(pick(rnd, mine));
      else if (op === 3 && mine.length > 0) { const id = pick(rnd, mine); client.pendingReads.set(id, !client.items.get(id)!.read); client.items.get(id)!.read = !client.items.get(id)!.read; }
      else if (op === 4) serverDirty.add(BigInt(h.store.addMessage(drafts, { flags: ['\\Draft', '\\Seen'], subject: `server ${step}` }).summary.uid));
      else if (op === 5) {
        const rows = await live();
        if (rows.length > 0) { const m = pick(rnd, rows); const id = messageCounterOf(m); await h.store.setRead(mailbox, m, !m.flags.includes('\\Seen')); serverDirty.add(id); }
      } else {
        await client.upload();
        const before = new Set(client.items.keys());
        const result = await client.download();
        // No echo: every message change is a server change or a message the client did not have.
        for (const m of result.messages) {
          const id = globcntOfId(m.header.get(TAG.Mid) as bigint);
          assert.ok(serverDirty.has(id) || !before.has(id), `seed ${seed} step ${step}: echo of ${id}`);
        }
        for (const id of [...result.read, ...result.unread]) assert.ok(serverDirty.has(id), `seed ${seed} step ${step}: read echo of ${id}`);
        serverDirty = new Set();
        const rows = await live();
        assert.deepEqual([...client.items.keys()].sort(), rows.map(messageCounterOf).sort(), `seed ${seed} step ${step}: same messages`);
        for (const m of rows) {
          const item = client.items.get(messageCounterOf(m))!;
          assert.equal(item.subject, m.subject, `seed ${seed} step ${step}: subject of ${messageCounterOf(m)}`);
          assert.equal(item.read, m.flags.includes('\\Seen'), `seed ${seed} step ${step}: read state of ${messageCounterOf(m)}`);
        }
        assert.equal(new Set(rows.map((m) => m.subject)).size, rows.length, `seed ${seed} step ${step}: no duplicates`);
      }
    }
    // The IDs survive a restart: a new session on the same store opens a client-created draft by its ID.
    const ownId = [...client.items.keys()].find((id) => id >= LOCAL_ID_BASE);
    assert.ok(ownId !== undefined, `seed ${seed}: the run created drafts offline`);
    const fresh = new Harness();
    Object.assign(fresh, { store: h.store });
    await fresh.logon();
    const r = await fresh.run(rop.openFolder(0, 1, draftsId), rop.openMessage(1, 2, draftsId, makeId(ownId)));
    ok(r, RopId.OpenFolder); r.u8(); r.u8();
    ok(r, RopId.OpenMessage);
  }
});

const messageCounterOf = (m: MessageSummary): bigint => m.clientId ?? BigInt(m.uid);

test('conflicts: a change based on an older version than another client\'s → server version kept (SyncConflict with FailOnConflict); the same change again → IgnoreFailure; a change based on the current version applies', async () => {
  const h = new Harness();
  const drafts = h.folder('Drafts');
  const draft = h.store.addMessage(drafts, { flags: ['\\Draft', '\\Seen'], subject: 'Plan' });
  await h.logon();
  const draftsId = folderIdOf(h, drafts);
  const first = decodeIcsStream((await download(h, draftsId, ICS.SyncContents, { extra: ICS.ExtraEid })).stream);
  const downloadedPcl = first.messages[0]!.header.get(PCL_TAG) as Buffer;
  const key = sourceKey(BigInt(draft.summary.uid));
  let r = await h.run(rop.openFolder(0, 1, draftsId), rop.openCollector(1, 4, true));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationOpenCollector);
  const edit = async (change: { changeKey: Buffer; pcl: Buffer }, subject: string, flags = 0): Promise<number> => {
    r = await h.run(rop.importMessageChange(4, 5, key, flags, change),
      rop.setProperties(5, [{ tag: TAG.Subject, value: subject }, { tag: ICS.MessageFlags, value: UNSENT_READ }]), rop.saveChangesMessage(5, 5), rop.release(5));
    return responseHead(r).returnValue;
  };
  // Client B (another namespace) edits the downloaded version first.
  const otherGuid = Buffer.alloc(16, 0xb2);
  const bXid = Buffer.concat([otherGuid, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]);
  const bChange = { changeKey: bXid, pcl: mergeSizedXids(downloadedPcl, Buffer.concat([Buffer.from([24]), bXid])) };
  assert.equal(await edit(bChange, 'Plan (B)'), 0);
  assert.equal(await edit(bChange, 'Plan (B)'), 0x80040801, 'the same change again → IgnoreFailure');
  // Client A edits the same downloaded version: neither includes the other.
  assert.equal(await edit(clientChange(downloadedPcl), 'Plan (A)', 0x40), 0x80040802, 'FailOnConflict → SyncConflict');
  assert.equal(await edit(clientChange(downloadedPcl), 'Plan (A)'), 0, 'accepted without FailOnConflict …');
  const rows = await h.store.listMessages(drafts);
  assert.deepEqual(rows.map((m) => m.subject), ['Plan (B)'], '… and the server version (B) is kept, under the same ID');
  assert.equal(messageCounterOf(rows[0]!), BigInt(draft.summary.uid), 'a draft saved again keeps its message ID');
  // A downloads B's version; its PCL carries B's change, so A's next edit applies.
  const second = decodeIcsStream((await download(h, draftsId, ICS.SyncContents, { state: first.state, extra: ICS.ExtraEid })).stream);
  assert.deepEqual(second.messages.map((m) => m.props.get(TAG.Subject)), ['Plan (B)']);
  const serverPcl = second.messages[0]!.header.get(PCL_TAG) as Buffer;
  assert.ok(serverPcl.includes(bXid) && serverPcl.includes(CLIENT_NAMESPACE) === false, 'the downloaded PCL includes B\'s change');
  assert.equal(await edit(clientChange(serverPcl), 'Plan (A2)'), 0);
  assert.deepEqual((await h.store.listMessages(drafts)).map((m) => m.subject), ['Plan (A2)']);
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

// ── Review 9.5: property-based checks and regressions ────────────────────────

/** Deterministic PRNG (mulberry32): reproducible fuzz runs. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rnd: () => number, list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;

const EDGE_VALUES = [
  0n, 1n, 2n, 0xffn, 0x100n, 0x101n, 0xffffn, 0x1_0000n, 0xffff_ffffn, 0x1_0000_0000n, 0xff_ffff_ffffn,
  0x100_0000_0000n, GLOBCNT_MAX - 1n, GLOBCNT_MAX,
];

function randomGlobcnt(rnd: () => number): bigint {
  if (rnd() < 0.3) return pick(rnd, EDGE_VALUES);
  let v = 0n;
  for (let i = 1 + Math.floor(rnd() * 6); i > 0; i--) v = (v << 8n) | BigInt(Math.floor(rnd() * 256));
  return v;
}

const clamp = (v: bigint): bigint => (v > GLOBCNT_MAX ? GLOBCNT_MAX : v);

function randomRanges(rnd: () => number): Range[] {
  const base = randomGlobcnt(rnd);
  return Array.from({ length: Math.floor(rnd() * 12) }, () => {
    const low = clamp(rnd() < 0.5 ? base + BigInt(Math.floor(rnd() * 600)) : randomGlobcnt(rnd));
    return { low, high: clamp(low + (rnd() < 0.5 ? 0n : BigInt(Math.floor(rnd() * 3000)))) };
  });
}

/** Strict check of an encoded GLOBSET: Pop only after Push, an empty stack at End, nothing after End. */
function assertWellFormedGlobset(buf: Buffer): void {
  const pushes: number[] = [];
  let depth = 0;
  let i = 0;
  for (;;) {
    const cmd = buf[i++]!;
    if (cmd === 0x00) break;
    if (cmd >= 0x01 && cmd <= 0x06) {
      assert.ok(depth + cmd <= 6, 'push past six bytes');
      i += cmd;
      if (depth + cmd < 6) { depth += cmd; pushes.push(cmd); }
    } else if (cmd === 0x50) {
      const n = pushes.pop();
      assert.ok(n !== undefined, 'Pop on an empty stack (MS-OXCFXICS 3.1.5.4.3.1.2)');
      depth -= n;
    } else if (cmd === 0x52) {
      i += 2 * (6 - depth);
    } else {
      assert.fail(`unexpected command 0x${cmd.toString(16)}`);
    }
  }
  assert.equal(depth, 0, 'empty stack at End (MS-OXCFXICS 3.1.5.4.3.1.5)');
  assert.equal(i, buf.length, 'nothing after End');
}

test('review: GLOBSET round trip of random sets with edge values (0, byte boundaries, 2^48-1); strict encoding', () => {
  const rnd = prng(0x5eed);
  for (let run = 0; run < 3000; run++) {
    const set = randomRanges(rnd);
    const encoded = encodeGlobset(set);
    assertWellFormedGlobset(encoded);
    const r = new BufferReader(encoded);
    assert.deepEqual(decodeGlobset(r), normalize(set));
    assert.equal(r.atEnd, true);
  }
  // the test client's independent decoder reads the same values
  for (let run = 0; run < 300; run++) {
    const set = randomRanges(rnd).map((x) => ({ low: x.low, high: x.low + ((x.high - x.low) % 40n) }));
    const expected = normalize(set).flatMap((x) => {
      const values: bigint[] = [];
      for (let v = x.low; v <= x.high; v++) values.push(v);
      return values;
    });
    assert.deepEqual(readGlobset(new Reader(encodeGlobset(set))), expected);
  }
});

test('review: decoding random bytes as an ICS state ends with a format or size error — nothing else, no hang', () => {
  const rnd = prng(0xbad5);
  const commands = [0x00, 0x01, 0x04, 0x05, 0x06, 0x42, 0x50, 0x52];
  for (let run = 0; run < 5000; run++) {
    const buf = Buffer.from(Array.from({ length: Math.floor(rnd() * 80) }, () => (rnd() < 0.4 ? pick(rnd, commands) : Math.floor(rnd() * 256))));
    try {
      IdSet.decodeStateValue(buf, (replid) => (replid === 1 ? REPLICA : null), 1000);
    } catch (err) {
      assert.ok(err instanceof WireFormatError || err instanceof IdsetTooLargeError, String(err));
    }
  }
});

test('review: a hostile ICS state is bounded — every GLOBSET of a value shares one range budget; a repeated replica merges in linear time', () => {
  // 3000 GLOBSETs of the same replica with 100 isolated values each: 300 000 ranges
  const parts: Buffer[] = [];
  for (let i = 0; i < 3000; i++) {
    parts.push(REPLICA, encodeGlobset(Array.from({ length: 100 }, (_, j) => {
      const v = 2n * BigInt(i + 3000 * j);
      return { low: v, high: v };
    })));
  }
  const value = Buffer.concat(parts);
  const started = Date.now();
  assert.equal(IdSet.decodeGuidForm(value, 300_000).rangeCount, 300_000);
  assert.ok(Date.now() - started < 10_000, 'merged once per replica, not once per GLOBSET');
  assert.throws(() => IdSet.decodeGuidForm(value, 299_999), IdsetTooLargeError);
  // distinct replicas draw from the same budget
  const many = Buffer.concat(Array.from({ length: 5 }, (_, i) => [
    Buffer.alloc(16, i + 1), encodeGlobset(Array.from({ length: 1000 }, (_, j) => ({ low: BigInt(2 * j), high: BigInt(2 * j) }))),
  ]).flat());
  assert.equal(IdSet.decodeGuidForm(many, 5000).rangeCount, 5000);
  assert.throws(() => IdSet.decodeGuidForm(many, 4999), IdsetTooLargeError);
});

test('review: an uploaded ICS state counts against the session memory; over the budget → ecMAPIOOM, malformed → RpcFormat', async () => {
  const h = new Harness();
  h.session = new MapiSession('s1', { user: USER, credential: 'password', authKey: 'k' }, 'seq', Date.now(), 2 * 1024 * 1024);
  await h.logon();
  let r = await h.run(rop.openFolder(0, 1, h.inbox), rop.syncConfigure(1, 2, ICS.SyncContents, SYNC_FLAGS, EXTRA));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationConfigure);
  const upload = async (tag: number, value: Buffer): Promise<number> => {
    ok(await h.run(rop.uploadStateBegin(2, tag, value.length)), RopId.SynchronizationUploadStateStreamBegin);
    for (let at = 0; at < value.length; at += 16_000) {
      ok(await h.run(rop.uploadStateContinue(2, value.subarray(at, at + 16_000))), RopId.SynchronizationUploadStateStreamContinue);
    }
    return responseHead(await h.run(rop.uploadStateEnd(2))).returnValue;
  };
  const isolated = (n: number): Buffer => IdSet.of(REPLICA, Array.from({ length: n }, (_, i) => BigInt(2 * i + 1))).encodeGuidForm();
  assert.equal(await upload(ICS.IdsetGiven, isolated(5000)), 0);
  assert.ok(sessionFootprint(h.session.objects.all()) >= 5000 * RANGE_BYTES, 'the decoded state counts');
  assert.equal(await upload(ICS.CnsetSeen, isolated(40_000)), 0x8007000e, '40 000 ranges do not fit into the 2 MB budget');
  assert.equal(await upload(ICS.CnsetSeen, Buffer.concat([REPLICA, Buffer.from([0x99])])), 0x000004b6, 'malformed GLOBSET → RpcFormat');
  assert.equal(await upload(ICS.CnsetSeen, isolated(100)), 0, 'the context stays usable');
});

test('review: FastTransfer buffers of random sizes reassemble the stream; no buffer boundary falls inside an atom', async () => {
  const rnd = prng(0xfa57);
  for (let run = 0; run < 300; run++) {
    const elements: FxPiece[][] = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () =>
      Array.from({ length: Math.floor(rnd() * 8) }, (): FxPiece => (rnd() < 0.5
        ? { bytes: Buffer.alloc(pick(rnd, [4, 8, 16]), Math.floor(rnd() * 256)), splittable: false }
        : { bytes: Buffer.alloc(1 + Math.floor(rnd() * 200), Math.floor(rnd() * 256)), splittable: true })));
    const atoms: Array<[number, number]> = [];
    let offset = 0;
    for (const p of elements.flat()) {
      if (!p.splittable) atoms.push([offset, offset + p.bytes.length]);
      offset += p.bytes.length;
    }
    const source = new FastTransferSource(elements[Symbol.iterator](), elements.length);
    const chunks: Buffer[] = [];
    let at = 0;
    for (let i = 0; i < 10_000; i++) {
      const max = 16 + Math.floor(rnd() * 48);
      const c = await source.next(max);
      assert.ok(c.data.length <= max);
      at += c.data.length;
      assert.ok(!atoms.some(([s, e]) => at > s && at < e), `buffer boundary ${at} inside an atom`);
      chunks.push(c.data);
      if (c.done) break;
      assert.ok(c.data.length > 0, 'every Partial buffer makes progress');
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat(elements.flat().map((p) => p.bytes)));
    assert.equal(source.finished, true);
    assert.equal(source.completed, elements.length);
  }
});

test('review: an atom larger than the buffer fails the GetBuffer instead of returning empty Partial buffers forever', async () => {
  const source = new FastTransferSource([[{ bytes: Buffer.alloc(20), splittable: false }]][Symbol.iterator](), 1);
  await assert.rejects(source.next(16), /exceeds/);
});

// ── Model-based contents synchronization ─────────────────────────────────────

interface ModelMessage { uid: number; modSeq: bigint; flags: string[]; createdAt: Date }

/** Flags the client shows (message flags, icon, draft state); \Flagged is not mapped. */
const VISIBLE_FLAGS = ['\\Seen', '\\Answered', '$Forwarded', '\\Draft'];
const visibleFlags = (flags: Iterable<string>): string => {
  const set = new Set(flags);
  return VISIBLE_FLAGS.filter((f) => set.has(f)).join(' ');
};

/** One folder of a mailbox: mailbox-wide UIDs and modSeqs, as in the message store. */
class FolderModel {
  uidNext = 1;
  modSeq = 0n;
  readonly messages = new Map<number, ModelMessage>();

  add(flags: string[]): void {
    const uid = this.uidNext++;
    this.messages.set(uid, { uid, modSeq: ++this.modSeq, flags, createdAt: new Date(1_700_000_000_000 + uid * 1000) });
  }

  private toggle(m: ModelMessage, flag: string): void {
    m.flags = m.flags.includes(flag) ? m.flags.filter((f) => f !== flag) : [...m.flags, flag];
    m.modSeq = ++this.modSeq;
  }

  /** Sets a flag (also when present: a new modSeq). Clearing \Answered / $Forwarded is a documented limit (docs/mapi.md). */
  private set(m: ModelMessage, flag: string): void {
    if (!m.flags.includes(flag)) m.flags = [...m.flags, flag];
    m.modSeq = ++this.modSeq;
  }

  randomChange(rnd: () => number): void {
    const list = [...this.messages.values()];
    const op = Math.floor(rnd() * 8);
    if (list.length === 0 || op === 0) { this.add(rnd() < 0.3 ? ['\\Seen'] : []); return; }
    const m = pick(rnd, list);
    if (op === 1 || op === 2) this.toggle(m, '\\Seen');
    else if (op === 3) this.set(m, rnd() < 0.5 ? '\\Answered' : '$Forwarded');
    else if (op === 4) this.toggle(m, '\\Flagged');
    else if (op === 5) this.messages.delete(m.uid);
    else if (op === 6) { this.messages.delete(m.uid); this.add(m.flags); } // moved away and back: a new UID
    else this.modSeq++; // a change in another folder of the mailbox
  }

  summaries(): MessageSummary[] {
    return [...this.messages.values()].map((m) => ({ uid: m.uid, modSeq: m.modSeq, createdModSeq: m.modSeq, flags: [...m.flags], createdAt: m.createdAt, clientId: null, pcl: null }) as unknown as MessageSummary);
  }
}

interface SyncVariant { readState: boolean; restricted: boolean }

const roundTrip = (s: IcsState): IcsState => ({
  idsetGiven: IdSet.decodeGuidForm(s.idsetGiven.encodeGuidForm()),
  cnsetSeen: IdSet.decodeGuidForm(s.cnsetSeen.encodeGuidForm()),
  cnsetSeenFai: IdSet.decodeGuidForm(s.cnsetSeenFai.encodeGuidForm()),
  cnsetRead: IdSet.decodeGuidForm(s.cnsetRead.encodeGuidForm()),
});

/** One download applied to the client model; an interrupted one keeps the checkpoint state. */
function syncModel(server: FolderModel, client: Map<number, Set<string>>, state: IcsState, rnd: () => number, v: SyncVariant, complete: boolean): { state: IcsState; complete: boolean } {
  const highestModSeq = server.modSeq;
  if (rnd() < 0.2) server.randomChange(rnd); // committed between reading the modSeq and listing the folder
  const inScope = v.restricted ? (m: MessageSummary): boolean => !m.flags.includes('\\Seen') : (): boolean => true;
  const input: ContentsInput = {
    guids: storeGuids('mb1'), messages: server.summaries(), inScope, state: roundTrip(state), highestModSeq, knownClientIds: new Set(),
    options: {
      normal: true, readState: v.readState, noDeletions: false, ignoreNoLongerInScope: false,
      orderByDeliveryTime: rnd() < 0.5, restricted: v.restricted,
    },
  };
  const plan = planContents(input);
  const interrupted = !complete && plan.changes.length > 0 && rnd() < 0.25;
  const sent = interrupted ? Math.floor(rnd() * plan.changes.length) : plan.changes.length;
  for (const m of plan.changes.slice(0, sent)) client.set(m.uid, new Set(m.flags));
  if (interrupted) return { state: contentsStateAfter(input, plan, sent, false), complete: false };
  for (const m of plan.readChanges) {
    const flags = client.get(m.uid);
    assert.ok(flags, `read-state change of message ${m.uid} the client does not have`);
    if (isRead(m)) flags.add('\\Seen'); else flags.delete('\\Seen');
  }
  for (const r of [...plan.deleted, ...plan.noLongerInScope]) for (let id = r.low; id <= r.high; id++) client.delete(Number(id));
  return { state: contentsStateAfter(input, plan, sent, true), complete: true };
}

function assertClientMatches(server: FolderModel, client: Map<number, Set<string>>, v: SyncVariant, step: string): void {
  const expected = [...server.messages.values()].filter((m) => !v.restricted || !m.flags.includes('\\Seen'));
  assert.deepEqual([...client.keys()].sort((a, b) => a - b), expected.map((m) => m.uid).sort((a, b) => a - b), `${step}: messages`);
  for (const m of expected) assert.equal(visibleFlags(client.get(m.uid)!), visibleFlags(m.flags), `${step}: flags of ${m.uid}`);
}

test('review: model-based contents synchronization — after every complete download the client equals the folder (new, changed, read, deleted, moved; interrupted downloads resume from their checkpoint)', () => {
  const variants: SyncVariant[] = [
    { readState: true, restricted: false }, { readState: false, restricted: false }, { readState: true, restricted: true },
  ];
  for (const v of variants) {
    for (const seed of [1, 2, 3, 4]) {
      const rnd = prng(seed * 7919 + (v.readState ? 1 : 0) + (v.restricted ? 2 : 0));
      const server = new FolderModel();
      const client = new Map<number, Set<string>>();
      let state = emptyState();
      for (let step = 0; step < 400; step++) {
        for (let k = Math.floor(rnd() * 3); k > 0; k--) server.randomChange(rnd);
        if (rnd() < 0.5) continue;
        const result = syncModel(server, client, state, rnd, v, step === 399);
        state = result.state;
        if (result.complete) assertClientMatches(server, client, v, `${JSON.stringify(v)} seed ${seed} step ${step}`);
      }
      state = syncModel(server, client, state, rnd, v, true).state;
      assertClientMatches(server, client, v, `${JSON.stringify(v)} seed ${seed} final`);
      const quiet = planContents({
        guids: storeGuids('mb1'), messages: server.summaries(), inScope: v.restricted ? (m) => !m.flags.includes('\\Seen') : () => true,
        state, highestModSeq: server.modSeq, knownClientIds: new Set(),
        options: { normal: true, readState: v.readState, noDeletions: false, ignoreNoLongerInScope: false, orderByDeliveryTime: false, restricted: v.restricted },
      });
      assert.deepEqual([quiet.changes.length, quiet.readChanges.length, quiet.deleted.length], [0, 0, 0], 'nothing is sent twice');
    }
  }
});

test('review: a state of another mailbox (another replica GUID) names nothing here — a full download, no deletions', () => {
  const server = new FolderModel();
  for (let i = 0; i < 5; i++) server.add([]);
  const foreign = emptyState();
  foreign.idsetGiven = IdSet.of(replicaGuid('mb2'), [1n, 2n, 3n, 99n]);
  foreign.cnsetSeen = IdSet.of(replicaGuid('mb2'), [1n, 2n, 3n, 4n, 5n]);
  const plan = planContents({
    guids: storeGuids('mb1'), messages: server.summaries(), inScope: () => true, state: foreign, highestModSeq: server.modSeq,
    knownClientIds: new Set(),
    options: { normal: true, readState: true, noDeletions: false, ignoreNoLongerInScope: false, orderByDeliveryTime: false, restricted: false },
  });
  assert.deepEqual(plan.changes.map((m) => m.uid), [1, 2, 3, 4, 5]);
  assert.deepEqual([plan.readChanges.length, plan.deleted.length, plan.noLongerInScope.length], [0, 0, 0]);
});

// ── Hierarchy, upload and limits ─────────────────────────────────────────────

test('review: hierarchy sync sends a folder again when it returns to an earlier name or place; a folder moved out of the synchronized subtree is deleted', async () => {
  const h = new Harness();
  const mailbox = h.store.mailboxes.get('mb1')!;
  const projects = h.store.addFolder('mb1', 'Projects', null);
  await h.logon();
  const opts = { flags: ICS.FlagUnicode };
  let state = decodeIcsStream((await download(h, h.ipmSubtree, ICS.SyncHierarchy, opts)).stream).state;
  const step = async (): Promise<Array<unknown>> => {
    const stream = (await download(h, h.ipmSubtree, ICS.SyncHierarchy, { ...opts, state })).stream;
    state = decodeIcsStream(stream).state;
    return decodeHierarchyStream(stream).map((f) => f.get(TAG.DisplayName));
  };
  await h.store.renameFolder(mailbox, projects.id, null, 'Renamed');
  assert.deepEqual(await step(), ['Renamed']);
  await h.store.renameFolder(mailbox, projects.id, null, 'Projects');
  assert.deepEqual(await step(), ['Projects'], 'renamed back: the client still shows "Renamed"');
  assert.deepEqual(await step(), [], 'then nothing');

  // A hierarchy synchronization of the Inbox: its subfolder moves to the top level.
  const inboxRecord = h.store.folderByName('mb1', 'INBOX');
  const child = h.store.addFolder('mb1', 'INBOX.Child', inboxRecord.id, 'Child');
  const inboxState = decodeIcsStream((await download(h, h.inbox, ICS.SyncHierarchy, opts)).stream).state;
  await h.store.renameFolder(mailbox, child.id, null, 'Child');
  const moved = decodeIcsStream((await download(h, h.inbox, ICS.SyncHierarchy, { ...opts, state: inboxState })).stream);
  assert.equal(moved.deleted.length, 1, 'the folder left the synchronized subtree');
});

test('review: hierarchy import of an unchanged special folder below the root is accepted; changing it is still refused', async () => {
  const h = new Harness();
  await h.logon();
  const finder = sourceKey(8n); // SpecialCounter.Finder, a child of the root folder
  let r = await h.run(rop.openFolder(0, 1, h.root), rop.openCollector(1, 4, false), rop.importHierarchyChange(4, Buffer.alloc(0), finder, 'Finder'));
  ok(r, RopId.OpenFolder); r.u8(); r.u8();
  ok(r, RopId.SynchronizationOpenCollector);
  ok(r, RopId.SynchronizationImportHierarchyChange);
  r = await h.run(rop.importHierarchyChange(4, Buffer.alloc(0), finder, 'Search'));
  assert.equal(responseHead(r).returnValue, 0x80070005);
});

test('review: replaced client IDs per mailbox are capped (the oldest go); client IDs per session are bounded', async () => {
  const redis = new MemoryRedis();
  let clock = 0;
  const ids = createRedisLocalIdStore(() => redis, () => ++clock);
  const many = Array.from({ length: MAX_REPLACED_IDS + 5 }, (_, i) => LOCAL_ID_BASE + BigInt(i));
  await ids.addReplaced('mb1', many);
  const kept = await ids.replaced('mb1');
  assert.equal(kept.size, MAX_REPLACED_IDS);
  assert.equal(kept.has(LOCAL_ID_BASE), false, 'the oldest entry went');
  assert.equal(kept.has(many.at(-1)!), true);

  const h = new Harness();
  await h.logon();
  const batch = Array.from({ length: 64 }, () => rop.getLocalReplicaIds(0, 0x10000));
  for (let i = 0; i < 4; i++) {
    const res = await h.run(...batch);
    for (let k = 0; k < 64; k++) { ok(res, RopId.GetLocalReplicaIds); res.bytes(22); }
  }
  assert.equal(responseHead(await h.run(rop.getLocalReplicaIds(0, 1))).returnValue, 0x000004d9, 'the 257th batch is refused');
});

test('review: address book ISO-8859 code pages keep their C1 controls (no Windows characters at 0x80–0x9F)', () => {
  assert.equal(encoderFor(28591)!('€\u0080é').toString('hex'), '3f80e9');
  assert.equal(encoderFor(28599)!('€\u0080ş').toString('hex'), '3f80fe');
  assert.equal(encoderFor(1252)!('€\u0080é').toString('hex'), '803fe9', 'Windows-1252 has the euro sign at 0x80');
});
