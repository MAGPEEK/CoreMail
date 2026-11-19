/**
 * Minimal PNG codec for the app icons of a custom branding favicon (9.4) —
 * pure JavaScript on node:zlib, no native image library.
 *
 *   readPngHeader(buf)       IHDR fields (cheap: the manifest asks per request)
 *   decodePng(buf)           8-bit, non-interlaced PNGs of every colour type
 *                            (grey, RGB, palette incl. tRNS, grey+alpha, RGBA)
 *                            → RGBA; anything else → PngUnsupportedError
 *   resizeRgba(...)          area-average downscale (premultiplied alpha)
 *   encodePng(...)           8-bit RGBA PNG
 *
 * WebP and JPEG are not decoded (no pure-JS decoder without a new dependency);
 * such favicons keep the default app icons. The encoder matches the build-time
 * icon writer of the web client (scripts/app-icons.mjs).
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Channels per colour type (0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA). */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Upper bound of decoded pixels (branding favicons are at most 1024×1024). */
const MAX_PIXELS = 2048 * 2048;

export class PngUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngUnsupportedError';
  }
}

export interface PngHeader { width: number; height: number; bitDepth: number; colorType: number; interlace: number }

export interface RgbaImage { width: number; height: number; data: Buffer }

/** The IHDR of a PNG, or null when `buf` is no PNG. */
export function readPngHeader(buf: Buffer): PngHeader | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16), height: buf.readUInt32BE(20),
    bitDepth: buf[24]!, colorType: buf[25]!, interlace: buf[28]!,
  };
}

/** Whether decodePng() handles this header (`maxPixels`: decoded size cap, default 2048²). */
export function isDecodable(h: PngHeader, maxPixels = MAX_PIXELS): boolean {
  return h.bitDepth === 8 && h.interlace === 0 && CHANNELS[h.colorType] !== undefined
    && h.width > 0 && h.height > 0 && h.width * h.height <= maxPixels;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses the per-row filters in place; returns the unfiltered rows (no filter bytes). */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) throw new PngUnsupportedError('PNG: truncated image data');
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]!;
      const a = i >= bpp ? out[row + i - bpp]! : 0;
      const b = y > 0 ? out[prev + i]! : 0;
      const c = y > 0 && i >= bpp ? out[prev + i - bpp]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new PngUnsupportedError(`PNG: unknown filter ${filter}`);
      }
      out[row + i] = v & 0xff;
    }
  }
  return out;
}

/** Decodes an 8-bit, non-interlaced PNG to RGBA. */
export function decodePng(buf: Buffer, maxPixels = MAX_PIXELS): RgbaImage {
  const h = readPngHeader(buf);
  if (!h) throw new PngUnsupportedError('not a PNG');
  if (!isDecodable(h, maxPixels)) throw new PngUnsupportedError('PNG: only 8-bit, non-interlaced images are supported');
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let alpha: Buffer | null = null;
  for (let off = 8; off + 12 <= buf.length;) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') alpha = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (h.colorType === 3 && !palette) throw new PngUnsupportedError('PNG: palette missing');
  const channels = CHANNELS[h.colorType]!;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (h.width * channels + 1) * h.height + 1024 });
  } catch {
    throw new PngUnsupportedError('PNG: corrupt image data');
  }
  const px = unfilter(raw, h.width, h.height, channels);
  const data = Buffer.alloc(h.width * h.height * 4);
  for (let i = 0, o = 0; i < h.width * h.height; i++, o += 4) {
    const s = i * channels;
    switch (h.colorType) {
      case 0: data[o] = data[o + 1] = data[o + 2] = px[s]!; data[o + 3] = 255; break;
      case 2: data[o] = px[s]!; data[o + 1] = px[s + 1]!; data[o + 2] = px[s + 2]!; data[o + 3] = 255; break;
      case 3: {
        const idx = px[s]!;
        data[o] = palette![idx * 3] ?? 0; data[o + 1] = palette![idx * 3 + 1] ?? 0; data[o + 2] = palette![idx * 3 + 2] ?? 0;
        data[o + 3] = alpha && idx < alpha.length ? alpha[idx]! : 255;
        break;
      }
      case 4: data[o] = data[o + 1] = data[o + 2] = px[s]!; data[o + 3] = px[s + 1]!; break;
      default: px.copy(data, o, s, s + 4);
    }
  }
  return { width: h.width, height: h.height, data };
}

/** Area-average downscale to size × size (the source must be square and at least that large). */
export function resizeRgba(img: RgbaImage, size: number): RgbaImage {
  if (img.width !== img.height || img.width < size) throw new RangeError('resizeRgba: square source of at least the target size expected');
  const scale = img.width / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = y * scale;
    const y1 = y0 + scale;
    for (let x = 0; x < size; x++) {
      const x0 = x * scale;
      const x1 = x0 + scale;
      let r = 0, g = 0, b = 0, a = 0, w = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const weight = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const s = (sy * img.width + sx) * 4;
          const pa = img.data[s + 3]! * weight;
          r += img.data[s]! * pa; g += img.data[s + 1]! * pa; b += img.data[s + 2]! * pa;
          a += pa; w += weight;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / w);
    }
  }
  return { width: size, height: size, data: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 8-bit RGBA PNG (filter 0 on every row). */
export function encodePng(img: RgbaImage): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
