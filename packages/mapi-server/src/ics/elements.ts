/**
 * The syntactic elements of a synchronization download (MS-OXCFXICS 2.2.4.2,
 * 2.2.4.3):
 *   folderChange      = IncrSyncChg propList
 *   messageChangeFull = IncrSyncChg messageChangeHeader IncrSyncMessage propList messageChildren
 *   messageChildren   = [MetaTagFXDelProp] *recipient [MetaTagFXDelProp] *attachment
 *   recipient         = StartRecip propList EndToRecip
 *   attachment        = NewAttach PidTagAttachNumber propList EndAttach
 *   deletions         = IncrSyncDel propList     readStateChanges = IncrSyncRead propList
 *
 * The message change header carries exactly the identification properties
 * (2.2.4.3.14); the message propList leaves out what the client derives or
 * keeps itself (IDs, entry IDs, instance keys, the recipient display strings).
 * Strings are written as PtypString, or PtypString8 for a client without the
 * Unicode flag.
 */
import { applyContent, attachmentBag, folderBag, messageSummaryBag, recipientsFromRow } from '../objects/props.js';
import { tagForUnicodePreference, type PropertyBag } from '../props/bag.js';
import { ObjectType, Tag } from '../props/tags.js';
import { makeId } from '../ids.js';
import { has, SyncExtraFlag, SyncFlag, type PropertyFilter, type SyncConfig } from './config.js';
import { Marker, FxWriter, type FxPiece } from './fx-stream.js';
import { replidIdset, MetaTag } from './state.js';
import type { Range } from './globset.js';
import type { FolderNode } from '../objects/mailbox-view.js';
import type { LogonState, RecipientState } from '../objects/state.js';
import type { MailStore, MessageSummary } from '../store/types.js';

/** MetaTagFXDelProp (2.2.4.1.5.1): the subobjects that follow replace the existing ones. */
const META_FX_DEL_PROP = 0x40160003;

/** Properties that are never part of a message propList. */
const NOT_IN_PROPLIST = new Set<number>([
  Tag.Mid, Tag.FolderId, Tag.ParentFolderId, Tag.EntryId, Tag.ParentEntryId, Tag.InstanceKey, Tag.InstID,
  Tag.InstanceNum, Tag.RowType, Tag.RecordKey, Tag.ObjectType, Tag.SourceKey, Tag.ParentSourceKey, Tag.ChangeKey,
  Tag.PredecessorChangeList, Tag.ChangeNumber, Tag.LastModificationTime, Tag.HasAttachments, Tag.DisplayTo,
  Tag.DisplayCc, Tag.DisplayBcc, Tag.MessageSize, Tag.MessageSizeExtended,
].map((t) => t >>> 16));

const MAIL_USER_DISPLAY = 0;

function writeBag(w: FxWriter, bag: PropertyBag, unicode: boolean, keep: (tag: number) => boolean = () => true): void {
  for (const [t, v] of bag) {
    if (keep(t)) w.prop(tagForUnicodePreference(t, unicode), v);
  }
}

function recipientBag(r: RecipientState): PropertyBag {
  const bag: PropertyBag = new Map();
  bag.set(Tag.Rowid, r.rowId);
  bag.set(Tag.RecipientType, r.type);
  bag.set(Tag.DisplayName, r.displayName || r.email);
  bag.set(Tag.RecipientDisplayName, r.displayName || r.email);
  bag.set(Tag.TransmittableDisplayName, r.displayName || r.email);
  bag.set(Tag.EmailAddress, r.email);
  bag.set(Tag.AddressType, 'SMTP');
  bag.set(Tag.SmtpAddress, r.email);
  bag.set(Tag.ObjectType, ObjectType.MailUser);
  bag.set(Tag.DisplayType, MAIL_USER_DISPLAY);
  return bag;
}

export interface MessageChangeContext {
  store: MailStore;
  logon: LogonState;
  folderCounter: bigint;
  config: SyncConfig;
  filter: PropertyFilter;
}

