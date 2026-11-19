/**
 * Incremental change synchronization — download and ICS state (MS-OXCFXICS
 * 2.2.3.1.1.5, 2.2.3.2.1–2.2.3.2.3; MS-OXCROPS 2.2.12.4, 2.2.13):
 * RopSynchronizationConfigure, RopFastTransferSourceGetBuffer,
 * RopSynchronizationUploadStateStreamBegin / Continue / End,
 * RopSynchronizationGetTransferState, and the ID mapping ROPs
 * RopLongTermIdFromId / RopIdFromLongTermId (MS-OXCROPS 2.2.3.8 / 2.2.3.9).
 *
 * Flow (classic Outlook in cached mode): Configure on a folder → upload the
 * client's state → GetBuffer until TransferStatus Done → the stream ends with
 * the new state, which the client keeps for the next round.
 */
import { BufferReader } from '../../wire/reader.js';
import { Ec, RopError, RopId } from '../codes.js';
import { defineRop, NeedsMoreSpace, objectOf, okResponse, putObject, assertMemory, memoryLeft, type RopDef } from '../context.js';
import { parseRestriction, restrictionNodeCount, type Restriction } from '../../props/restriction.js';
import { folderNode, refreshView } from './common.js';
import { MAX_RESTRICTION_NODES } from './table.js';
import { makeId } from '../../ids.js';
import { globcntOfId } from '../../ics/keys.js';
import { has, SyncFlag, SyncType, type SyncConfig } from '../../ics/config.js';
import { startDownload } from '../../ics/download.js';
import { FxWriter } from '../../ics/fx-stream.js';
import { RANGE_BYTES } from '../../ics/globset.js';
import { fixedSource, MIN_TRANSFER_BUFFER, type FastTransferSource } from '../../ics/transfer.js';
import {
  beginStateUpload, continueStateUpload, emptyState, endStateUpload, writeState,
} from '../../ics/state.js';
import type { SyncDownload, SyncUpload } from '../../objects/state.js';

const BABE = 0xbabe;
const TRANSFER_PARTIAL = 0x0001;
const TRANSFER_DONE = 0x0003;
/** RopId, index, ReturnValue, TransferStatus, InProgressCount, TotalStepCount, Reserved, TransferBufferSize. */
const GET_BUFFER_HEADER = 15;
const LONG_TERM_ID_BYTES = 24;

// ── RopSynchronizationConfigure ──────────────────────────────────────────────

interface ConfigureReq {
  inputIndex: number; outputIndex: number; syncType: number; flags: number;
  restriction: Restriction | null; extraFlags: number; propertyTags: number[];
}

export const ropSynchronizationConfigure = defineRop<ConfigureReq>({
  id: RopId.SynchronizationConfigure,
  name: 'RopSynchronizationConfigure',
  parse(r) {
    const inputIndex = r.u8();
    const outputIndex = r.u8();
    const syncType = r.u8();
    r.u8(); // SendOptions (the Unicode flag repeats SynchronizationFlags)
    const flags = r.u16();
    const size = r.u16();
    const restriction = size > 0 ? parseRestriction(new BufferReader(r.bytes(size))) : null;
    const extraFlags = r.u32();
    const n = r.u16();
    const propertyTags: number[] = [];
    for (let i = 0; i < n; i++) propertyTags.push(r.u32());
    return { inputIndex, outputIndex, syncType, flags, restriction, extraFlags, propertyTags };
  },
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const { logon, counter } = objectOf(ctx, req.inputIndex, 'folder');
    if (req.syncType !== SyncType.Contents && req.syncType !== SyncType.Hierarchy) {
      throw new RopError(Ec.InvalidParameter, 'unknown SynchronizationType');
    }
    if (has(req.flags, SyncFlag.Reserved)) throw new RopError(Ec.InvalidParameter, 'Reserved flag set');
    if (req.restriction && restrictionNodeCount(req.restriction) > MAX_RESTRICTION_NODES) {
      throw new RopError(Ec.TooComplex, 'restriction has too many nodes');
    }
    await refreshView(ctx.store, logon);
    folderNode(logon, counter);
    const config: SyncConfig = {
      kind: req.syncType === SyncType.Contents ? 'contents' : 'hierarchy',
      folderCounter: counter, flags: req.flags, extraFlags: req.extraFlags,
      restriction: req.syncType === SyncType.Contents ? req.restriction : null, propertyTags: req.propertyTags,
    };
    const sync: SyncDownload = { config, state: emptyState(), stateUpload: null, transfer: null };
    putObject(ctx, req.outputIndex, { kind: 'syncDownload', logon, sync }, req.logonId);
    return okResponse(RopId.SynchronizationConfigure, req.outputIndex).toBuffer();
  },
});

