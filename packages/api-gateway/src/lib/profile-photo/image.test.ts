/**
 * 9.5 profile photo processing: magic bytes, size / pixel limits checked before
 * decoding, re-encoding to a 512×512 JPEG without metadata, crop and scale math.
 * Run: node --import tsx --test src/lib/profile-photo/image.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { encodePng, type RgbaImage } from '../branding/png.js';
import { fakePng, fakeJpeg, fakeWebpLossless } from '../branding/test-fixtures.js';
import {
  processProfilePhoto, cropCenterSquare, upscaleSquare, flattenOnWhite, squareAt, PhotoError,
  PHOTO_SIZE, MAX_PHOTO_BYTES, MAX_PHOTO_PIXELS, MIN_PHOTO_SIDE, PHOTO_ERROR_STATUS,
} from './image.js';

/** w × h image: left half red, right half blue, alpha `a`. */
function halves(w: number, h: number, a = 255): RgbaImage {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (x < w / 2) data[o] = 255; else data[o + 2] = 255;
      data[o + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

/** JPEG markers (second byte of each FFxx segment before the scan). */
function jpegMarkers(buf: Buffer): number[] {
  const out: number[] = [];
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const m = buf[i + 1]!;
    out.push(m);
    if (m === 0xda) break;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return out;
}

/** A JPEG with an APP1 Exif segment carrying a GPS marker string and a comment. */
function jpegWithExif(w: number, h: number): Buffer {
  const plain = Buffer.from(jpeg.encode({ width: w, height: h, data: halves(w, h).data }, 90).data);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('GPSLatitude=48.1;Make=SecretCam', 'latin1')]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(payload.length + 2, 2);
  const com = Buffer.from('author: someone', 'latin1');
  const comHead = Buffer.from([0xff, 0xfe, 0, 0]);
  comHead.writeUInt16BE(com.length + 2, 2);
  return Buffer.concat([plain.subarray(0, 2), app1, payload, comHead, com, plain.subarray(2)]);
}

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (err) { if (err instanceof PhotoError) return err.code; throw err; }
  return 'none';
}

test('PNG upload → 512×512 baseline JPEG with only the JFIF header', () => {
  const out = processProfilePhoto(encodePng(halves(800, 600)));
  assert.equal(out[0], 0xff); assert.equal(out[1], 0xd8);
  const img = jpeg.decode(out, { useTArray: true });
  assert.equal(img.width, PHOTO_SIZE);
  assert.equal(img.height, PHOTO_SIZE);
  assert.deepEqual(jpegMarkers(out).filter((m) => m >= 0xe1 && m <= 0xef), [], 'no APPn segment besides APP0');
  assert.equal(jpegMarkers(out).includes(0xfe), false, 'no comment');
});

test('metadata is stripped: EXIF / GPS / comments of a JPEG upload never reach the output', () => {
  const input = jpegWithExif(640, 640);
  assert.ok(input.includes(Buffer.from('GPSLatitude')), 'fixture carries GPS data');
  const out = processProfilePhoto(input);
  assert.equal(out.includes(Buffer.from('GPSLatitude')), false);
  assert.equal(out.includes(Buffer.from('Exif')), false);
  assert.equal(out.includes(Buffer.from('author')), false);
  assert.equal(jpegMarkers(out).includes(0xe1), false);
  assert.equal(jpeg.decode(out).width, PHOTO_SIZE);
});

test('wrong magic bytes are refused whatever the client declares', () => {
  assert.equal(codeOf(() => processProfilePhoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))), 'TYPE');
  assert.equal(codeOf(() => processProfilePhoto(Buffer.from('GIF89a......'))), 'TYPE');
  assert.equal(codeOf(() => processProfilePhoto(Buffer.alloc(0))), 'TYPE');
  assert.equal(codeOf(() => processProfilePhoto(fakeWebpLossless(600, 600))), 'UNSUPPORTED');
  assert.equal(PHOTO_ERROR_STATUS.TYPE, 415);
});

test('too large: more than 5 MB is refused before anything is parsed', () => {
  const big = Buffer.concat([encodePng(halves(64, 64)), Buffer.alloc(MAX_PHOTO_BYTES)]);
  assert.equal(codeOf(() => processProfilePhoto(big)), 'SIZE');
  assert.equal(PHOTO_ERROR_STATUS.SIZE, 413);
});

test('decompression bombs: too many pixels are refused from the header, without decoding', () => {
  // header-only fixtures: decoding them would fail, so DIMENSIONS proves the early check
  assert.equal(codeOf(() => processProfilePhoto(fakePng(5000, 5000))), 'DIMENSIONS');
  assert.equal(codeOf(() => processProfilePhoto(fakeJpeg(30000, 30000))), 'DIMENSIONS');
  assert.equal(codeOf(() => processProfilePhoto(fakePng(MAX_PHOTO_PIXELS / 1024 + 1, 1024))), 'DIMENSIONS');
  assert.equal(codeOf(() => processProfilePhoto(fakePng(MIN_PHOTO_SIDE - 1, 400))), 'DIMENSIONS', 'too small');
  assert.equal(PHOTO_ERROR_STATUS.DIMENSIONS, 422);
});

test('broken data behind a valid header is CORRUPT, unsupported PNG variants UNSUPPORTED', () => {
  assert.equal(codeOf(() => processProfilePhoto(fakePng(100, 100))), 'CORRUPT');
  assert.equal(codeOf(() => processProfilePhoto(fakeJpeg(100, 100))), 'CORRUPT');
  const interlaced = encodePng(halves(64, 64));
  interlaced[28] = 1; // interlace method Adam7 (CRC no longer matters for the header check)
  assert.equal(codeOf(() => processProfilePhoto(interlaced)), 'UNSUPPORTED');
});

test('crop: centre square of landscape and portrait images', () => {
  const land = cropCenterSquare(halves(6, 2));
  assert.equal(land.width, 2);
  // columns 2..3 of a 6-wide image: x=2 is red (x < 3), x=3 is blue
  assert.deepEqual([...land.data.subarray(0, 8)], [255, 0, 0, 255, 0, 0, 255, 255]);
  const portrait = cropCenterSquare(halves(2, 6));
  assert.equal(portrait.width, 2);
  assert.equal(portrait.height, 2);
  const square = halves(4, 4);
  assert.equal(cropCenterSquare(square), square, 'a square image is returned as is');
});

test('scale: small images are upscaled, large ones averaged down to the target size', () => {
  const up = upscaleSquare(halves(2, 2), 8);
  assert.equal(up.width, 8);
  assert.deepEqual([...up.data.subarray(0, 4)], [255, 0, 0, 255], 'corner keeps its colour');
  assert.deepEqual([...up.data.subarray(7 * 4, 8 * 4)], [0, 0, 255, 255]);
  assert.equal(squareAt(halves(100, 40), 512).width, 512);
  assert.equal(squareAt(halves(1000, 1000), 512).width, 512);
});

test('transparent pixels are flattened onto white', () => {
  const img = flattenOnWhite(halves(2, 1, 0));
  assert.deepEqual([...img.data], [255, 255, 255, 255, 255, 255, 255, 255]);
  const half = flattenOnWhite({ width: 1, height: 1, data: Buffer.from([0, 0, 0, 128]) });
  assert.deepEqual([...half.data], [127, 127, 127, 255]);
});
