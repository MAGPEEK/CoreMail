/**
 * Decompression of extended-buffer payloads (MS-OXCRPC 3.1.4.1.1.2: LZ77 with
 * the DIRECT2 encoding).
 *
 *  - A 4-byte little-endian bitmask precedes each group of 32 elements; bits are
 *    consumed from the most significant one. 0 = literal byte, 1 = metadata.
 *  - Metadata is 2 bytes: high 13 bits = (offset - 1), low 3 bits = (length - 3).
 *    Length bits b'111' continue in a nibble of a "shared" byte (low nibble first,
 *    the high nibble serves the next long match), then a full byte, then a 16-bit
 *    value that holds the whole length minus 3 (MS-OXCRPC 3.1.4.1.1.2.2.4).
 *  - A metadata bit with no input left ends the stream.
 *
 * Only the server's input side needs it: the server never compresses its own
 * responses (they carry no Compressed flag), which the protocol allows.
 */
import { WireFormatError } from './reader.js';

export function decompressDirect2(input: Buffer, expectedSize: number): Buffer {
  const out = Buffer.alloc(expectedSize);
  let inPos = 0;
  let outPos = 0;
  let flags = 0;
  let flagCount = 0;
  let sharedNibblePos = -1;

  const readByte = (): number => {
    if (inPos >= input.length) throw new WireFormatError('compressed payload truncated');
    return input[inPos++]!;
  };

  for (;;) {
    if (flagCount === 0) {
      if (inPos + 4 > input.length) throw new WireFormatError('compressed payload truncated (bitmask)');
      flags = input.readUInt32LE(inPos);
      inPos += 4;
      flagCount = 32;
    }
    flagCount--;
    const isMatch = ((flags >>> flagCount) & 1) === 1;

    if (!isMatch) {
      if (outPos >= expectedSize) throw new WireFormatError('compressed payload larger than announced');
      out[outPos++] = readByte();
      continue;
    }

    if (inPos >= input.length) break; // end-of-stream marker

    const meta = readByte() | (readByte() << 8);
    const offset = (meta >>> 3) + 1;
    let length = meta & 7;
    if (length === 7) {
      if (sharedNibblePos < 0) {
        sharedNibblePos = inPos;
        length = readByte() & 0x0f;
      } else {
        length = input[sharedNibblePos]! >>> 4;
        sharedNibblePos = -1;
      }
      if (length === 15) {
        length = readByte();
        if (length === 255) {
          length = readByte() | (readByte() << 8);
          if (length < 15 + 7) throw new WireFormatError('invalid extended match length');
          length -= 15 + 7;
        }
        length += 15;
      }
      length += 7;
    }
    length += 3;

    if (offset > outPos) throw new WireFormatError('match offset before start of output');
    if (outPos + length > expectedSize) throw new WireFormatError('compressed payload larger than announced');
    // Byte by byte: matches may overlap their own output (run-length style).
    for (let i = 0; i < length; i++, outPos++) out[outPos] = out[outPos - offset]!;
  }

  if (outPos !== expectedSize) throw new WireFormatError(`decompressed ${outPos} bytes, expected ${expectedSize}`);
  return out;
}
