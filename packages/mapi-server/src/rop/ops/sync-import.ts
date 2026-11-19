/**
 * Incremental change synchronization — upload (MS-OXCFXICS 2.2.3.2.4,
 * MS-OXCROPS 2.2.13): RopSynchronizationOpenCollector and the imports
 * RopSynchronizationImportMessageChange / HierarchyChange / Deletes /
 * ReadStateChanges / MessageMove, plus RopGetLocalReplicaIds and
 * RopSetLocalReplicaMidsetDeleted. Every write goes through the MailStore
 * (message store, raw originals, folder helpers) like the online ROPs.
 *
 * Objects are named by source keys. Client-assigned IDs (3.3.5.2.1): an object
 * the client created keeps the ID it assigned when that ID comes from a range
 * RopGetLocalReplicaIds handed to this mailbox and no object has used it
 * (MapiObject, persistent) — so the object is reachable by that ID at once and
 * a later change updates it; a draft saved again keeps its ID. An ID that
 * cannot be kept is replaced by a server ID (the next download swaps the
 * client's copy). Folder associated information is accepted and not kept. A
 * stored message is never rewritten: an imported change of a received
 * message applies its read state; a changed draft replaces the draft.
 *
 * The collector's ICS state records the change number of every change written
 * (CnsetSeen; read states: CnsetRead), so the client's next download does not
 * send its own changes back (3.2.5.9.4.3–3.2.5.9.4.6).
 *
 * Conflict detection on RopSynchronizationImportMessageChange (3.1.5.6.1) with
 * the uploaded PidTagPredecessorChangeList against the stored content version
 * (ics/keys contentPcl): the server version includes the client's → the
 * change is already known (IgnoreFailure); the client's includes the server's
 * → it is applied; neither → conflict: with FailOnConflict the ROP fails with
 * SyncConflict, otherwise the server version is kept and the client receives
 * it with the next download (CoreMail's resolution — no conflict resolve
 * message, docs/mapi.md). A change of a message that is gone (deleted, moved
 * away) is dropped.
 */
import { Ec, RopError, RopId } from '../codes.js';
import { assertWritable, defineRop, objectOf, okResponse, putObject, type RopContext, type RopDef } from '../context.js';
import type { BufferReader } from '../../wire/reader.js';
import { lookupProperty, stringProp } from '../../props/bag.js';
import { MessageFlag, Tag, propIdOf } from '../../props/tags.js';
import { readTaggedValue, type PropValue, type TaggedValue } from '../../props/values.js';
import {
  contentPcl, folderChangeNumber, globcntOfSourceKey, isLocalReplicaId, isServerMessageId, messageCounter, parsePcl, pclIncludes,
} from '../../ics/keys.js';
import { emptyState, type IcsState, type SyncKind } from '../../ics/state.js';
import { MAX_LOCAL_IDS_PER_REQUEST, MAX_LOCAL_IDS_PER_SESSION } from '../../store/local-ids.js';
import { composeMessage } from './compose.js';
import { folderNode, folderRecordId, keepMessageId, refreshView } from './common.js';
import type { StoreGuids } from '../../ids.js';
import type { FolderNode } from '../../objects/mailbox-view.js';
import type { ImportTarget, LogonState, MessageState, SyncUpload } from '../../objects/state.js';
import { MailboxFullError, type MailStore, type MessageSummary } from '../../store/types.js';

const IMPORT_ASSOCIATED = 0x10;
const IMPORT_FAIL_ON_CONFLICT = 0x40;
const IMPORT_HIERARCHY = 0x01;
const SEEN = '\\Seen';
const DRAFT = '\\Draft';
/** Largest PidTagPredecessorChangeList kept (a PCL holds one XID per replica that changed the object). */
const MAX_PCL_BYTES = 4096;

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

