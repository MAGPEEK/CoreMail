/**
 * ROP input and output buffers (MS-OXCROPS 2.2.1):
 *   RopSize (2, counts itself and RopsList) | RopsList | ServerObjectHandleTable (u32 each)
 */
import { BufferReader, WireFormatError } from '../wire/reader.js';
import { BufferWriter } from '../wire/writer.js';

export interface RopInput {
  ropsList: Buffer;
  handles: number[];
}

export function parseRopInput(buf: Buffer): RopInput {
  const r = new BufferReader(buf);
  const ropSize = r.u16();
  if (ropSize < 2 || ropSize > buf.length) throw new WireFormatError(`RopSize ${ropSize} invalid for ${buf.length} bytes`);
  const ropsList = r.bytes(ropSize - 2);
  if (r.remaining % 4 !== 0) throw new WireFormatError('Server object handle table is not a multiple of 4 bytes');
  const handles: number[] = [];
  while (!r.atEnd) handles.push(r.u32());
  return { ropsList, handles };
}

export function buildRopOutput(responses: Buffer, handles: readonly number[]): Buffer {
  const w = new BufferWriter(2 + responses.length + handles.length * 4);
  w.u16(2 + responses.length).bytes(responses);
  for (const h of handles) w.u32(h);
  return w.toBuffer();
}

/** Bytes the output buffer framing needs besides the responses. */
export function outputOverhead(handleCount: number): number {
  return 2 + handleCount * 4;
}
