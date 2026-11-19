/**
 * Identification and change tracking of synchronized objects
 * (MS-OXCFXICS 2.2.1.2, 2.2.2.1–2.2.2.3):
 *
 *  - PidTagSourceKey: the GID (replica GUID + 6-byte GLOBCNT) of the object's
 *    ID — a message's UID, a folder's counter (ids.ts), or the ID a client
 *    assigned to an object it created (MapiObject, 3.3.5.2.1); the root of a
 *    hierarchy synchronization has a zero-length source key (3.2.5.5).
 *  - Change numbers (CN): a message's CN is its modSeq (message-store: every
 *    change of the row gives it the mailbox's next modSeq). Folders have no
 *    modSeq: their CN is derived from what the hierarchy shows (name, parent,
 *    class, hidden), so it changes exactly when the folder changes.
 *  - PidTagChangeKey: the XID (replica GUID + GLOBCNT of the CN);
 *    PidTagPredecessorChangeList: that change key merged with the PCL of the
 *    version a client uploaded (MapiObject.pcl), sorted SizedXids.
 *
 * ID ranges of replica 1 (GLOBCNT values):
 *    1 … 10                      special folders
 *    1 … 2^32-1                  messages (UIDs)
 *    2^32 … 0x7EFF_FFFF_FFFF     IDs handed to the client (RopGetLocalReplicaIds)
 *    0x7F00_0000_0000 …          unsaved messages of a session
 *    0x8000_0000_0000 …          database folders (sha256 of the folder id)
 * Pure module.
 */
import { createHash } from 'node:crypto';
import { BufferReader } from '../wire/reader.js';
import { BufferWriter } from '../wire/writer.js';
import { DRAFT_COUNTER_BASE, globcntOf, makeId, replidOf, REPLID, type StoreGuids } from '../ids.js';
import type { FolderNode } from '../objects/mailbox-view.js';
import type { MessageSummary } from '../store/types.js';

export const GID_BYTES = 22;
/** First GLOBCNT RopGetLocalReplicaIds hands out (above every UID). */
export const LOCAL_ID_BASE = 0x1_0000_0000n;
const UID_MAX = 0xffff_ffffn;
const FOLDER_CN_BIT = 0x4000_0000_0000n;

function gid(replica: Buffer, globcnt: bigint): Buffer {
  const b = Buffer.alloc(GID_BYTES);
  replica.copy(b, 0);
  b.writeUIntBE(Number(globcnt), 16, 6);
  return b;
}

/** PidTagSourceKey of an object of this store. */
export function sourceKey(g: StoreGuids, globcnt: bigint): Buffer {
  return gid(g.replica, globcnt);
}

/** GLOBCNT of a source key (GID) of this store's replica; null for anything else. */
export function globcntOfSourceKey(g: StoreGuids, key: Buffer): bigint | null {
  if (key.length !== GID_BYTES || !key.subarray(0, 16).equals(g.replica)) return null;
  return BigInt(key.readUIntBE(16, 6));
}

/** PidTagChangeKey (XID) of a change number. */
export function changeKey(g: StoreGuids, cn: bigint): Buffer {
  return gid(g.replica, cn);
}

/** PidTagPredecessorChangeList holding one change key (SizedXid: size byte + XID). */
export function predecessorChangeList(key: Buffer): Buffer {
  return new BufferWriter(key.length + 1).u8(key.length).bytes(key).toBuffer();
}

/** The XIDs of a PidTagPredecessorChangeList (malformed tails are ignored). */
export function readPredecessorChangeList(pcl: Buffer): Buffer[] {
  const r = new BufferReader(pcl);
  const out: Buffer[] = [];
  while (r.remaining > 0) {
    const n = r.u8();
    if (n === 0 || n > r.remaining) break;
    out.push(r.bytes(n));
  }
  return out;
}

// ── Predecessor change lists (conflict detection, MS-OXCFXICS 2.2.2.3, 3.1.5.6.1) ──

/** An XID: namespace GUID (hex) and LocalId (1–8 bytes, big-endian) of its byte length. */
export interface Xid { guid: string; localId: bigint; size: number }

const XID_MIN = 17;
const XID_MAX = 24;

function xidOf(bytes: Buffer): Xid | null {
  if (bytes.length < XID_MIN || bytes.length > XID_MAX) return null;
  return { guid: bytes.subarray(0, 16).toString('hex'), localId: BigInt(`0x${bytes.subarray(16).toString('hex')}`), size: bytes.length - 16 };
}

