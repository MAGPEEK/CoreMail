/**
 * Extended buffers (MS-OXCRPC 2.2.2.1 RPC_HEADER_EXT, 3.1.4.2.1): the ROP and
 * auxiliary payloads of an Execute request/response are prefixed by
 *   Version (2, 0x0000) | Flags (2) | Size (2) | SizeActual (2)
 * Flags: Compressed 0x0001, XorMagic 0x0002, Last 0x0004. A payload never
 * exceeds 32 KB.
 *
 * The server does not announce extended-buffer packing (no
 * AUX_SERVER_CAPABILITIES), so a client sends exactly one extended buffer; the
 * server answers with one uncompressed, unobfuscated buffer carrying Last.
 */
import { BufferReader, WireFormatError } from './reader.js';
import { BufferWriter } from './writer.js';
import { decompressDirect2 } from './lz77.js';

export const RPC_HEADER_EXT_SIZE = 8;
export const MAX_EXTENDED_PAYLOAD = 0x8000;

export const ExtFlags = {
  Compressed: 0x0001,
  XorMagic: 0x0002,
  Last: 0x0004,
} as const;

/** MS-OXCRPC 3.1.4.1.1.3: every byte XOR 0xA5 (an involution). */
export function xorMagic(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i]! ^ 0xa5;
  return out;
}

/**
 * Reads the single extended buffer of a request and returns its plain payload
 * (obfuscation reverted first, then decompressed — the inverse of the client's order).
 */
export function readExtendedBuffer(buf: Buffer): Buffer {
  const r = new BufferReader(buf);
  if (r.remaining < RPC_HEADER_EXT_SIZE) throw new WireFormatError('extended buffer shorter than its header');
  const version = r.u16();
  const flags = r.u16();
  const size = r.u16();
  const sizeActual = r.u16();
  if (version !== 0) throw new WireFormatError(`unknown RPC_HEADER_EXT version ${version}`);
  if ((flags & ExtFlags.Last) === 0 || size !== r.remaining) {
    throw new WireFormatError('only a single extended buffer is accepted');
  }
  let payload = r.bytes(size);
  if (flags & ExtFlags.XorMagic) payload = xorMagic(payload);
  if (flags & ExtFlags.Compressed) {
    if (sizeActual <= size && size > 0) throw new WireFormatError('compressed payload not smaller than its plain size');
    payload = decompressDirect2(payload, sizeActual);
  } else if (sizeActual !== size) {
    throw new WireFormatError('Size and SizeActual differ without compression');
  }
  return payload;
}

/** Wraps a response payload in one extended buffer (Last, no compression/obfuscation). */
export function writeExtendedBuffer(payload: Buffer): Buffer {
  if (payload.length > MAX_EXTENDED_PAYLOAD) throw new RangeError(`extended payload ${payload.length} > 32 KB`);
  return new BufferWriter(payload.length + RPC_HEADER_EXT_SIZE)
    .u16(0).u16(ExtFlags.Last).u16(payload.length).u16(payload.length)
    .bytes(payload)
    .toBuffer();
}
