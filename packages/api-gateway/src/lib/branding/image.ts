/**
 * Branding asset validation (9.3): magic bytes, size and dimension limits per
 * slot, PNG / WebP / JPEG dimensions read from the headers (no native
 * dependencies), SVG through the strict sanitiser (svg.ts).
 */
import type { BrandingAssetSlot } from '@coremail/storage';
import { sanitizeSvg, SvgUnsafeError } from './svg.js';

export type AssetFormat = 'png' | 'webp' | 'jpeg' | 'svg';

export const FORMAT_CONTENT_TYPE: Record<AssetFormat, string> = {
  png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg', svg: 'image/svg+xml',
};
export const FORMAT_EXT: Record<AssetFormat, string> = { png: 'png', webp: 'webp', jpeg: 'jpg', svg: 'svg' };
export const EXT_CONTENT_TYPE: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', svg: 'image/svg+xml' };

export interface SlotRule { formats: readonly AssetFormat[]; maxBytes: number; maxPx: number; square: boolean }

export const SLOT_RULES: Record<BrandingAssetSlot, SlotRule> = {
  logoLight:       { formats: ['png', 'webp', 'svg'],         maxBytes: 512 * 1024,      maxPx: 4096, square: false },
  logoDark:        { formats: ['png', 'webp', 'svg'],         maxBytes: 512 * 1024,      maxPx: 4096, square: false },
  favicon:         { formats: ['png', 'webp', 'svg'],         maxBytes: 512 * 1024,      maxPx: 1024, square: true },
  loginBackground: { formats: ['png', 'webp', 'jpeg', 'svg'], maxBytes: 2 * 1024 * 1024, maxPx: 4096, square: false },
};

/** Largest upload any slot accepts (raw body parser limit). */
export const MAX_ASSET_BYTES = Math.max(...Object.values(SLOT_RULES).map((r) => r.maxBytes));

export type AssetErrorCode = 'TYPE' | 'SIZE' | 'DIMENSIONS' | 'SVG_UNSAFE';

export class AssetError extends Error {
  constructor(readonly code: AssetErrorCode, message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

/** Format named by a Content-Type header (parameters ignored), or null. */
export function formatFromContentType(ct: string | undefined): AssetFormat | null {
  const t = (ct ?? '').split(';')[0]!.trim().toLowerCase();
  const hit = (Object.entries(FORMAT_CONTENT_TYPE) as Array<[AssetFormat, string]>).find(([, v]) => v === t);
  return hit ? hit[0] : null;
}

/** Raster format by magic bytes, or null. */
export function sniffRaster(buf: Buffer): Exclude<AssetFormat, 'svg'> | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return null;
}

export interface Dimensions { width: number; height: number }

function pngSize(buf: Buffer): Dimensions | null {
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function webpSize(buf: Buffer): Dimensions | null {
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    if (buf.length < 30 || buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (chunk === 'VP8X') {
    if (buf.length < 30) return null;
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(buf: Buffer): Dimensions | null {
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return null;
    let m = buf[i + 1]!;
    while (m === 0xff && i + 2 < buf.length) { i++; m = buf[i + 1]!; }
    if (m === 0xd9 || m === 0xda) return null; // EOI / start of scan before a frame header
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    if (i + 4 > buf.length) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (SOF.has(m)) {
      if (i + 9 > buf.length) return null;
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

export function rasterDimensions(buf: Buffer, fmt: Exclude<AssetFormat, 'svg'>): Dimensions | null {
  try {
    return fmt === 'png' ? pngSize(buf) : fmt === 'webp' ? webpSize(buf) : jpegSize(buf);
  } catch {
    return null;
  }
}

export interface ValidatedAsset { format: AssetFormat; data: Buffer; contentType: string; ext: string }

function checkDimensions(slot: BrandingAssetSlot, rule: SlotRule, w: number | null, h: number | null, known: boolean): void {
  if (!known) return;
  if (w === null || h === null || !(w > 0) || !(h > 0)) throw new AssetError('DIMENSIONS', 'image has no usable width/height');
  if (w > rule.maxPx || h > rule.maxPx) throw new AssetError('DIMENSIONS', `image larger than ${rule.maxPx}×${rule.maxPx} px (${Math.round(w)}×${Math.round(h)})`);
  if (rule.square && Math.abs(w - h) > Math.max(w, h) * 0.01) throw new AssetError('DIMENSIONS', `${slot} must be square (${Math.round(w)}×${Math.round(h)})`);
}

/**
 * Validates an upload for `slot`: declared type allowed for the slot, magic
 * bytes match the declared type, size and dimension limits, SVG sanitised.
 * Returns the bytes to store (the re-serialised SVG for SVG uploads).
 */
export function validateAsset(slot: BrandingAssetSlot, contentType: string | undefined, body: Buffer): ValidatedAsset {
  const rule = SLOT_RULES[slot];
  const declared = formatFromContentType(contentType);
  if (!declared || !rule.formats.includes(declared)) {
    throw new AssetError('TYPE', `${slot} accepts ${rule.formats.map((f) => FORMAT_CONTENT_TYPE[f]).join(', ')}`);
  }
  if (body.length === 0) throw new AssetError('TYPE', 'empty upload');
  if (body.length > rule.maxBytes) throw new AssetError('SIZE', `${slot} may be at most ${Math.round(rule.maxBytes / 1024)} KB`);

  const sniffed = sniffRaster(body);
  if (declared === 'svg') {
    if (sniffed) throw new AssetError('TYPE', 'content is a raster image, not SVG');
    let out;
    try {
      out = sanitizeSvg(body, { maxBytes: rule.maxBytes });
    } catch (err) {
      if (err instanceof SvgUnsafeError) throw new AssetError('SVG_UNSAFE', err.message);
      throw err;
    }
    checkDimensions(slot, rule, out.width, out.height, out.width !== null || out.height !== null);
    return { format: 'svg', data: Buffer.from(out.svg, 'utf8'), contentType: FORMAT_CONTENT_TYPE.svg, ext: FORMAT_EXT.svg };
  }
  if (sniffed !== declared) throw new AssetError('TYPE', `content does not match ${FORMAT_CONTENT_TYPE[declared]}`);
  const dim = rasterDimensions(body, declared);
  if (!dim) throw new AssetError('TYPE', `unreadable ${declared.toUpperCase()} header`);
  checkDimensions(slot, rule, dim.width, dim.height, true);
  return { format: declared, data: body, contentType: FORMAT_CONTENT_TYPE[declared], ext: FORMAT_EXT[declared] };
}