// ── RopFastTransferSourceGetBuffer ───────────────────────────────────────────

interface GetBufferReq { inputIndex: number; bufferSize: number }

export const ropFastTransferSourceGetBuffer = defineRop<GetBufferReq>({
  id: RopId.FastTransferSourceGetBuffer,
  name: 'RopFastTransferSourceGetBuffer',
  parse(r) {
    const inputIndex = r.u8();
    const size = r.u16();
    return { inputIndex, bufferSize: size === BABE ? r.u16() : size };
  },
  responseIndex: (req) => req.inputIndex,
  // TransferStatus Error, InProgressCount, TotalStepCount, Reserved, TransferBufferSize 0
  failureTail: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  async execute(ctx, req) {
    const obj = objectOf(ctx, req.inputIndex, 'syncDownload', 'fastTransfer');
    let source: FastTransferSource;
    if (obj.kind === 'fastTransfer') {
      source = obj.source;
    } else {
      const sync = obj.sync;
      if (sync.stateUpload) throw new RopError(Ec.InvalidParameter, 'state upload not ended');
      sync.transfer ??= await startDownload(ctx.store, obj.logon, sync.config, sync.state);
      source = sync.transfer.source;
    }
    const room = ctx.budget - GET_BUFFER_HEADER;
    if (room < MIN_TRANSFER_BUFFER) throw new NeedsMoreSpace(GET_BUFFER_HEADER + MIN_TRANSFER_BUFFER);
    const chunk = await source.next(Math.min(Math.max(req.bufferSize, MIN_TRANSFER_BUFFER), room));
    return okResponse(RopId.FastTransferSourceGetBuffer, req.inputIndex)
      .u16(chunk.done ? TRANSFER_DONE : TRANSFER_PARTIAL)
      .u16(Math.min(source.completed, 0xffff))
      .u16(Math.min(source.totalSteps, 0xffff))
      .u8(0)
      .u16(chunk.data.length)
      .bytes(chunk.data)
      .toBuffer();
  },
});

// ── ICS state upload ─────────────────────────────────────────────────────────

function stateContext(sync: SyncDownload | SyncUpload): void {
  if ('transfer' in sync && sync.transfer) throw new RopError(Ec.InvalidParameter, 'the download already started');
}

interface BeginReq { inputIndex: number; stateProperty: number; size: number }

export const ropUploadStateStreamBegin = defineRop<BeginReq>({
  id: RopId.SynchronizationUploadStateStreamBegin,
  name: 'RopSynchronizationUploadStateStreamBegin',
  parse: (r) => ({ inputIndex: r.u8(), stateProperty: r.u32(), size: r.u32() }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { sync } = objectOf(ctx, req.inputIndex, 'syncDownload', 'syncUpload');
    stateContext(sync);
    sync.stateUpload = beginStateUpload(req.stateProperty, req.size);
    return okResponse(RopId.SynchronizationUploadStateStreamBegin, req.inputIndex).toBuffer();
  },
});

interface ContinueReq { inputIndex: number; data: Buffer }

export const ropUploadStateStreamContinue = defineRop<ContinueReq>({
  id: RopId.SynchronizationUploadStateStreamContinue,
  name: 'RopSynchronizationUploadStateStreamContinue',
  parse(r) {
    const inputIndex = r.u8();
    return { inputIndex, data: r.bytes(r.u32()) };
  },
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { sync } = objectOf(ctx, req.inputIndex, 'syncDownload', 'syncUpload');
    if (!sync.stateUpload) throw new RopError(Ec.InvalidParameter, 'no state upload in progress');
    assertMemory(ctx, req.data.length);
    continueStateUpload(sync.stateUpload, req.data);
    return okResponse(RopId.SynchronizationUploadStateStreamContinue, req.inputIndex).toBuffer();
  },
});