/** The uploaded PCL (null: none or too large to keep). */
function uploadedPcl(values: readonly TaggedValue[]): Buffer | null {
  const v = valueOf(values, Tag.PredecessorChangeList);
  return Buffer.isBuffer(v) && v.length > 0 && v.length <= MAX_PCL_BYTES ? v : null;
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

/** Records a written change number in the collector's state (3.2.5.9.4). */
function recordChange(state: IcsState, guids: StoreGuids, cn: bigint, readOnly = false): void {
  (readOnly ? state.cnsetRead : state.cnsetSeen).add(guids.replica, [cn]);
}

/**
 * A client ID a new object may keep: from a range RopGetLocalReplicaIds handed
 * to this mailbox (when the counter is known) and used by no object yet.
 */
async function keepableClientId(store: MailStore, mailboxId: string, id: bigint): Promise<boolean> {
  if (!isLocalReplicaId(id)) return false;
  const below = await store.localIdsHandedOutBelow(mailboxId);
  if (below !== null && id >= below) return false;
  return (await store.clientIdOwner(mailboxId, id)) === null;
}

/** Binds a client ID to a new object when it may keep it, else remembers it as replaced; returns whether it was kept. */
async function adoptOrReplace(store: MailStore, mailboxId: string, target: { messageId: string } | { folderId: string }, id: bigint | null): Promise<boolean> {
  if (id === null) return false;
  if (await keepableClientId(store, mailboxId, id)) {
    await store.bindMapiObject(mailboxId, target, { clientId: id });
    return true;
  }
  if (isLocalReplicaId(id)) await store.addReplacedLocalIds(mailboxId, [id]);
  return false;
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

/** The version decision of 3.1.5.6.1: the server already has it, the client's is newer, or a conflict. */
export function compareVersions(guids: StoreGuids, stored: MessageSummary, uploaded: Buffer | null): 'known' | 'newer' | 'conflict' {
  if (!uploaded) return 'newer'; // no PCL: nothing to compare, the change applies
  const client = parsePcl(uploaded);
  const server = contentPcl(guids, stored);
  if (pclIncludes(server, client)) return 'known';
  return pclIncludes(client, server) ? 'newer' : 'conflict';
}

async function messageImportTarget(
  ctx: RopContext, logon: LogonState, sync: SyncUpload, folderId: string, req: ImportMessageReq,
): Promise<ImportTarget> {
  const id = globcntOfSourceKey(logon.guids, binaryOf(req.values, Tag.SourceKey));
  const pcl = uploadedPcl(req.values);
  const uploadState = sync.state;
  if (id === null) return { kind: 'new', folderId, clientId: null, replacedId: null, pcl, uploadState }; // a foreign source key
  const stored = (await ctx.store.findMessagesByCounters(folderId, [id])).get(id);
  if (stored) {
    const verdict = compareVersions(logon.guids, stored, pcl);
    if (verdict === 'known') throw new RopError(Ec.SyncIgnore, 'the server has this change or a successor');
    if (verdict === 'newer') return { kind: 'existing', summary: stored, pcl, uploadState };
    if (req.importFlag & IMPORT_FAIL_ON_CONFLICT) throw new RopError(Ec.SyncConflict, 'conflicting versions');
    return { kind: 'dropped' }; // conflict: the server version stays and is downloaded next
  }
  // Not in this folder: a server message or a kept client ID that is gone (deleted, moved away) — the deletion wins.
  if (isServerMessageId(id) || (await ctx.store.clientIdOwner(logon.mailbox.mailboxId, id)) !== null) return { kind: 'dropped' };
  return { kind: 'new', folderId, clientId: id, replacedId: null, pcl, uploadState };
}

export const ropImportMessageChange = defineRop<ImportMessageReq>({
  id: RopId.SynchronizationImportMessageChange,
  name: 'RopSynchronizationImportMessageChange',
  parse: (r) => ({ inputIndex: r.u8(), outputIndex: r.u8(), importFlag: r.u8(), values: readValues(r) }),
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const { logon, sync } = collector(ctx, req.inputIndex, 'contents');
    const folderId = await collectorFolder(ctx, logon, sync);
    const associated = (req.importFlag & IMPORT_ASSOCIATED) !== 0;
    const imported: ImportTarget = associated ? { kind: 'dropped' } : await messageImportTarget(ctx, logon, sync, folderId, req);
    // The server object starts without client-settable properties (3.2.5.9.4.2).
    const message: MessageState = {
      folderCounter: sync.folderCounter, counter: ctx.session.nextDraftCounter(), summary: null, props: new Map(),
      recipients: [], attachments: [], nextAttachNum: 0, readOnly: false, contentLoaded: true, submitted: false,
      associated, imported,
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

/** A stored row and the change numbers written for it. */
interface Saved { row: MessageSummary; cns: bigint[] }

/** Drafts are stored read; one uploaded unread (Read flag clear) gets that read state afterwards. */
async function withDraftReadState(store: MailStore, logon: LogonState, row: MessageSummary, read: boolean): Promise<Saved> {
  const cn = read ? null : await store.setRead(logon.mailbox, row, false);
  if (cn === null) return { row, cns: [row.modSeq] };
  return { row: { ...row, flags: row.flags.filter((f) => f !== SEEN), modSeq: cn }, cns: [row.modSeq, cn] };
}

/** The upload's Unsent / Read flags (null: PidTagMessageFlags not set). */
function uploadedFlags(message: MessageState): { unsent: boolean; read: boolean } | null {
  const flags = messageFlags(message);
  return flags === null ? null : { unsent: (flags & MessageFlag.Unsent) !== 0, read: (flags & MessageFlag.Read) !== 0 };
}

/** Applies an imported change of a stored message. */
async function saveExisting(store: MailStore, logon: LogonState, message: MessageState, s: MessageSummary, pcl: Buffer | null): Promise<Saved> {
  const mailboxId = logon.mailbox.mailboxId;
  const flags = uploadedFlags(message);
  if (s.flags.includes(DRAFT) && flags?.unsent) {
    const saved = await store.saveDraft(logon.mailbox, s.folderId, await composeMessage(store, message), s).catch(quotaError);
    return withDraftReadState(store, logon, await keepMessageId(store, mailboxId, s, saved, pcl), flags.read);
  }
  const cn = flags && s.flags.includes(SEEN) !== flags.read ? await store.setRead(logon.mailbox, s, flags.read) : null;
  if (pcl) await store.bindMapiObject(mailboxId, { messageId: s.id }, { pcl }); // the client's version is the stored one now
  return { row: { ...s, pcl: pcl ?? s.pcl }, cns: cn === null ? [] : [cn] };
}

/** Stores a message the client created (no change numbers to record when its ID could not be kept). */
async function saveNew(store: MailStore, logon: LogonState, message: MessageState, target: Extract<ImportTarget, { kind: 'new' }>): Promise<Saved> {
  const flags = uploadedFlags(message);
  const read = flags?.read ?? false;
  const composed = await composeMessage(store, message);
  const saved = flags?.unsent
    ? await store.saveDraft(logon.mailbox, target.folderId, composed, null).catch(quotaError)
    : await store.importMessage(logon.mailbox, target.folderId, composed, { read, date: messageDate(message) }).catch(quotaError);
  const mailboxId = logon.mailbox.mailboxId;
  const kept = await adoptOrReplace(store, mailboxId, { messageId: saved.id }, target.clientId);
  if (target.pcl) await store.bindMapiObject(mailboxId, { messageId: saved.id }, { pcl: target.pcl });
  const row = { ...saved, clientId: kept ? target.clientId : null, pcl: target.pcl };
  const done = flags?.unsent ? await withDraftReadState(store, logon, row, read) : { row, cns: [row.modSeq] };
  // A replaced ID is not recorded: the next download sends the server copy that replaces the client's.
  return kept ? done : { row: done.row, cns: [] };
}

/** RopSaveChangesMessage of a message created by RopSynchronizationImportMessageChange. */
export async function saveImported(store: MailStore, logon: LogonState, message: MessageState): Promise<void> {
  const target = message.imported;
  if (!target || message.associated || target.kind === 'dropped') return;
  const saved = target.kind === 'existing'
    ? await saveExisting(store, logon, message, target.summary, target.pcl)
    : await saveNew(store, logon, message, target);
  for (const cn of saved.cns) recordChange(target.uploadState, logon.guids, cn);
  message.summary = saved.row;
  message.counter = messageCounter(saved.row);
  // A second save of the same object changes the stored message, never adds another one.
  message.imported = { kind: 'existing', summary: saved.row, pcl: saved.row.pcl, uploadState: target.uploadState };
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
    const gc = globcntOfSourceKey(logon.guids, binaryOf(req.hierarchy, Tag.SourceKey));
    const existing = gc !== null ? view.get(gc) : undefined;
    // An unchanged folder (also a special one outside the IPM subtree) is accepted as it is.
    const unchanged = existing !== undefined && existing.displayName === name && existing.parentCounter === parent.counter;
    if (!unchanged && !parent.record && parent.special !== 'ipmSubtree') {
      throw new RopError(Ec.AccessDenied, 'folders cannot be created or moved here');
    }
    let changed: string | null = null; // the folder row whose new state the client has
    if (existing) {
      await updateFolder(ctx.store, logon, existing, parent, name);
      changed = existing.record?.id ?? null;
    } else {
      changed = await createFolder(ctx.store, logon, view.children(parent.counter), parent, name, gc);
    }
    const after = await refreshView(ctx.store, logon);
    const node = changed !== null ? after.ofRecord(changed) : undefined;
    if (node) recordChange(sync.state, logon.guids, folderChangeNumber(node));
    return okResponse(RopId.SynchronizationImportHierarchyChange, req.inputIndex).u64(0n).toBuffer();
  },
});

/**
 * A folder the client created: stored under the client's ID when it may keep
 * it; a folder of that name that exists already takes its place (the client's
 * ID is replaced). Returns the row of a folder that kept the client's ID.
 */
async function createFolder(store: MailStore, logon: LogonState, siblings: FolderNode[], parent: FolderNode, name: string, gc: bigint | null): Promise<string | null> {
  const mailboxId = logon.mailbox.mailboxId;
  if (siblings.some((c) => c.displayName.toLowerCase() === name.toLowerCase())) {
    if (gc !== null && isLocalReplicaId(gc)) await store.addReplacedLocalIds(mailboxId, [gc]);
    return null;
  }
  const result = await store.createFolder(logon.mailbox, parent.record, name);
  if (result === 'invalid-name') throw new RopError(Ec.InvalidParameter, 'reserved folder name');
  if (result === 'exists') throw new RopError(Ec.CollidingNames, 'a folder with this name exists');
  return (await adoptOrReplace(store, mailboxId, { folderId: result.id }, gc)) ? result.id : null;
}

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
      // Messages already gone are ignored (3.2.5.9.4.5).
      const stored = await ctx.store.findMessagesByCounters(folderId, ids);
      const uids = [...stored.values()].map((m) => m.uid);
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
    const wanted = new Map<bigint, boolean>();
    for (const s of req.states) {
      const gc = globcntOfSourceKey(logon.guids, s.key);
      if (gc !== null) wanted.set(gc, s.read); // other keys: not on the server, nothing to mark
    }
    const stored = await ctx.store.findMessagesByCounters(folderId, [...wanted.keys()]);
    for (const [gc, summary] of stored) {
      const read = wanted.get(gc)!;
      if (summary.flags.includes(SEEN) === read) continue;
      const cn = await ctx.store.setRead(logon.mailbox, summary, read);
      if (cn !== null) recordChange(sync.state, logon.guids, cn, true);
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
    const id = globcntOfSourceKey(logon.guids, req.sourceMessage);
    const source = sourceId && id !== null ? (await ctx.store.findMessagesByCounters(sourceId, [id])).get(id) : undefined;
    if (!sourceId || !source) throw new RopError(Ec.NotFound, 'source message not found');
    const moved = await ctx.store.moveOrCopy(
      { mailbox: logon.mailbox, folderId: sourceId }, { mailbox: logon.mailbox, folderId: targetId }, [source.uid], false,
    );
    if (moved === 0) throw new RopError(Ec.NotFound, 'source message not found');
    // A move keeps the row: it takes the destination ID the client assigned.
    const destination = globcntOfSourceKey(logon.guids, req.destinationMessage);
    const kept = await adoptOrReplace(ctx.store, logon.mailbox.mailboxId, { messageId: source.id }, destination);
    const after = kept ? await ctx.store.messageByRowId(source.id) : null;
    if (after) recordChange(sync.state, logon.guids, after.modSeq);
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
    if (ctx.session.localIdsReserved + req.count > MAX_LOCAL_IDS_PER_SESSION) {
      throw new RopError(Ec.QuotaExceeded, 'client IDs of this session used up');
    }
    ctx.session.localIdsReserved += req.count;
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
