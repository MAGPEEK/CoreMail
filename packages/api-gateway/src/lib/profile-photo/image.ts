/**
 * Profile photo processing (9.5) — every upload is decoded and re-encoded, so
 * no byte of the client's file is ever stored or served:
 *
 *   1. size limit (MAX_PHOTO_BYTES) and type by magic bytes (PNG or JPEG; the
 *      declared Content-Type is ignored);
 *   2. dimensions from the header BEFORE decoding — more than MAX_PHOTO_PIXELS
 *      (decompression bomb) or a side below MIN_PHOTO_SIDE is refused; a JPEG
 *      must have exactly one decodable frame and at most MAX_JPEG_SCANS scans
 *      (jpeg-structure.ts: CPU bomb of many tiny scans);
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
 *
 * 10.2: the routes run these functions in a worker thread, at most
 * IMAGE_DECODE_CONCURRENCY at a time per process (decode-pool.ts).
 */
import jpeg from 'jpeg-js';
import { sniffRaster } from '../branding/image.js';
import { decodePng, isDecodable, readPngHeader, resizeRgba, type RgbaImage } from '../branding/png.js';
import { readJpegStructure, MAX_JPEG_SCANS, MAX_JPEG_SEGMENTS } from './jpeg-structure.js';

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
/**
 * Memory cap of jpeg-js. A MAX_PHOTO_PIXELS CMYK frame without subsampling needs
 * about 100 MB (coefficient blocks, component planes, RGBA output).
 */
const JPEG_MAX_MEMORY_MB = 128;

/** 10.1 webmail background: largest stored width / height (px, downscale only). */
export const BACKGROUND_MAX_WIDTH = 2560;
export const BACKGROUND_MAX_HEIGHT = 2560;
/** Largest accepted background upload (bytes) — same as a photo. */
export const MAX_BACKGROUND_BYTES = MAX_PHOTO_BYTES;
/** Largest decoded background (pixels): a 12-megapixel camera picture (4000×3000). */
export const MAX_BACKGROUND_PIXELS = 12_000_000;
/** Smallest accepted background side (px) — smaller pictures look like mud when stretched. */
export const MIN_BACKGROUND_SIDE = 320;
const BACKGROUND_JPEG_QUALITY = 82;
/**
 * 10.2: memory cap of jpeg-js for a background (MiB). jpeg-js counts 4 bytes per
 * coefficient, 1 per component sample, then the colour-converted and the output
 * pixels (3 bytes each, decoded as RGB): a 12-megapixel camera picture (4:2:0,
 * ≈ 13.5 bytes per pixel ≈ 162 MB) fits; a 12-megapixel JPEG without chroma
 * subsampling (≈ 21 bytes per pixel) or in CMYK does not and is refused with
 * DIMENSIONS. At most IMAGE_DECODE_CONCURRENCY decodes run
 * at a time (decode-pool.ts), so the decoders of one process stay below
 * 2 × this cap.
 */
export const BACKGROUND_JPEG_MAX_MEMORY_MB = 160;

/** Limits of one kind of upload (checked from the header before decoding). */
export interface ImageLimits {
  maxBytes: number;
  maxPixels: number;
  minSide: number;
  /** jpeg-js memory cap (MB) for maxPixels. */
  jpegMemoryMb: number;
  /** "photo" / "background" in error messages. */
  noun: string;
}

const PHOTO_LIMITS: ImageLimits = {
  maxBytes: MAX_PHOTO_BYTES, maxPixels: MAX_PHOTO_PIXELS, minSide: MIN_PHOTO_SIDE, jpegMemoryMb: JPEG_MAX_MEMORY_MB, noun: 'photo',
};
const BACKGROUND_LIMITS: ImageLimits = {
  maxBytes: MAX_BACKGROUND_BYTES, maxPixels: MAX_BACKGROUND_PIXELS, minSide: MIN_BACKGROUND_SIDE, jpegMemoryMb: BACKGROUND_JPEG_MAX_MEMORY_MB, noun: 'background',
};

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

/** Decoded pixels: RGBA, or RGB for a JPEG decoded with `jpegChannels` 3 (no alpha channel to allocate). */
interface DecodedImage extends RgbaImage { channels: 3 | 4 }

