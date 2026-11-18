/**
 * MAPI properties of CoreMail objects (MS-OXPROPS, MS-OXCSTOR store
 * properties, MS-OXCFOLD folder properties, MS-OXCMSG message and attachment
 * properties). Pure mapping from records to property bags.
 */
import { legacyDnFor } from '@coremail/storage';
import type { PropertyBag } from '../props/bag.js';
import { Tag, ObjectType, MessageFlag, RecipientKind } from '../props/tags.js';
import {
  makeId, folderEntryId, messageEntryId, addressBookEntryId, objectKey, SpecialCounter,
} from '../ids.js';
import type { FolderNode } from './mailbox-view.js';
import type { LogonState, AttachmentState, RecipientState } from './state.js';
import type { AttachmentRecord, MessageContent, MessageSummary } from '../store/types.js';

/**
 * PidTagStoreSupportMask (MS-OXCSTOR 2.2.2.1): ENTRYID_UNIQUE, SEARCH_OK, MODIFY_OK,
 * CREATE_OK, ATTACH_OK, OLE_OK, SUBMIT_OK, NOTIFY_OK, MV_PROPS_OK, RESTRICTION_OK,
 * SORT_OK, HTML_OK, ANSI_OK, UNICODE_OK — no RTF (bodies are plain text and HTML).
 */
const STORE_SUPPORT_MASK = 0x00000001 | 0x00000004 | 0x00000008 | 0x00000010 | 0x00000020 | 0x00000040
  | 0x00000080 | 0x00000100 | 0x00000200 | 0x00001000 | 0x00002000 | 0x00010000 | 0x00020000 | 0x00040000;

/** PidTagAccess bits (MS-OXCPRPT 2.2.1.1). */
const ACCESS_READ = 0x02;
const ACCESS_FULL = 0x01 | 0x02 | 0x04 | 0x08 | 0x10 | 0x20;
/** PidTagRights for the owner (MS-OXCPERM). */
const RIGHTS_OWNER = 0x000007fb;

const FOLDER_TYPE_ROOT = 0;
const FOLDER_TYPE_GENERIC = 1;

export function storeBag(logon: LogonState): PropertyBag {
  const { guids, mailbox, view } = logon;
  const fe = (c: bigint): Buffer => folderEntryId(guids, c);
  const ownerDn = legacyDnFor(mailbox.directoryId);
  const bag: PropertyBag = new Map();
  bag.set(Tag.DisplayName, `${mailbox.displayName}`);
  bag.set(Tag.MailboxOwnerName, mailbox.displayName);
  bag.set(Tag.MailboxOwnerEntryId, addressBookEntryId(ownerDn));
  bag.set(Tag.UserEntryId, addressBookEntryId(ownerDn));
  bag.set(Tag.RecordKey, guids.mailbox);
  bag.set(Tag.StoreRecordKey, guids.mailbox);
  bag.set(Tag.MappingSignature, guids.mailbox);
  bag.set(Tag.ObjectType, ObjectType.Store);
  bag.set(Tag.StoreSupportMask, STORE_SUPPORT_MASK);
  bag.set(Tag.StoreState, 0);
  bag.set(Tag.OutOfOfficeState, false);
  bag.set(Tag.MaximumSubmitMessageSize, Math.floor(logon.maxSubmitBytes / 1024)); // in KB (MS-OXPROPS)
  bag.set(Tag.IpmSubtreeEntryId, fe(SpecialCounter.IpmSubtree));
  bag.set(Tag.IpmOutboxEntryId, fe(SpecialCounter.Outbox));
  bag.set(Tag.CommonViewsEntryId, fe(SpecialCounter.CommonViews));
  bag.set(Tag.ViewsEntryId, fe(SpecialCounter.Views));
  bag.set(Tag.FinderEntryId, fe(SpecialCounter.Finder));
  const sent = view.role('sent');
  const trash = view.role('trash');
  if (sent) bag.set(Tag.IpmSentMailEntryId, fe(sent.counter));
  if (trash) bag.set(Tag.IpmWastebasketEntryId, fe(trash.counter));
  return bag;
}