/** messageChangeFull of a stored message (content and attachment data loaded from the store). */
export async function messageChange(ctx: MessageChangeContext, m: MessageSummary): Promise<FxPiece[]> {
  const { config, filter } = ctx;
  const unicode = has(config.flags, SyncFlag.Unicode);
  const bag = messageSummaryBag(ctx.logon, ctx.folderCounter, m);
  const content = await ctx.store.loadContent(m);
  applyContent(bag, content);

  const w = new FxWriter().marker(Marker.IncrSyncChg);
  w.prop(Tag.SourceKey, bag.get(Tag.SourceKey)!);
  w.prop(Tag.LastModificationTime, m.createdAt);
  w.prop(Tag.ChangeKey, bag.get(Tag.ChangeKey)!);
  w.prop(Tag.PredecessorChangeList, bag.get(Tag.PredecessorChangeList)!);
  w.prop(Tag.Associated, false);
  if (has(config.extraFlags, SyncExtraFlag.Eid)) w.prop(Tag.Mid, makeId(BigInt(m.uid)));
  if (has(config.extraFlags, SyncExtraFlag.MessageSize)) w.prop(Tag.MessageSize, m.rawSize);
  if (has(config.extraFlags, SyncExtraFlag.CN)) w.prop(Tag.ChangeNumber, bag.get(Tag.ChangeNumber)!);

  w.marker(Marker.IncrSyncMessage);
  writeBag(w, bag, unicode, (t) => !NOT_IN_PROPLIST.has(t >>> 16) && filter.property(t));

  if (filter.recipients) {
    w.prop(META_FX_DEL_PROP, Tag.MessageRecipients);
    for (const r of recipientsFromRow(m, content)) {
      w.marker(Marker.StartRecip);
      writeBag(w, recipientBag(r), unicode);
      w.marker(Marker.EndToRecip);
    }
  }
  if (filter.attachments) {
    w.prop(META_FX_DEL_PROP, Tag.MessageAttachments);
    for (const [num, record] of content.attachments.entries()) {
      const props = attachmentBag(num, record);
      props.set(Tag.AttachDataBinary, await ctx.store.loadAttachment(record.id));
      w.marker(Marker.NewAttach);
      w.prop(Tag.AttachNumber, num);
      writeBag(w, props, unicode, (t) => t !== Tag.AttachNumber);
      w.marker(Marker.EndAttach);
    }
  }
  return w.pieces;
}

/** folderChange of a folder below the synchronization root `root`. */
export function folderChange(logon: LogonState, node: FolderNode, root: bigint, config: SyncConfig): FxPiece[] {
  const unicode = has(config.flags, SyncFlag.Unicode);
  const eid = has(config.extraFlags, SyncExtraFlag.Eid);
  const bag = folderBag(logon, node);
  const w = new FxWriter().marker(Marker.IncrSyncChg);
  // The synchronization root has a zero-length source key (3.2.5.5).
  w.prop(Tag.ParentSourceKey, node.parentCounter === root ? Buffer.alloc(0) : bag.get(Tag.ParentSourceKey)!);
  w.prop(Tag.SourceKey, bag.get(Tag.SourceKey)!);
  w.prop(Tag.LastModificationTime, node.record?.createdAt ?? new Date(0));
  w.prop(Tag.ChangeKey, bag.get(Tag.ChangeKey)!);
  w.prop(Tag.PredecessorChangeList, bag.get(Tag.PredecessorChangeList)!);
  w.prop(tagForUnicodePreference(Tag.DisplayName, unicode), node.displayName);
  if (eid) w.prop(Tag.FolderId, bag.get(Tag.FolderId)!);
  if (eid || has(config.flags, SyncFlag.NoForeignIdentifiers)) {
    if (node.parentCounter !== null) w.prop(Tag.ParentFolderId, makeId(node.parentCounter));
  }
  if (node.containerClass) w.prop(tagForUnicodePreference(Tag.ContainerClass, unicode), node.containerClass);
  w.prop(Tag.AttributeHidden, node.hidden);
  w.prop(Tag.FolderType, bag.get(Tag.FolderType)!);
  return w.pieces;
}

/** The deletions element (nothing when there is nothing to report). */
export function deletions(logon: LogonState, deleted: readonly Range[], noLongerInScope: readonly Range[]): FxPiece[] {
  if (deleted.length === 0 && noLongerInScope.length === 0) return [];
  const w = new FxWriter().marker(Marker.IncrSyncDel);
  if (deleted.length > 0) w.binaryAs(MetaTag.IdsetDeleted, replidIdset(logon.guids, deleted));
  if (noLongerInScope.length > 0) w.binaryAs(MetaTag.IdsetNoLongerInScope, replidIdset(logon.guids, noLongerInScope));
  return w.pieces;
}

/** The readStateChanges element (nothing when no read state changed). */
export function readStateChanges(logon: LogonState, read: readonly Range[], unread: readonly Range[]): FxPiece[] {
  if (read.length === 0 && unread.length === 0) return [];
  const w = new FxWriter().marker(Marker.IncrSyncRead);
  if (read.length > 0) w.binaryAs(MetaTag.IdsetRead, replidIdset(logon.guids, read));
  if (unread.length > 0) w.binaryAs(MetaTag.IdsetUnread, replidIdset(logon.guids, unread));
  return w.pieces;
}
