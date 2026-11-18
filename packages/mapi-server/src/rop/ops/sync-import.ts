/**
 * Incremental change synchronization — upload (MS-OXCFXICS 2.2.3.2.4,
 * MS-OXCROPS 2.2.13): RopSynchronizationOpenCollector and the imports
 * RopSynchronizationImportMessageChange / HierarchyChange / Deletes /
 * ReadStateChanges / MessageMove, plus RopGetLocalReplicaIds and
 * RopSetLocalReplicaMidsetDeleted. Every write goes through the MailStore
 * (message store, raw originals, folder helpers) like the online ROPs.
 *
 * Objects are named by source keys. A server object (a stored message, a
 * folder) keeps its ID; an object the client created offline (an ID from
 * RopGetLocalReplicaIds) is stored under a new server ID and its client ID is
 * remembered as replaced, so the next download swaps the client's copy for
 * the server's. A change to a message the server no longer has is dropped
 * (the deletion wins). Folder associated information is accepted and not
 * kept. A stored message is never rewritten: an imported change of a received
 * message applies its read state; a changed draft replaces the draft.
 */
import { Ec, RopError, RopId } from '../codes.js';
import { assertWritable, defineRop, objectOf, okResponse, putObject, type RopContext, type RopDef } from '../context.js';
import type { BufferReader } from '../../wire/reader.js';
import { lookupProperty, stringProp } from '../../props/bag.js';
import { MessageFlag, Tag, propIdOf } from '../../props/tags.js';
import { readTaggedValue, type PropValue, type TaggedValue } from '../../props/values.js';
import { globcntOfSourceKey, isLocalReplicaId, isServerMessageId } from '../../ics/keys.js';
import { emptyState, type SyncKind } from '../../ics/state.js';
import { MAX_LOCAL_IDS_PER_REQUEST } from '../../store/local-ids.js';
import { composeMessage } from './compose.js';
import { folderNode, folderRecordId, refreshView } from './common.js';
import type { FolderNode } from '../../objects/mailbox-view.js';
import type { LogonState, MessageState, SyncUpload } from '../../objects/state.js';
import { MailboxFullError, type MailStore } from '../../store/types.js';

const IMPORT_ASSOCIATED = 0x10;
const IMPORT_HIERARCHY = 0x01;
const SEEN = '\\Seen';
const DRAFT = '\\Draft';

function readValues(r: BufferReader): TaggedValue[] {
  const n = r.u16();
  const out: TaggedValue[] = [];
  for (let i = 0; i < n; i++) out.push(readTaggedValue(r));
  return out;
}

function valueOf(values: readonly TaggedValue[], tag: number): PropValue | undefined {
  return values.find((v) => propIdOf(v.tag) === propIdOf(tag))?.value;
}

function binaryOf(values: readonly TaggedValue[], tag: number): Buffer {
  const v = valueOf(values, tag);
  if (!Buffer.isBuffer(v)) throw new RopError(Ec.InvalidParameter, `0x${tag.toString(16)} missing`);
  return v;
}

/** The upload context at `index`, which must collect `kind` changes, on a writable mailbox. */
function collector(ctx: RopContext, index: number, kind: SyncKind): { logon: LogonState; sync: SyncUpload } {
  const obj = objectOf(ctx, index, 'syncUpload');
  if (obj.sync.kind !== kind) throw new RopError(Ec.InvalidParameter, `not a ${kind} collector`);
  assertWritable(obj.logon);
  return obj;
}

async function collectorFolder(ctx: RopContext, logon: LogonState, sync: SyncUpload): Promise<string> {
  await refreshView(ctx.store, logon);
  return folderRecordId(folderNode(logon, sync.folderCounter));
}

// ── RopSynchronizationOpenCollector ──────────────────────────────────────────

interface OpenCollectorReq { inputIndex: number; outputIndex: number; contents: boolean }

export const ropOpenCollector = defineRop<OpenCollectorReq>({
  id: RopId.SynchronizationOpenCollector,
  name: 'RopSynchronizationOpenCollector',
  parse: (r) => ({ inputIndex: r.u8(), outputIndex: r.u8(), contents: r.u8() !== 0 }),
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const { logon, counter } = objectOf(ctx, req.inputIndex, 'folder');
    const sync: SyncUpload = { kind: req.contents ? 'contents' : 'hierarchy', folderCounter: counter, state: emptyState(), stateUpload: null };
    putObject(ctx, req.outputIndex, { kind: 'syncUpload', logon, sync }, req.logonId);
    return okResponse(RopId.SynchronizationOpenCollector, req.outputIndex).toBuffer();
  },
});

// ── RopSynchronizationImportMessageChange ────────────────────────────────────

interface ImportMessageReq { inputIndex: number; outputIndex: number; importFlag: number; values: TaggedValue[] }