export function folderBag(logon: LogonState, node: FolderNode): PropertyBag {
  const { guids, view, mailbox } = logon;
  const bag: PropertyBag = new Map();
  const children = view.children(node.counter);
  const id = node.record?.id ?? `special:${node.counter}`;
  bag.set(Tag.FolderId, makeId(node.counter));
  bag.set(Tag.DisplayName, node.displayName);
  bag.set(Tag.EntryId, folderEntryId(guids, node.counter));
  bag.set(Tag.RecordKey, folderEntryId(guids, node.counter));
  bag.set(Tag.InstanceKey, objectKey('folder-instance', `${mailbox.mailboxId}:${id}`));
  bag.set(Tag.ChangeKey, objectKey('folder-change', `${id}:${node.record?.totalCount ?? 0}:${node.record?.unreadCount ?? 0}`));
  bag.set(Tag.ObjectType, ObjectType.Folder);
  bag.set(Tag.FolderType, node.special === 'root' ? FOLDER_TYPE_ROOT : FOLDER_TYPE_GENERIC);
  bag.set(Tag.ContentCount, node.record?.totalCount ?? 0);
  bag.set(Tag.ContentUnreadCount, node.record?.unreadCount ?? 0);
  bag.set(Tag.Subfolders, children.length > 0);
  bag.set(Tag.FolderChildCount, children.length);
  bag.set(Tag.AttributeHidden, node.hidden);
  bag.set(Tag.Access, mailbox.readOnly ? ACCESS_READ : ACCESS_FULL);
  bag.set(Tag.AccessLevel, mailbox.readOnly ? 0 : 1);
  bag.set(Tag.Rights, mailbox.readOnly ? 0x1 : RIGHTS_OWNER);
  bag.set(Tag.HierarchyChangeNumber, children.length);
  if (node.containerClass) bag.set(Tag.ContainerClass, node.containerClass);
  if (node.record) {
    bag.set(Tag.CreationTime, node.record.createdAt);
    bag.set(Tag.LastModificationTime, node.record.createdAt);
  }
  if (node.parentCounter !== null) {
    bag.set(Tag.ParentFolderId, makeId(node.parentCounter));
    bag.set(Tag.ParentEntryId, folderEntryId(guids, node.parentCounter));
  }
  if (node.special === 'root' || node.role === 'inbox') {
    const drafts = view.role('drafts');
    if (drafts) bag.set(Tag.IpmDraftsEntryId, folderEntryId(guids, drafts.counter));
  }
  return bag;
}

/** Subject prefix ("RE: ", "FW: " …) and the normalized subject. */
export function splitSubject(subject: string): { prefix: string; normalized: string } {
  const m = /^((?:re|aw|fw|fwd|wg|tr|sv|vs|antw)\s*:\s*)/i.exec(subject);
  return m ? { prefix: m[1]!, normalized: subject.slice(m[1]!.length) } : { prefix: '', normalized: subject };
}

function messageFlags(flags: readonly string[], hasAttachments: boolean, ownStoreDraft: boolean): number {
  let v = 0;
  if (flags.includes('\\Seen')) v |= MessageFlag.Read;
  if (hasAttachments) v |= MessageFlag.HasAttach;
  if (flags.includes('\\Draft') || ownStoreDraft) v |= MessageFlag.Unsent;
  return v;
}

const ICON_UNREAD = 0xffffffff;
const ICON_READ = 0x00000100;
const ICON_REPLIED = 0x00000105;
const ICON_FORWARDED = 0x00000106;

function iconIndex(flags: readonly string[]): number {
  if (flags.includes('\\Answered')) return ICON_REPLIED;
  if (flags.includes('$Forwarded')) return ICON_FORWARDED;
  return flags.includes('\\Seen') ? ICON_READ : ICON_UNREAD;
}

/** Properties of a stored message that come from its row (contents tables, RopOpenMessage). */
export function messageSummaryBag(logon: LogonState, folderCounter: bigint, m: MessageSummary): PropertyBag {
  const { guids } = logon;
  const counter = BigInt(m.uid);
  const bag: PropertyBag = new Map();
  const { prefix, normalized } = splitSubject(m.subject);
  const senderName = m.fromName || m.fromAddr;
  bag.set(Tag.Mid, makeId(counter));
  bag.set(Tag.InstID, makeId(counter));
  bag.set(Tag.InstanceNum, 0);
  bag.set(Tag.RowType, 1);
  bag.set(Tag.FolderId, makeId(folderCounter));
  bag.set(Tag.ParentFolderId, makeId(folderCounter));
  bag.set(Tag.EntryId, messageEntryId(guids, folderCounter, counter));
  bag.set(Tag.ParentEntryId, folderEntryId(guids, folderCounter));
  bag.set(Tag.RecordKey, messageEntryId(guids, folderCounter, counter));
  bag.set(Tag.InstanceKey, objectKey('message-instance', m.id));
  bag.set(Tag.SearchKey, objectKey('message-search', m.messageIdHeader ?? m.id));
  bag.set(Tag.ChangeKey, objectKey('message-change', `${m.id}:${m.modSeq}`));
  bag.set(Tag.ObjectType, ObjectType.Message);
  bag.set(Tag.MessageClass, 'IPM.Note');
  bag.set(Tag.Subject, m.subject);
  bag.set(Tag.SubjectPrefix, prefix);
  bag.set(Tag.NormalizedSubject, normalized);
  bag.set(Tag.ConversationTopic, normalized);
  bag.set(Tag.MessageFlags, messageFlags(m.flags, m.hasAttachments, false));
  bag.set(Tag.Read, m.flags.includes('\\Seen'));
  bag.set(Tag.HasAttachments, m.hasAttachments);
  bag.set(Tag.MessageSize, m.rawSize);
  bag.set(Tag.MessageSizeExtended, BigInt(m.rawSize));
  bag.set(Tag.MessageDeliveryTime, m.createdAt);
  bag.set(Tag.ClientSubmitTime, m.date);
  bag.set(Tag.CreationTime, m.createdAt);
  bag.set(Tag.LastModificationTime, m.createdAt);
  bag.set(Tag.SenderName, senderName);
  bag.set(Tag.SenderEmailAddress, m.fromAddr);
  bag.set(Tag.SenderAddressType, 'SMTP');
  bag.set(Tag.SenderSmtpAddress, m.fromAddr);
  bag.set(Tag.SentRepresentingName, senderName);
  bag.set(Tag.SentRepresentingEmailAddress, m.fromAddr);
  bag.set(Tag.SentRepresentingAddressType, 'SMTP');
  bag.set(Tag.SentRepresentingSmtpAddress, m.fromAddr);
  bag.set(Tag.DisplayTo, m.toAddrs.join('; '));
  bag.set(Tag.DisplayCc, m.ccAddrs.join('; '));
  bag.set(Tag.Importance, 1);
  bag.set(Tag.Priority, 0);
  bag.set(Tag.Sensitivity, 0);
  bag.set(Tag.IconIndex, iconIndex(m.flags));
  if (m.messageIdHeader) bag.set(Tag.InternetMessageId, m.messageIdHeader);
  if (m.inReplyTo) bag.set(Tag.InReplyToId, m.inReplyTo);
  return bag;
}

