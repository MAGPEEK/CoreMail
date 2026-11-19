/**
 * Marker walk of a JPEG upload (9.5 profile photos) — pure, linear in the file
 * size and run BEFORE jpeg-js touches the data.
 *
 * jpeg-js caps pixels and memory, but not CPU: every scan (SOS) walks all
 * blocks of the frame again, and a scan costs only a few bytes when its blocks
 * are end-of-band runs. A 5 MB file of such scans keeps the event loop busy for
 * minutes. The walk therefore counts frames, scans and segments and the caller
 * refuses files beyond MAX_JPEG_SCANS / MAX_JPEG_SEGMENTS. It also returns the
 * frame size from the one frame header jpeg-js will decode, so the pixel check
 * and the decoder always agree.
 */

/** Most scans accepted (libjpeg writes 10 for a progressive colour image, baseline has 1–3). */
export const MAX_JPEG_SCANS = 32;
/** Most marker segments accepted (APPn, DQT, DHT, SOS …; ordinary files have well under 100). */
export const MAX_JPEG_SEGMENTS = 512;

/** Frame types jpeg-js decodes: baseline, extended sequential and progressive Huffman. */
const DECODABLE_SOF = new Set([0xc0, 0xc1, 0xc2]);
/** Every other start-of-frame marker (lossless, hierarchical, arithmetic coding). */
const OTHER_SOF = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export interface JpegStructure {
  /** Frame headers of every type. */
  frames: number;
  /** True when the only frame is one jpeg-js decodes. */
  decodable: boolean;
  width: number;
  height: number;
  scans: number;
  segments: number;
}

const isRst = (m: number): boolean => m >= 0xd0 && m <= 0xd7;

/** Offset of the next marker after the entropy-coded data starting at `i`. */
function skipEntropyData(buf: Buffer, i: number): number {
  while (i + 1 < buf.length) {
    if (buf[i] === 0xff) {
      const next = buf[i + 1]!;
      if (next !== 0x00 && next !== 0xff && !isRst(next)) return i;
    }
    i++;
  }
  return buf.length;
}

/** The marker structure of a JPEG (starting with SOI), or null when it is malformed (pure). */
export function readJpegStructure(buf: Buffer): JpegStructure | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out: JpegStructure = { frames: 0, decodable: false, width: 0, height: 0, scans: 0, segments: 0 };
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1]!;
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0xd9) break; // EOI
    if (isRst(m) || m === 0x01) { i += 2; continue; }
    if (i + 4 > buf.length) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    out.segments++;
    if (DECODABLE_SOF.has(m) || OTHER_SOF.has(m)) {
      if (len < 7) return null;
      out.frames++;
      out.decodable = DECODABLE_SOF.has(m);
      out.height = buf.readUInt16BE(i + 5);
      out.width = buf.readUInt16BE(i + 7);
    }
    i += 2 + len;
    if (m === 0xda) {
      out.scans++;
      i = skipEntropyData(buf, i);
    }
  }
  return out;
}
