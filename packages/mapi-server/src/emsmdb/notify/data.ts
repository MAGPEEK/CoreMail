/**
 * Notification payloads (MS-OXCNOTIF 2.2.1.4.1.2 NotificationData) and the
 * ROP responses that carry them (MS-OXCROPS 2.2.14.2 RopNotify, 2.2.14.3
 * RopPending). Pure encoders.
 *
 * The server sends three kinds:
 *  - NewMail (0x0002, M): FolderId, MessageId, MessageFlags, UnicodeFlag,
 *    MessageClass;
 *  - ObjectModified on a folder (0x0010, T|U): FolderId, TagCount 0 (the
 *    SHOULD of the spec), TotalMessageCount, UnreadMessageCount;
 *  - TableModified / TableChanged (0x0100, TableEventType 0x0001) for an open
 *    hierarchy or contents table: the client re-reads the table.
 */
import { BufferWriter } from '../../wire/writer.js';

export const NotificationType = {
  NewMail: 0x0002,
  ObjectCreated: 0x0004,
  ObjectDeleted: 0x0008,
  ObjectModified: 0x0010,
  ObjectMoved: 0x0020,
  ObjectCopied: 0x0040,
  SearchCompleted: 0x0080,
  TableModified: 0x0100,
} as const;

const FLAG_TOTAL_COUNT = 0x1000;
const FLAG_UNREAD_COUNT = 0x2000;
const FLAG_MESSAGE = 0x8000;
const TABLE_CHANGED = 0x0001;

export const ROP_NOTIFY = 0x2a;
export const ROP_PENDING = 0x6e;
/** RopId + NotificationHandle + LogonId. */
export const NOTIFY_HEADER_SIZE = 6;
/** RopId + SessionIndex. */
export const PENDING_SIZE = 3;

export function newMailData(folderId: bigint, messageId: bigint, messageFlags: number, messageClass: string): Buffer {
  return new BufferWriter(64)
    .u16(NotificationType.NewMail | FLAG_MESSAGE)
    .u64(folderId).u64(messageId)
    .u32(messageFlags)
    .u8(1).utf16Z(messageClass)
    .toBuffer();
}

export function folderModifiedData(folderId: bigint, total: number, unread: number): Buffer {
  return new BufferWriter(24)
    .u16(NotificationType.ObjectModified | FLAG_TOTAL_COUNT | FLAG_UNREAD_COUNT)
    .u64(folderId)
    .u16(0)
    .u32(total).u32(unread)
    .toBuffer();
}

export function tableChangedData(): Buffer {
  return new BufferWriter(4).u16(NotificationType.TableModified).u16(TABLE_CHANGED).toBuffer();
}

/** RopNotify response: RopId 0x2A, NotificationHandle, LogonId, NotificationData. */
export function ropNotify(handle: number, logonId: number, data: Buffer): Buffer {
  return new BufferWriter(NOTIFY_HEADER_SIZE + data.length).u8(ROP_NOTIFY).u32(handle).u8(logonId).bytes(data).toBuffer();
}

/** RopPending response: more notifications are queued for the session (SessionIndex 0, one session per context). */
export function ropPending(sessionIndex = 0): Buffer {
  return new BufferWriter(PENDING_SIZE).u8(ROP_PENDING).u16(sessionIndex).toBuffer();
}
