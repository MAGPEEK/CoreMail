/**
 * Stream ROPs (MS-OXCPRPT 2.2.14–2.2.21): RopOpenStream, RopReadStream,
 * RopWriteStream, RopCommitStream, RopGetStreamSize — on message properties
 * (bodies) and on attachment data. String properties are streamed as their
 * encoded bytes without terminator (PtypString UTF-16LE, PtypString8 Latin-1).
 * A writable stream is limited to MAX_STREAM_BYTES.
 */
import { Ec, RopError, RopId } from '../codes.js';
import { defineRop, NeedsMoreSpace, objectOf, okResponse, putObject, type RopDef } from '../context.js';
import { lookupProperty, setProperty } from '../../props/bag.js';
import { PropType, propTypeOf, Tag } from '../../props/tags.js';
import { ensureContent } from './content.js';
import type { StreamState, StreamTarget } from '../../objects/state.js';
import type { PropValue } from '../../props/values.js';

export const MAX_STREAM_BYTES = 32 * 1024 * 1024;

const OPEN_READ_WRITE = 0x01;
const OPEN_CREATE = 0x02;
const OPEN_BEST_ACCESS = 0x03;
const STG_E_ACCESSDENIED = 0x80030005;
const BABE = 0xbabe;
/** RopId + index + ReturnValue + DataSize. */
const READ_HEADER = 8;

export function encodeStreamValue(tag: number, value: PropValue): Buffer {
  const type = propTypeOf(tag);
  if (type === PropType.String) return Buffer.from(String(value), 'utf16le');
  if (type === PropType.String8) return Buffer.from(String(value), 'latin1');
  if (Buffer.isBuffer(value)) return value;
  throw new RopError(Ec.NotSupported, 'property cannot be streamed');
}

function decodeStreamValue(tag: number, data: Buffer): PropValue {
  const type = propTypeOf(tag);
  if (type === PropType.String) return data.toString('utf16le').replace(/\u0000+$/, '');
  if (type === PropType.String8) return data.toString('latin1').replace(/\u0000+$/, '');
  return Buffer.from(data);
}

/** Writes the stream content back into the property it was opened on. */
export function commitStream(stream: StreamState): void {
  const data = stream.data.subarray(0, stream.size);
  const { target, tag } = stream;
  if (target.kind === 'message') setProperty(target.message.props, tag, decodeStreamValue(tag, data));
  if (target.kind === 'attachment') {
    if (tag === Tag.AttachDataBinary) {
      target.attachment.data = Buffer.from(data);
      setProperty(target.attachment.props, Tag.AttachSize, data.length);
    } else {
      setProperty(target.attachment.props, tag, decodeStreamValue(tag, data));
    }
  }
  stream.dirty = false;
}

interface OpenReq { inputIndex: number; outputIndex: number; tag: number; mode: number }

export const ropOpenStream = defineRop<OpenReq>({
  id: RopId.OpenStream,
  name: 'RopOpenStream',
  parse: (r) => ({ inputIndex: r.u8(), outputIndex: r.u8(), tag: r.u32(), mode: r.u8() }),
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const owner = objectOf(ctx, req.inputIndex, 'message', 'attachment');
    const message = owner.message;
    const wantsWrite = req.mode === OPEN_READ_WRITE || req.mode === OPEN_CREATE || req.mode === OPEN_BEST_ACCESS;
    const canWrite = !message.readOnly && !message.submitted && !owner.logon.mailbox.readOnly;
    if (wantsWrite && !canWrite && req.mode !== OPEN_BEST_ACCESS) throw new RopError(Ec.AccessDenied, 'message is read-only');

    let target: StreamTarget;
    let current: Buffer | null = null;
    if (owner.kind === 'attachment') {
      target = { kind: 'attachment', message, attachment: owner.attachment };
      if (req.tag === Tag.AttachDataBinary) {
        current = owner.attachment.data
          ?? (owner.attachment.record ? await ctx.store.loadAttachment(owner.attachment.record.id) : null);
      } else {
        const found = lookupProperty(owner.attachment.props, req.tag);
        current = found.found && 'value' in found ? encodeStreamValue(req.tag, found.value) : null;
      }
    } else {
      target = { kind: 'message', message };
      await ensureContent(ctx.store, message);
      const found = lookupProperty(message.props, req.tag);
      current = found.found && 'value' in found ? encodeStreamValue(req.tag, found.value) : null;
    }
    if (current === null && !wantsWrite) throw new RopError(Ec.NotFound, 'property not set');
    const data = req.mode === OPEN_CREATE ? Buffer.alloc(0) : (current ?? Buffer.alloc(0));
    const stream: StreamState = {
      target, tag: req.tag, data: Buffer.from(data), size: data.length, position: 0,
      writable: wantsWrite && canWrite, dirty: false,
    };
    putObject(ctx, req.outputIndex, { kind: 'stream', logon: owner.logon, stream }, req.logonId);
    return okResponse(RopId.OpenStream, req.outputIndex).u32(stream.size).toBuffer();
  },
});

