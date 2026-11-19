/**
 * Profile photo processing (9.5) — every upload is decoded and re-encoded, so
 * no byte of the client's file is ever stored or served:
 *
 *   1. size limit (MAX_PHOTO_BYTES) and type by magic bytes (PNG or JPEG; the
 *      declared Content-Type is ignored);
 *   2. dimensions from the header BEFORE decoding — more than MAX_PHOTO_PIXELS
 *      (decompression bomb) or a side below MIN_PHOTO_SIDE is refused;
 *   3. decode (PNG: the pure-JS codec of lib/branding/png.ts, 8-bit
 *      non-interlaced; JPEG: jpeg-js with resolution and memory caps);
 *   4. centre square crop, scale to PHOTO_SIZE × PHOTO_SIZE (area average down,
 *      bilinear up), transparent pixels flattened onto white;
 *   5. encode as baseline JPEG — the output carries no EXIF, GPS, ICC or comment
 *      segments, only the JFIF header.
 *
 * The webmail uploads its own 512×512 rendering of the crop dialog (PNG), so
 * the larger limits only matter for API clients. WebP and other formats are
 * refused with UNSUPPORTED (no pure-JS WebP decoder in the stack). The EXIF
 * orientation of a JPEG upload is not applied (browsers apply it before the
 * webmail renders its crop).
 */
import jpeg from 'jpeg-js';
import { sniffRaster, rasterDimensions } from '../branding/image.js';
import { decodePng, isDecodable, readPngHeader, resizeRgba, type RgbaImage } from '../branding/png.js';

/** Edge length of every stored photo (px). */
export const PHOTO_SIZE = 512;
/** Largest accepted upload (bytes). */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Largest decoded image (pixels) — checked from the header before decoding. Same cap as the PNG codec. */
export const MAX_PHOTO_PIXELS = 2048 * 2048;
/** Smallest accepted side (px). */
export const MIN_PHOTO_SIDE = 32;
/** JPEG quality of the stored photo. */
const JPEG_QUALITY = 88;

export type PhotoErrorCode = 'SIZE' | 'TYPE' | 'UNSUPPORTED' | 'DIMENSIONS' | 'CORRUPT';

/** HTTP status per error code. */
export const PHOTO_ERROR_STATUS: Record<PhotoErrorCode, number> = {
  SIZE: 413, TYPE: 415, UNSUPPORTED: 415, DIMENSIONS: 422, CORRUPT: 422,
};

export class PhotoError extends Error {
  constructor(readonly code: PhotoErrorCode, message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

function decode(body: Buffer, format: 'png' | 'jpeg'): RgbaImage {
  try {
    if (format === 'png') return decodePng(body);
    const img = jpeg.decode(body, {
      useTArray: true, formatAsRGBA: true,
      maxResolutionInMP: MAX_PHOTO_PIXELS / 1_000_000, maxMemoryUsageInMB: 256,
    });
    return { width: img.width, height: img.height, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
  } catch {
    throw new PhotoError('CORRUPT', 'image data could not be decoded');
  }
}

/** The centred square of an image (pure). */
export function cropCenterSquare(img: RgbaImage): RgbaImage {
  const side = Math.min(img.width, img.height);
  if (img.width === side && img.height === side) return img;
  const x0 = Math.floor((img.width - side) / 2);
  const y0 = Math.floor((img.height - side) / 2);
  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    img.data.copy(out, y * side * 4, from, from + side * 4);
  }
  return { width: side, height: side, data: out };
}

/** Bilinear upscale of a square image to size × size (pure; the source must be smaller). */
export function upscaleSquare(img: RgbaImage, size: number): RgbaImage {
  const src = img.width;
  const out = Buffer.alloc(size * size * 4);
  const scale = src / size;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(Math.max((y + 0.5) * scale - 0.5, 0), src - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, src - 1);
    const fy = sy - y0;
    for (let x = 0; x < size; x++) {
      const sx = Math.min(Math.max((x + 0.5) * scale - 0.5, 0), src - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, src - 1);
      const fx = sx - x0;
      const o = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = img.data[(y0 * src + x0) * 4 + c]! * (1 - fx) + img.data[(y0 * src + x1) * 4 + c]! * fx;
        const bottom = img.data[(y1 * src + x0) * 4 + c]! * (1 - fx) + img.data[(y1 * src + x1) * 4 + c]! * fx;
        out[o + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { width: size, height: size, data: out };
}

/** Composites transparent pixels onto white and makes the image opaque (pure, in place). */
export function flattenOnWhite(img: RgbaImage): RgbaImage {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a === 255) continue;
    for (let c = 0; c < 3; c++) d[i + c] = Math.round((d[i + c]! * a + 255 * (255 - a)) / 255);
    d[i + 3] = 255;
  }
  return img;
}

/** Square crop scaled to size × size (pure). */
export function squareAt(img: RgbaImage, size: number): RgbaImage {
  const square = cropCenterSquare(img);
  if (square.width === size) return square;
  return square.width > size ? resizeRgba(square, size) : upscaleSquare(square, size);
}

/** Validates the header of an upload; returns the format to decode. */
function checkUpload(body: Buffer): 'png' | 'jpeg' {
  if (body.length === 0) throw new PhotoError('TYPE', 'empty upload');
  if (body.length > MAX_PHOTO_BYTES) throw new PhotoError('SIZE', `photo may be at most ${MAX_PHOTO_BYTES / 1024 / 1024} MB`);
  const format = sniffRaster(body);
  if (format === 'webp') throw new PhotoError('UNSUPPORTED', 'WebP is not accepted — upload PNG or JPEG');
  if (!format) throw new PhotoError('TYPE', 'not a PNG or JPEG image');
  const dim = rasterDimensions(body, format);
  if (!dim || !(dim.width > 0) || !(dim.height > 0)) throw new PhotoError('CORRUPT', 'unreadable image header');
  if (dim.width * dim.height > MAX_PHOTO_PIXELS) {
    throw new PhotoError('DIMENSIONS', `image has more than ${MAX_PHOTO_PIXELS} pixels (${dim.width}×${dim.height})`);
  }
  if (Math.min(dim.width, dim.height) < MIN_PHOTO_SIDE) {
    throw new PhotoError('DIMENSIONS', `image must be at least ${MIN_PHOTO_SIDE}×${MIN_PHOTO_SIDE} px`);
  }
  const png = format === 'png' ? readPngHeader(body) : null;
  if (png && !isDecodable(png)) throw new PhotoError('UNSUPPORTED', 'PNG must be 8-bit and not interlaced');
  return format;
}

/** Turns an uploaded PNG / JPEG into the stored PHOTO_SIZE² JPEG without metadata. Throws PhotoError. */
export function processProfilePhoto(body: Buffer): Buffer {
  const format = checkUpload(body);
  const img = flattenOnWhite(squareAt(decode(body, format), PHOTO_SIZE));
  return Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data }, JPEG_QUALITY).data);
}