const NATIVE_BODY_PLAIN = 1;
const NATIVE_BODY_HTML = 3;
const CODEPAGE_UTF8 = 65001;

/** Adds the content properties (bodies) of a loaded message. */
export function applyContent(bag: PropertyBag, content: MessageContent): void {
  bag.set(Tag.Body, content.bodyText);
  if (content.bodyHtml) {
    bag.set(Tag.Html, Buffer.from(content.bodyHtml, 'utf8'));
    bag.set(Tag.InternetCodepage, CODEPAGE_UTF8);
  }
  bag.set(Tag.NativeBody, content.bodyHtml ? NATIVE_BODY_HTML : NATIVE_BODY_PLAIN);
  if (content.bccAddrs.length > 0) bag.set(Tag.DisplayBcc, content.bccAddrs.join('; '));
}

/** Properties of a new message created by the client (RopCreateMessage). */
export function newMessageBag(logon: LogonState, folderCounter: bigint, counter: bigint, now: Date): PropertyBag {
  const bag: PropertyBag = new Map();
  bag.set(Tag.MessageClass, 'IPM.Note');
  bag.set(Tag.MessageFlags, MessageFlag.Unsent | MessageFlag.Read);
  bag.set(Tag.FolderId, makeId(folderCounter));
  bag.set(Tag.ParentFolderId, makeId(folderCounter));
  bag.set(Tag.ParentEntryId, folderEntryId(logon.guids, folderCounter));
  bag.set(Tag.ObjectType, ObjectType.Message);
  bag.set(Tag.Importance, 1);
  bag.set(Tag.CreationTime, now);
  bag.set(Tag.LastModificationTime, now);
  bag.set(Tag.Mid, makeId(counter));
  return bag;
}

export function recipientsFromRow(m: MessageSummary, content: MessageContent | null): RecipientState[] {
  const list: RecipientState[] = [];
  const add = (type: number, addrs: readonly string[]): void => {
    for (const email of addrs) list.push({ rowId: list.length, type, displayName: email, email, props: new Map() });
  };
  add(RecipientKind.To, m.toAddrs);
  add(RecipientKind.Cc, m.ccAddrs);
  if (content) add(RecipientKind.Bcc, content.bccAddrs);
  return list;
}

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i > 0 ? filename.slice(i) : '';
}

const ATTACH_BY_VALUE = 1;
const RENDERING_POSITION_NONE = 0xffffffff;

export function attachmentBag(num: number, record: AttachmentRecord): PropertyBag {
  const bag: PropertyBag = new Map();
  bag.set(Tag.AttachNumber, num);
  bag.set(Tag.AttachMethod, ATTACH_BY_VALUE);
  bag.set(Tag.AttachLongFilename, record.filename);
  bag.set(Tag.AttachFilename, record.filename);
  bag.set(Tag.AttachExtension, extensionOf(record.filename));
  bag.set(Tag.DisplayName, record.filename);
  bag.set(Tag.AttachMimeTag, record.mimeType);
  bag.set(Tag.AttachSize, record.size);
  bag.set(Tag.RenderingPosition, RENDERING_POSITION_NONE);
  bag.set(Tag.ObjectType, ObjectType.Attachment);
  bag.set(Tag.RecordKey, objectKey('attachment', record.id));
  bag.set(Tag.AttachmentHidden, record.inline && !!record.contentId);
  if (record.contentId) bag.set(Tag.AttachContentId, record.contentId);
  return bag;
}

export function newAttachment(num: number): AttachmentState {
  const props: PropertyBag = new Map();
  props.set(Tag.AttachNumber, num);
  props.set(Tag.AttachMethod, ATTACH_BY_VALUE);
  props.set(Tag.ObjectType, ObjectType.Attachment);
  props.set(Tag.RenderingPosition, RENDERING_POSITION_NONE);
  return { num, props, record: null, data: null, saved: false };
}