export const ropImportMessageChange = defineRop<ImportMessageReq>({
  id: RopId.SynchronizationImportMessageChange,
  name: 'RopSynchronizationImportMessageChange',
  parse: (r) => ({ inputIndex: r.u8(), outputIndex: r.u8(), importFlag: r.u8(), values: readValues(r) }),
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const { logon, sync } = collector(ctx, req.inputIndex, 'contents');
    const folderId = await collectorFolder(ctx, logon, sync);
    const gc = globcntOfSourceKey(logon.guids, binaryOf(req.values, Tag.SourceKey));
    let imported: MessageState['imported'];
    if (gc !== null && isServerMessageId(gc)) {
      const summary = await ctx.store.findMessage(folderId, Number(gc));
      imported = summary ? { kind: 'existing', summary } : { kind: 'gone' };
    } else {
      imported = { kind: 'new', folderId, localId: gc !== null && isLocalReplicaId(gc) ? gc : null };
    }
    // The server object starts without client-settable properties (3.2.5.9.4.2).
    const message: MessageState = {
      folderCounter: sync.folderCounter, counter: ctx.session.nextDraftCounter(), summary: null, props: new Map(),
      recipients: [], attachments: [], nextAttachNum: 0, readOnly: false, contentLoaded: true, submitted: false,
      associated: (req.importFlag & IMPORT_ASSOCIATED) !== 0, imported,
    };
    putObject(ctx, req.outputIndex, { kind: 'message', logon, message }, req.logonId);
    return okResponse(RopId.SynchronizationImportMessageChange, req.outputIndex).u64(0n).toBuffer();
  },
});

function messageFlags(message: MessageState): number | null {
  const r = lookupProperty(message.props, Tag.MessageFlags);
  return r.found && 'value' in r && typeof r.value === 'number' ? r.value : null;
}

function messageDate(message: MessageState): Date | null {
  for (const t of [Tag.ClientSubmitTime, Tag.MessageDeliveryTime]) {
    const r = lookupProperty(message.props, t);
    if (r.found && 'value' in r && r.value instanceof Date) return r.value;
  }
  return null;
}

const quotaError = (err: unknown): never => {
  throw err instanceof MailboxFullError ? new RopError(Ec.QuotaExceeded, err.message) : err;
};

/** RopSaveChangesMessage of a message created by RopSynchronizationImportMessageChange. */
export async function saveImported(store: MailStore, logon: LogonState, message: MessageState): Promise<void> {
  const target = message.imported;
  if (!target || message.associated || target.kind === 'gone') return;
  const flags = messageFlags(message);
  const read = flags !== null && (flags & MessageFlag.Read) !== 0;
  const unsent = flags !== null && (flags & MessageFlag.Unsent) !== 0;
  if (target.kind === 'existing') {
    const s = target.summary;
    if (s.flags.includes(DRAFT) && unsent) {
      const saved = await store.saveDraft(logon.mailbox, s.folderId, await composeMessage(store, message), s).catch(quotaError);
      message.counter = BigInt(saved.uid);
    } else if (flags !== null && s.flags.includes(SEEN) !== read) {
      await store.setRead(logon.mailbox, s, read);
    }
    return;
  }
  const composed = await composeMessage(store, message);
  const saved = unsent
    ? await store.saveDraft(logon.mailbox, target.folderId, composed, null).catch(quotaError)
    : await store.importMessage(logon.mailbox, target.folderId, composed, { read, date: messageDate(message) }).catch(quotaError);
  message.counter = BigInt(saved.uid);
  if (target.localId !== null) await store.addReplacedLocalIds(logon.mailbox.mailboxId, [target.localId]);
}

// ── RopSynchronizationImportHierarchyChange ──────────────────────────────────

interface ImportHierarchyReq { inputIndex: number; hierarchy: TaggedValue[]; values: TaggedValue[] }

/** The parent named by PidTagParentSourceKey (empty: the folder the collector was opened on). */
function parentOf(logon: LogonState, sync: SyncUpload, key: Buffer): FolderNode {
  if (key.length === 0) return folderNode(logon, sync.folderCounter);
  const gc = globcntOfSourceKey(logon.guids, key);
  if (gc === null) throw new RopError(Ec.NotFound, 'unknown parent folder');
  return folderNode(logon, gc);
}

