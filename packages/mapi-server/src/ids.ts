/**
 * MAPI identifiers for CoreMail objects.
 *
 * Folder and message IDs (MS-OXCDATA 2.2.1.1/2.2.1.2) are 8 bytes: a 2-byte
 * replica ID (little-endian) followed by a 6-byte global counter (big-endian);
 * on the wire they are read as one little-endian 64-bit value. Every mailbox
 * uses replica ID 1.
 *
 *  - Special folders without a database row: fixed counters 1..10.
 *  - Database folders: 0x8000_0000_0000 | 47 bits of sha256(folder id) — stable
 *    across sessions and server restarts, collision-free in practice.
 *  - Messages: the message UID (mailbox-wide counter of the message store); a
 *    move gives a new UID, which MAPI also treats as a new message ID. Messages
 *    are always addressed within their folder, so even legacy duplicate UIDs in
 *    different folders stay unambiguous.
 *  - Unsaved new messages: counters from 0x7F00_0000_0000 per session.
 *
 * EntryIDs (MS-OXCDATA 2.2.4): ProviderUID = the mailbox GUID, the database GUID
 * = the replica GUID; both are derived from the mailbox id.
 */
import { createHash } from 'node:crypto';
import { BufferReader } from './wire/reader.js';
import { BufferWriter } from './wire/writer.js';

export const REPLID = 0x0001;

export const SpecialCounter = {
  Root: 1n,
  DeferredAction: 2n,
  SpoolerQueue: 3n,
  IpmSubtree: 4n,
  Outbox: 5n,
  CommonViews: 6n,
  Schedule: 7n,
  Finder: 8n,
  Views: 9n,
  Shortcuts: 10n,
} as const;

const DB_FOLDER_BIT = 0x8000_0000_0000n;
const COUNTER_MASK = 0xffff_ffff_ffffn;
export const DRAFT_COUNTER_BASE = 0x7f00_0000_0000n;

/** The 64-bit ID value of a global counter (replica ID 1). */
export function makeId(globcnt: bigint): bigint {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(REPLID, 0);
  b.writeUIntBE(Number(globcnt & COUNTER_MASK), 2, 6);
  return b.readBigUInt64LE(0);
}

export function globcntOf(id: bigint): bigint {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt.asUintN(64, id));
  return BigInt(b.readUIntBE(2, 6));
}

export function replidOf(id: bigint): number {
  return Number(BigInt.asUintN(64, id) & 0xffffn);
}

export function folderCounterForRow(folderId: string): bigint {
  const h = createHash('sha256').update(`mapi-folder:${folderId}`).digest();
  return DB_FOLDER_BIT | (BigInt(h.readUIntBE(0, 6)) & (DB_FOLDER_BIT - 1n));
}

function guidFrom(label: string, mailboxId: string): Buffer {
  return createHash('sha256').update(`${label}:${mailboxId}`).digest().subarray(0, 16);
}

export function mailboxGuid(mailboxId: string): Buffer { return guidFrom('mapi-mailbox', mailboxId); }
export function replicaGuid(mailboxId: string): Buffer { return guidFrom('mapi-replica', mailboxId); }

function counterBytes(globcnt: bigint): Buffer {
  const b = Buffer.alloc(6);
  b.writeUIntBE(Number(globcnt & COUNTER_MASK), 0, 6);
  return b;
}

const EITLT_PRIVATE_FOLDER = 0x0001;
const EITLT_PRIVATE_MESSAGE = 0x0007;

export interface StoreGuids { mailbox: Buffer; replica: Buffer }

export function storeGuids(mailboxId: string): StoreGuids {
  return { mailbox: mailboxGuid(mailboxId), replica: replicaGuid(mailboxId) };
}

/** Folder EntryID (46 bytes, MS-OXCDATA 2.2.4.1). */
export function folderEntryId(g: StoreGuids, folderCounter: bigint): Buffer {
  return new BufferWriter(46)
    .u32(0).bytes(g.mailbox).u16(EITLT_PRIVATE_FOLDER).bytes(g.replica).bytes(counterBytes(folderCounter)).u16(0)
    .toBuffer();
}

/** Message EntryID (70 bytes, MS-OXCDATA 2.2.4.2). */
export function messageEntryId(g: StoreGuids, folderCounter: bigint, messageCounter: bigint): Buffer {
  return new BufferWriter(70)
    .u32(0).bytes(g.mailbox).u16(EITLT_PRIVATE_MESSAGE)
    .bytes(g.replica).bytes(counterBytes(folderCounter)).u16(0)
    .bytes(g.replica).bytes(counterBytes(messageCounter)).u16(0)
    .toBuffer();
}

export type ParsedEntryId =
  | { kind: 'folder'; folder: bigint }
  | { kind: 'message'; folder: bigint; message: bigint };

/** Parses a folder/message EntryID of this store; null for anything else. */
export function parseEntryId(g: StoreGuids, entryId: Buffer): ParsedEntryId | null {
  if (entryId.length !== 46 && entryId.length !== 70) return null;
  const r = new BufferReader(entryId);
  r.u32();
  if (!r.bytes(16).equals(g.mailbox)) return null;
  const type = r.u16();
  const readCounter = (): bigint | null => {
    if (!r.bytes(16).equals(g.replica)) return null;
    const c = BigInt(r.bytes(6).readUIntBE(0, 6));
    r.u16();
    return c;
  };
  const folder = readCounter();
  if (folder === null) return null;
  if (type === EITLT_PRIVATE_FOLDER && entryId.length === 46) return { kind: 'folder', folder };
  if (type !== EITLT_PRIVATE_MESSAGE || entryId.length !== 70) return null;
  const message = readCounter();
  return message === null ? null : { kind: 'message', folder, message };
}

/** Address book EntryID (MS-OXCDATA 2.2.5.2) of a directory object (X500 DN). */
const ADDRESS_BOOK_PROVIDER = Buffer.from('dca740c8c042101ab4b908002b2fe182', 'hex');
export function addressBookEntryId(legacyDn: string): Buffer {
  return new BufferWriter(32 + legacyDn.length)
    .u32(0).bytes(ADDRESS_BOOK_PROVIDER).u32(1).u32(0).asciiZ(legacyDn, 'ascii')
    .toBuffer();
}

/** Stable 16-byte keys (PidTagRecordKey / PidTagInstanceKey / PidTagSearchKey). */
export function objectKey(label: string, id: string): Buffer {
  return createHash('sha256').update(`${label}:${id}`).digest().subarray(0, 16);
}