interface IndexReq { inputIndex: number }

export const ropUploadStateStreamEnd = defineRop<IndexReq>({
  id: RopId.SynchronizationUploadStateStreamEnd,
  name: 'RopSynchronizationUploadStateStreamEnd',
  parse: (r) => ({ inputIndex: r.u8() }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon, sync } = objectOf(ctx, req.inputIndex, 'syncDownload', 'syncUpload');
    const upload = sync.stateUpload;
    if (!upload) throw new RopError(Ec.InvalidParameter, 'no state upload in progress');
    sync.stateUpload = null;
    // The decoded state counts against the session's memory budget (objects/footprint.ts).
    endStateUpload(upload, sync.state, logon.guids, Math.floor(memoryLeft(ctx) / RANGE_BYTES));
    return okResponse(RopId.SynchronizationUploadStateStreamEnd, req.inputIndex).toBuffer();
  },
});

// ── RopSynchronizationGetTransferState ───────────────────────────────────────

interface TransferStateReq { inputIndex: number; outputIndex: number }

export const ropGetTransferState = defineRop<TransferStateReq>({
  id: RopId.SynchronizationGetTransferState,
  name: 'RopSynchronizationGetTransferState',
  parse: (r) => ({ inputIndex: r.u8(), outputIndex: r.u8() }),
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const obj = objectOf(ctx, req.inputIndex, 'syncDownload', 'syncUpload');
    const w = new FxWriter();
    if (obj.kind === 'syncDownload') {
      const state = obj.sync.transfer ? obj.sync.transfer.checkpoint() : obj.sync.state;
      writeState(w, state, obj.sync.config.kind, true);
    } else {
      // An upload context's state has no IdsetGiven (MS-OXCFXICS 3.2.5.2.1).
      writeState(w, obj.sync.state, obj.sync.kind, false);
    }
    putObject(ctx, req.outputIndex, { kind: 'fastTransfer', logon: obj.logon, source: fixedSource(w.pieces) }, req.logonId);
    return okResponse(RopId.SynchronizationGetTransferState, req.outputIndex).toBuffer();
  },
});

// ── Long-term IDs ────────────────────────────────────────────────────────────

interface LongTermFromIdReq { inputIndex: number; objectId: bigint }

export const ropLongTermIdFromId = defineRop<LongTermFromIdReq>({
  id: RopId.LongTermIdFromId,
  name: 'RopLongTermIdFromId',
  parse: (r) => ({ inputIndex: r.u8(), objectId: r.u64() }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon } = objectOf(ctx, req.inputIndex, 'logon');
    const globcnt = globcntOfId(req.objectId);
    if (globcnt === null) throw new RopError(Ec.NotFound, 'ID of another replica');
    const gc = Buffer.alloc(6);
    gc.writeUIntBE(Number(globcnt), 0, 6);
    return okResponse(RopId.LongTermIdFromId, req.inputIndex).bytes(logon.guids.replica).bytes(gc).u16(0).toBuffer();
  },
});

interface IdFromLongTermReq { inputIndex: number; longTermId: Buffer }

export const ropIdFromLongTermId = defineRop<IdFromLongTermReq>({
  id: RopId.IdFromLongTermId,
  name: 'RopIdFromLongTermId',
  parse: (r) => ({ inputIndex: r.u8(), longTermId: r.bytes(LONG_TERM_ID_BYTES) }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon } = objectOf(ctx, req.inputIndex, 'logon');
    if (!req.longTermId.subarray(0, 16).equals(logon.guids.replica)) throw new RopError(Ec.NotFound, 'unknown replica');
    const globcnt = BigInt(req.longTermId.readUIntBE(16, 6));
    return okResponse(RopId.IdFromLongTermId, req.inputIndex).u64(makeId(globcnt)).toBuffer();
  },
});

export const syncRops: RopDef[] = [
  ropSynchronizationConfigure, ropFastTransferSourceGetBuffer, ropUploadStateStreamBegin, ropUploadStateStreamContinue,
  ropUploadStateStreamEnd, ropGetTransferState, ropLongTermIdFromId, ropIdFromLongTermId,
];