function decode(body: Buffer, format: 'png' | 'jpeg', limits: ImageLimits, jpegChannels: 3 | 4 = 4): DecodedImage {
  try {
    if (format === 'png') return { ...decodePng(body, limits.maxPixels), channels: 4 };
    const img = jpeg.decode(body, {
      useTArray: true, formatAsRGBA: jpegChannels === 4,
      maxResolutionInMP: limits.maxPixels / 1_000_000, maxMemoryUsageInMB: limits.jpegMemoryMb,
    });
    return {
      width: img.width, height: img.height, channels: jpegChannels,
      data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
    };
  } catch (err) {
    if (err instanceof Error && /maxMemoryUsageInMB/.test(err.message)) {
      throw new PhotoError('DIMENSIONS', `${limits.noun} needs too much memory to decode — use a smaller picture or a standard (subsampled) JPEG`);
    }
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

/** Width and height of a PNG (IHDR) or JPEG (its single frame) upload; refuses JPEGs jpeg-js must not decode. */
function uploadDimensions(body: Buffer, format: 'png' | 'jpeg'): { width: number; height: number } {
  if (format === 'png') {
    const png = readPngHeader(body);
    if (!png) throw new PhotoError('CORRUPT', 'unreadable image header');
    return png;
  }
  const jpg = readJpegStructure(body);
  if (!jpg || jpg.frames === 0) throw new PhotoError('CORRUPT', 'unreadable image header');
  if (jpg.frames > 1 || !jpg.decodable) throw new PhotoError('UNSUPPORTED', 'JPEG must be a single baseline or progressive image');
  if (jpg.scans > MAX_JPEG_SCANS || jpg.segments > MAX_JPEG_SEGMENTS) {
    throw new PhotoError('UNSUPPORTED', `JPEG has too many scans or segments (at most ${MAX_JPEG_SCANS} scans)`);
  }
  return jpg;
}

/** Validates the header of an upload against `limits`; returns the format to decode. */
function checkUpload(body: Buffer, limits: ImageLimits): 'png' | 'jpeg' {
  if (body.length === 0) throw new PhotoError('TYPE', 'empty upload');
  if (body.length > limits.maxBytes) throw new PhotoError('SIZE', `${limits.noun} may be at most ${limits.maxBytes / 1024 / 1024} MB`);
  const format = sniffRaster(body);
  if (format === 'webp') throw new PhotoError('UNSUPPORTED', 'WebP is not accepted — upload PNG or JPEG');
  if (!format) throw new PhotoError('TYPE', 'not a PNG or JPEG image');
  const dim = uploadDimensions(body, format);
  if (!(dim.width > 0) || !(dim.height > 0)) throw new PhotoError('CORRUPT', 'unreadable image header');
  if (dim.width * dim.height > limits.maxPixels) {
    throw new PhotoError('DIMENSIONS', `image has more than ${limits.maxPixels} pixels (${dim.width}×${dim.height})`);
  }
  if (Math.min(dim.width, dim.height) < limits.minSide) {
    throw new PhotoError('DIMENSIONS', `image must be at least ${limits.minSide}×${limits.minSide} px`);
  }
  const png = format === 'png' ? readPngHeader(body) : null;
  if (png && !isDecodable(png, limits.maxPixels)) throw new PhotoError('UNSUPPORTED', 'PNG must be 8-bit and not interlaced');
  return format;
}

const encodeJpeg = (img: RgbaImage, quality: number): Buffer =>
  Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data);

/** Turns an uploaded PNG / JPEG into the stored PHOTO_SIZE² JPEG without metadata. Throws PhotoError. */
export function processProfilePhoto(body: Buffer): Buffer {
  const format = checkUpload(body, PHOTO_LIMITS);
  return encodeJpeg(flattenOnWhite(squareAt(decode(body, format, PHOTO_LIMITS), PHOTO_SIZE)), JPEG_QUALITY);
}

/** Size that fits into maxW × maxH with the same aspect ratio; never larger than the source (pure). */
export function fitSize(width: number, height: number, maxW: number, maxH: number): { width: number; height: number } {
  const scale = Math.min(1, maxW / width, maxH / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Area-average downscale of an opaque image to an RGBA image of width × height (pure; the target
 * must not be larger). The source is RGBA, or RGB with `channels: 3` (then always a new RGBA image).
 */
export function downscaleRgba(img: RgbaImage & { channels?: 3 | 4 }, width: number, height: number): RgbaImage {
  if (width > img.width || height > img.height) throw new RangeError('downscaleRgba: target larger than the source');
  const ch = img.channels ?? 4;
  if (ch === 4 && width === img.width && height === img.height) return img;
  const sx = img.width / width;
  const sy = img.height / height;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let r = 0, g = 0, b = 0, w = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        const wy = Math.min(py + 1, y1) - Math.max(py, y0);
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const weight = wy * (Math.min(px + 1, x1) - Math.max(px, x0));
          const s = (py * img.width + px) * ch;
          r += img.data[s]! * weight; g += img.data[s + 1]! * weight; b += img.data[s + 2]! * weight;
          w += weight;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / w); out[o + 1] = Math.round(g / w); out[o + 2] = Math.round(b / w); out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/**
 * 10.1: turns an uploaded PNG / JPEG into the stored webmail background — a JPEG
 * of at most BACKGROUND_MAX_WIDTH × BACKGROUND_MAX_HEIGHT (aspect ratio kept,
 * never enlarged), transparency flattened onto white, no metadata (only the
 * JFIF header). Same checks as a photo (magic bytes, header limits before
 * decoding, JPEG structure), with the larger background limits. A JPEG is
 * decoded to RGB (no alpha to flatten; 3 instead of 4 bytes per pixel keep a
 * 12 MP picture under BACKGROUND_JPEG_MAX_MEMORY_MB). Throws PhotoError.
 */
export function processBackgroundImage(body: Buffer): Buffer {
  const format = checkUpload(body, BACKGROUND_LIMITS);
  const img = decode(body, format, BACKGROUND_LIMITS, 3);
  if (img.channels === 4) flattenOnWhite(img);
  const size = fitSize(img.width, img.height, BACKGROUND_MAX_WIDTH, BACKGROUND_MAX_HEIGHT);
  return encodeJpeg(downscaleRgba(img, size.width, size.height), BACKGROUND_JPEG_QUALITY);
}