export const ropImportHierarchyChange = defineRop<ImportHierarchyReq>({
  id: RopId.SynchronizationImportHierarchyChange,
  name: 'RopSynchronizationImportHierarchyChange',
  parse: (r) => ({ inputIndex: r.u8(), hierarchy: readValues(r), values: readValues(r) }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon, sync } = collector(ctx, req.inputIndex, 'hierarchy');
    const view = await refreshView(ctx.store, logon);
    const parent = parentOf(logon, sync, binaryOf(req.hierarchy, Tag.ParentSourceKey));
    const name = (stringProp(new Map(req.hierarchy.map((v) => [v.tag, v.value])), Tag.DisplayName) ?? '').trim();
    if (!name) throw new RopError(Ec.InvalidParameter, 'empty folder name');
    if (!parent.record && parent.special !== 'ipmSubtree') throw new RopError(Ec.AccessDenied, 'folders cannot be created here');
    const gc = globcntOfSourceKey(logon.guids, binaryOf(req.hierarchy, Tag.SourceKey));
    const existing = gc !== null ? view.get(gc) : undefined;
    if (existing) {
      await updateFolder(ctx.store, logon, existing, parent, name);
    } else {
      const sibling = view.children(parent.counter).find((c) => c.displayName.toLowerCase() === name.toLowerCase());
      if (!sibling) {
        const result = await ctx.store.createFolder(logon.mailbox, parent.record, name);
        if (result === 'invalid-name') throw new RopError(Ec.InvalidParameter, 'reserved folder name');
        if (result === 'exists') throw new RopError(Ec.CollidingNames, 'a folder with this name exists');
      }
      if (gc !== null && isLocalReplicaId(gc)) await ctx.store.addReplacedLocalIds(logon.mailbox.mailboxId, [gc]);
    }
    await refreshView(ctx.store, logon);
    return okResponse(RopId.SynchronizationImportHierarchyChange, req.inputIndex).u64(0n).toBuffer();
  },
});

/** Rename / move of a stored folder; special and default folders keep their place and name. */
async function updateFolder(store: MailStore, logon: LogonState, node: FolderNode, parent: FolderNode, name: string): Promise<void> {
  if (node.displayName === name && node.parentCounter === parent.counter) return;
  if (!node.record || node.role) throw new RopError(Ec.AccessDenied, 'this folder cannot be renamed or moved');
  const result = await store.renameFolder(logon.mailbox, node.record.id, parent.record, name);
  if (result === 'exists') throw new RopError(Ec.CollidingNames, 'a folder with this name exists');
  if (result === 'invalid-name') throw new RopError(Ec.InvalidParameter, 'invalid folder name or target');
  if (result === 'not-found') throw new RopError(Ec.NotFound);
}

// ── RopSynchronizationImportDeletes ──────────────────────────────────────────

interface ImportDeletesReq { inputIndex: number; flags: number; values: TaggedValue[] }

function sourceKeysOf(values: readonly TaggedValue[]): Buffer[] {
  const v = values[0]?.value;
  const keys = Array.isArray(v) ? v.filter((x): x is Buffer => Buffer.isBuffer(x)) : [];
  if (!Array.isArray(v) || keys.length !== v.length) throw new RopError(Ec.InvalidParameter, 'PtypMultipleBinary of source keys expected');
  return keys;
}

export const ropImportDeletes = defineRop<ImportDeletesReq>({
  id: RopId.SynchronizationImportDeletes,
  name: 'RopSynchronizationImportDeletes',
  parse: (r) => ({ inputIndex: r.u8(), flags: r.u8(), values: readValues(r) }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const hierarchy = (req.flags & IMPORT_HIERARCHY) !== 0;
    const { logon, sync } = collector(ctx, req.inputIndex, hierarchy ? 'hierarchy' : 'contents');
    const ids = sourceKeysOf(req.values).map((k) => globcntOfSourceKey(logon.guids, k)).filter((x): x is bigint => x !== null);
    if (hierarchy) {
      const view = await refreshView(ctx.store, logon);
      const nodes = ids.map((id) => view.get(id)).filter((n): n is FolderNode => n !== undefined);
      if (nodes.some((n) => !n.record || n.role)) throw new RopError(Ec.AccessDenied, 'this folder cannot be deleted');
      for (const n of nodes) await ctx.store.deleteFolder(logon.mailbox, n.record!.id, true);
      await refreshView(ctx.store, logon);
    } else {
      const folderId = await collectorFolder(ctx, logon, sync);
      const uids = ids.filter(isServerMessageId).map(Number);
      if (uids.length > 0) await ctx.store.deleteMessages(logon.mailbox, folderId, uids);
    }
    return okResponse(RopId.SynchronizationImportDeletes, req.inputIndex).toBuffer();
  },
});

// ── RopSynchronizationImportReadStateChanges ─────────────────────────────────

interface ReadStateReq { inputIndex: number; states: Array<{ key: Buffer; read: boolean }> }

function readMessageReadStates(r: BufferReader): Array<{ key: Buffer; read: boolean }> {
  const out: Array<{ key: Buffer; read: boolean }> = [];
  while (!r.atEnd) out.push({ key: r.bytes(r.u16()), read: r.u8() !== 0 });
  return out;
}