/** The XIDs of a PidTagPredecessorChangeList (malformed entries are left out). */
export function parsePcl(pcl: Buffer | null): Xid[] {
  if (!pcl) return [];
  return readPredecessorChangeList(pcl).map(xidOf).filter((x): x is Xid => x !== null);
}

/** SizedXids sorted by namespace GUID (2.2.2.3). */
export function encodePcl(xids: readonly Xid[]): Buffer {
  const w = new BufferWriter(xids.length * 25);
  for (const x of [...xids].sort((a, b) => (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0))) {
    const local = Buffer.alloc(x.size);
    let v = x.localId;
    for (let i = x.size - 1; i >= 0; i--) { local[i] = Number(v & 0xffn); v >>= 8n; }
    w.u8(16 + x.size).bytes(Buffer.from(x.guid, 'hex')).bytes(local);
  }
  return w.toBuffer();
}

/** The XID of a change number of this store (the change key's content). */
export function storeXid(g: StoreGuids, cn: bigint): Xid {
  return { guid: g.replica.toString('hex'), localId: cn, size: 6 };
}

/** The highest XID per namespace of both lists. */
export function mergePcl(a: readonly Xid[], b: readonly Xid[]): Xid[] {
  const best = new Map<string, Xid>();
  for (const x of [...a, ...b]) {
    const cur = best.get(x.guid);
    if (!cur || x.localId > cur.localId) best.set(x.guid, x);
  }
  return [...best.values()];
}

/** `a` includes `b`: every XID of `b` has one of the same namespace and an equal or greater LocalId in `a`. */
export function pclIncludes(a: readonly Xid[], b: readonly Xid[]): boolean {
  return b.every((x) => a.some((y) => y.guid === x.guid && y.localId >= x.localId));
}

/** PidTagChangeNumber: a CN in the ID layout (replica 1). */
export function changeNumberId(cn: bigint): bigint {
  return makeId(cn);
}

/** GLOBCNT of an ID of replica 1 (MID / FID / CN), null for other replicas. */
export function globcntOfId(id: bigint): bigint | null {
  return replidOf(id) === REPLID ? globcntOf(id) : null;
}

export function isServerMessageId(globcnt: bigint): boolean {
  return globcnt >= 1n && globcnt <= UID_MAX;
}

export function isLocalReplicaId(globcnt: bigint): boolean {
  return globcnt >= LOCAL_ID_BASE && globcnt < DRAFT_COUNTER_BASE;
}

/** The GLOBCNTs RopGetLocalReplicaIds may hand out. */
export const LOCAL_ID_RANGE = { low: LOCAL_ID_BASE, high: DRAFT_COUNTER_BASE - 1n } as const;

/** A message's MAPI counter: the ID a client assigned (cached mode), else its UID. */
export function messageCounter(m: Pick<MessageSummary, 'uid' | 'clientId'>): bigint {
  return m.clientId ?? BigInt(m.uid);
}

/**
 * PidTagPredecessorChangeList of a stored message as downloaded: the XIDs of
 * the version a client uploaded (if any) and the current change key, so the
 * uploading client sees the server version as a successor of its own.
 */
export function downloadPcl(g: StoreGuids, m: Pick<MessageSummary, 'modSeq' | 'pcl'>): Buffer {
  return encodePcl(mergePcl(parsePcl(m.pcl), [storeXid(g, m.modSeq)]));
}

/**
 * The PCL of the stored content version for conflict detection on upload:
 * CoreMail never rewrites a stored message, so the content version is the
 * row's creation (a read flag is no new version) — or the PCL of the version
 * a client uploaded into this row.
 */
export function contentPcl(g: StoreGuids, m: Pick<MessageSummary, 'createdModSeq' | 'pcl'>): Xid[] {
  return m.pcl ? parsePcl(m.pcl) : [storeXid(g, m.createdModSeq)];
}

/** CN of a folder's hierarchy state (what folderChange carries). */
export function folderChangeNumber(node: FolderNode): bigint {
  const identity = node.record?.id ?? `special:${node.counter}`;
  const h = createHash('sha256')
    .update(`mapi-folder-cn:${identity}\u0000${node.displayName}\u0000${node.parentCounter ?? ''}\u0000${node.containerClass ?? ''}\u0000${node.hidden}`)
    .digest();
  return FOLDER_CN_BIT | (BigInt(h.readUIntBE(0, 6)) & (FOLDER_CN_BIT - 1n));
}