interface ReadReq { inputIndex: number; byteCount: number }

export const ropReadStream = defineRop<ReadReq>({
  id: RopId.ReadStream,
  name: 'RopReadStream',
  parse(r) {
    const inputIndex = r.u8();
    const count = r.u16();
    return { inputIndex, byteCount: count === BABE ? r.u32() : count };
  },
  responseIndex: (req) => req.inputIndex,
  failureTail: [0, 0],
  async execute(ctx, req) {
    const { stream } = objectOf(ctx, req.inputIndex, 'stream');
    const left = Math.max(0, stream.size - stream.position);
    const wanted = Math.min(req.byteCount, left, 0xffff);
    const n = Math.min(wanted, ctx.budget - READ_HEADER);
    if (wanted > 0 && n <= 0) throw new NeedsMoreSpace(READ_HEADER + wanted);
    const chunk = stream.data.subarray(stream.position, stream.position + n);
    stream.position += n;
    return okResponse(RopId.ReadStream, req.inputIndex).u16(n).bytes(chunk).toBuffer();
  },
});

interface WriteReq { inputIndex: number; data: Buffer }

export const ropWriteStream = defineRop<WriteReq>({
  id: RopId.WriteStream,
  name: 'RopWriteStream',
  parse(r) {
    const inputIndex = r.u8();
    return { inputIndex, data: r.bytes(r.u16()) };
  },
  responseIndex: (req) => req.inputIndex,
  failureTail: [0, 0],
  async execute(ctx, req) {
    const { stream } = objectOf(ctx, req.inputIndex, 'stream');
    if (!stream.writable) throw new RopError(STG_E_ACCESSDENIED, 'stream opened read-only');
    const end = stream.position + req.data.length;
    if (end > MAX_STREAM_BYTES) throw new RopError(Ec.StreamSizeError, 'stream too large');
    if (end > stream.data.length) {
      const grown = Buffer.alloc(Math.max(end, stream.data.length * 2));
      stream.data.copy(grown, 0, 0, stream.size);
      stream.data = grown;
    }
    req.data.copy(stream.data, stream.position);
    stream.position = end;
    stream.size = Math.max(stream.size, end);
    stream.dirty = true;
    return okResponse(RopId.WriteStream, req.inputIndex).u16(req.data.length).toBuffer();
  },
});

interface IndexReq { inputIndex: number }

export const ropCommitStream = defineRop<IndexReq>({
  id: RopId.CommitStream,
  name: 'RopCommitStream',
  parse: (r) => ({ inputIndex: r.u8() }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { stream } = objectOf(ctx, req.inputIndex, 'stream');
    if (stream.writable) commitStream(stream);
    return okResponse(RopId.CommitStream, req.inputIndex).toBuffer();
  },
});

export const ropGetStreamSize = defineRop<IndexReq>({
  id: RopId.GetStreamSize,
  name: 'RopGetStreamSize',
  parse: (r) => ({ inputIndex: r.u8() }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { stream } = objectOf(ctx, req.inputIndex, 'stream');
    return okResponse(RopId.GetStreamSize, req.inputIndex).u32(stream.size).toBuffer();
  },
});

export const streamRops: RopDef[] = [ropOpenStream, ropReadStream, ropWriteStream, ropCommitStream, ropGetStreamSize];