export const ropImportReadStateChanges = defineRop<ReadStateReq>({
  id: RopId.SynchronizationImportReadStateChanges,
  name: 'RopSynchronizationImportReadStateChanges',
  parse(r) {
    const inputIndex = r.u8();
    return { inputIndex, states: readMessageReadStates(r.slice(r.u16())) };
  },
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon, sync } = collector(ctx, req.inputIndex, 'contents');
    const folderId = await collectorFolder(ctx, logon, sync);
    for (const s of req.states) {
      const gc = globcntOfSourceKey(logon.guids, s.key);
      if (gc === null || !isServerMessageId(gc)) continue; // not on the server: nothing to mark
      const summary = await ctx.store.findMessage(folderId, Number(gc));
      if (summary && summary.flags.includes(SEEN) !== s.read) await ctx.store.setRead(logon.mailbox, summary, s.read);
    }
    return okResponse(RopId.SynchronizationImportReadStateChanges, req.inputIndex).toBuffer();
  },
});

// ── RopSynchronizationImportMessageMove ──────────────────────────────────────

interface MoveReq { inputIndex: number; sourceFolder: Buffer; sourceMessage: Buffer; destinationMessage: Buffer }

export const ropImportMessageMove = defineRop<MoveReq>({
  id: RopId.SynchronizationImportMessageMove,
  name: 'RopSynchronizationImportMessageMove',
  parse(r) {
    const inputIndex = r.u8();
    const sourceFolder = r.bytes(r.u32());
    const sourceMessage = r.bytes(r.u32());
    r.bytes(r.u32()); // PredecessorChangeList
    const destinationMessage = r.bytes(r.u32());
    r.bytes(r.u32()); // ChangeNumber
    return { inputIndex, sourceFolder, sourceMessage, destinationMessage };
  },
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon, sync } = collector(ctx, req.inputIndex, 'contents');
    const targetId = await collectorFolder(ctx, logon, sync);
    const folder = globcntOfSourceKey(logon.guids, req.sourceFolder);
    const sourceId = folder !== null ? logon.view.get(folder)?.record?.id : undefined;
    const uid = globcntOfSourceKey(logon.guids, req.sourceMessage);
    if (!sourceId || uid === null || !isServerMessageId(uid)) throw new RopError(Ec.NotFound, 'source message not found');
    const moved = await ctx.store.moveOrCopy(
      { mailbox: logon.mailbox, folderId: sourceId }, { mailbox: logon.mailbox, folderId: targetId }, [Number(uid)], false,
    );
    if (moved === 0) throw new RopError(Ec.NotFound, 'source message not found');
    const local = globcntOfSourceKey(logon.guids, req.destinationMessage);
    if (local !== null && isLocalReplicaId(local)) await ctx.store.addReplacedLocalIds(logon.mailbox.mailboxId, [local]);
    return okResponse(RopId.SynchronizationImportMessageMove, req.inputIndex).u64(0n).toBuffer();
  },
});

// ── RopGetLocalReplicaIds / RopSetLocalReplicaMidsetDeleted ──────────────────

interface LocalIdsReq { inputIndex: number; count: number }

export const ropGetLocalReplicaIds = defineRop<LocalIdsReq>({
  id: RopId.GetLocalReplicaIds,
  name: 'RopGetLocalReplicaIds',
  parse: (r) => ({ inputIndex: r.u8(), count: r.u32() }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon } = objectOf(ctx, req.inputIndex, 'logon');
    if (req.count < 1 || req.count > MAX_LOCAL_IDS_PER_REQUEST) throw new RopError(Ec.InvalidParameter, 'IdCount out of range');
    assertWritable(logon);
    const first = await ctx.store.reserveLocalIds(logon.mailbox.mailboxId, req.count);
    const gc = Buffer.alloc(6);
    gc.writeUIntBE(Number(first), 0, 6);
    return okResponse(RopId.GetLocalReplicaIds, req.inputIndex).bytes(logon.guids.replica).bytes(gc).toBuffer();
  },
});

interface MidsetDeletedReq { inputIndex: number }

export const ropSetLocalReplicaMidsetDeleted = defineRop<MidsetDeletedReq>({
  id: RopId.SetLocalReplicaMidsetDeleted,
  name: 'RopSetLocalReplicaMidsetDeleted',
  parse(r) {
    const inputIndex = r.u8();
    r.bytes(r.u16()); // ranges of unused client IDs: nothing on the server refers to them
    return { inputIndex };
  },
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    objectOf(ctx, req.inputIndex, 'folder', 'logon');
    return okResponse(RopId.SetLocalReplicaMidsetDeleted, req.inputIndex).toBuffer();
  },
});

export const syncImportRops: RopDef[] = [
  ropOpenCollector, ropImportMessageChange, ropImportHierarchyChange, ropImportDeletes, ropImportReadStateChanges,
  ropImportMessageMove, ropGetLocalReplicaIds, ropSetLocalReplicaMidsetDeleted,
];
