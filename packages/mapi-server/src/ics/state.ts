/**
 * The ICS state (MS-OXCFXICS 2.2.1.1): MetaTagIdsetGiven (IDs the client
 * has), MetaTagCnsetSeen / MetaTagCnsetSeenFAI (changes it has seen) and
 * MetaTagCnsetRead (read-state changes it has seen) — REPLGUID-based IDSETs.
 * The server keeps no per-client state: the client uploads the state with
 * RopSynchronizationUploadStateStream* and gets the new one at the end of a
 * download (the `state` element) or from RopSynchronizationGetTransferState.
 *
 * MetaTagIdsetGiven has an Integer32 tag but binary content: it is accepted
 * with either type and sent with the Integer32 tag and binary serialization
 * (3.2.5.2.1). Pure module.
 */
import { Ec, RopError } from '../rop/codes.js';
import { REPLID, type StoreGuids } from '../ids.js';
import { WireFormatError } from '../wire/reader.js';
import { IdSet } from './idset.js';
import { Marker, type FxWriter } from './fx-stream.js';
import { IdsetTooLargeError, MAX_RANGES, RANGE_BYTES, type Range } from './globset.js';

export const MetaTag = {
  IdsetGiven: 0x40170003,
  IdsetGivenBinary: 0x40170102,
  CnsetSeen: 0x67960102,
  CnsetSeenFai: 0x67da0102,
  CnsetRead: 0x67d20102,
  IdsetDeleted: 0x67e50102,
  IdsetNoLongerInScope: 0x40210102,
  IdsetRead: 0x402d0102,
  IdsetUnread: 0x402e0102,
} as const;

export interface IcsState {
  idsetGiven: IdSet;
  cnsetSeen: IdSet;
  cnsetSeenFai: IdSet;
  cnsetRead: IdSet;
}

export function emptyState(): IcsState {
  return { idsetGiven: new IdSet(), cnsetSeen: new IdSet(), cnsetSeenFai: new IdSet(), cnsetRead: new IdSet() };
}

/** Largest state property a client may upload (bounded session memory). */
export const MAX_STATE_PROPERTY_BYTES = 16 * 1024 * 1024;

const STATE_KEYS: Readonly<Record<number, keyof IcsState>> = {
  [MetaTag.IdsetGiven]: 'idsetGiven',
  [MetaTag.IdsetGivenBinary]: 'idsetGiven',
  [MetaTag.CnsetSeen]: 'cnsetSeen',
  [MetaTag.CnsetSeenFai]: 'cnsetSeenFai',
  [MetaTag.CnsetRead]: 'cnsetRead',
};

/** A state property being uploaded (RopSynchronizationUploadStateStreamBegin … End). */
export interface StateUpload {
  key: keyof IcsState;
  expected: number;
  chunks: Buffer[];
  size: number;
}

export function beginStateUpload(stateProperty: number, size: number): StateUpload {
  const key = STATE_KEYS[stateProperty >>> 0];
  if (!key) throw new RopError(Ec.InvalidParameter, `0x${(stateProperty >>> 0).toString(16)} is not an ICS state property`);
  if (size > MAX_STATE_PROPERTY_BYTES) throw new RopError(Ec.OutOfMemory, 'state property too large');
  return { key, expected: size, chunks: [], size: 0 };
}

export function continueStateUpload(upload: StateUpload, data: Buffer): void {
  if (upload.size + data.length > MAX_STATE_PROPERTY_BYTES) throw new RopError(Ec.OutOfMemory, 'state property too large');
  upload.chunks.push(data);
  upload.size += data.length;
}

/**
 * Ends an upload: the property replaces the one in `state`. At most
 * `maxRanges` decoded ranges (the session's memory budget) → else ecMAPIOOM;
 * a malformed IDSET → RpcFormat (MS-OXCFXICS 3.1.5.4.3.2).
 */
export function endStateUpload(upload: StateUpload, state: IcsState, guids: StoreGuids, maxRanges: number): void {
  const value = Buffer.concat(upload.chunks);
  try {
    state[upload.key] = IdSet.decodeStateValue(value, (replid) => (replid === REPLID ? guids.replica : null), Math.min(maxRanges, MAX_RANGES));
  } catch (err) {
    if (err instanceof IdsetTooLargeError) throw new RopError(Ec.OutOfMemory, `${upload.key} has too many ranges`);
    if (err instanceof WireFormatError) throw new RopError(Ec.RpcFormat, `malformed ${upload.key}: ${err.message}`);
    throw err;
  }
}

/** Approximate heap bytes of a decoded ICS state (session memory accounting). */
export function stateBytes(state: IcsState): number {
  const ranges = state.idsetGiven.rangeCount + state.cnsetSeen.rangeCount + state.cnsetSeenFai.rangeCount + state.cnsetRead.rangeCount;
  return ranges * RANGE_BYTES;
}

export type SyncKind = 'contents' | 'hierarchy';

/**
 * The `state` element (IncrSyncStateBegin propList IncrSyncStateEnd). The
 * FAI and read sets exist only for contents synchronization (2.2.4.3.25);
 * an upload context's state carries no IdsetGiven (3.2.5.2.1).
 */
export function writeState(w: FxWriter, state: IcsState, kind: SyncKind, withGiven: boolean): void {
  w.marker(Marker.IncrSyncStateBegin);
  if (withGiven) w.binaryAs(MetaTag.IdsetGiven, state.idsetGiven.encodeGuidForm());
  w.binaryAs(MetaTag.CnsetSeen, state.cnsetSeen.encodeGuidForm());
  if (kind === 'contents') {
    w.binaryAs(MetaTag.CnsetSeenFai, state.cnsetSeenFai.encodeGuidForm());
    w.binaryAs(MetaTag.CnsetRead, state.cnsetRead.encodeGuidForm());
  }
  w.marker(Marker.IncrSyncStateEnd);
}

/** REPLID-based IDSET of replica 1 (deletion and read-state meta-properties). */
export function replidIdset(guids: StoreGuids, ranges: readonly Range[]): Buffer {
  return new IdSet().addRanges(guids.replica, ranges).encodeReplidForm((guid) => (guid.equals(guids.replica) ? REPLID : null));
}
