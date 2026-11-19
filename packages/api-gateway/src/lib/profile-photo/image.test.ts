/**
 * 9.5 profile photo processing: magic bytes, size / pixel limits checked before
 * decoding, re-encoding to a 512×512 JPEG without metadata, crop and scale math;
 * review 9.5: JPEG scan / frame / segment limits (CPU bomb), memory cap, fuzzing.
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
import { readJpegStructure, MAX_JPEG_SCANS } from './jpeg-structure.js';

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

// ── Hostile input: CPU bombs, odd frames, fuzzing ────────────────────────────

/** A baseline JPEG split into the part before its scan, the scan (SOS + data) and the EOI. */
function jpegParts(w: number, h: number): { head: Buffer; scan: Buffer; eoi: Buffer } {
  const buf = Buffer.from(jpeg.encode({ width: w, height: h, data: halves(w, h).data }, 80).data);
  const sos = buf.indexOf(Buffer.from([0xff, 0xda]));
  const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
  return { head: buf.subarray(0, sos), scan: buf.subarray(sos, eoi), eoi: buf.subarray(eoi) };
}

test('JPEG structure walk: frame size, scan and segment counts of an encoded image', () => {
  const { head, scan, eoi } = jpegParts(96, 64);
  const s = readJpegStructure(Buffer.concat([head, scan, eoi]));
  assert.ok(s);
  assert.deepEqual([s.frames, s.decodable, s.width, s.height, s.scans], [1, true, 96, 64, 1]);
  assert.equal(readJpegStructure(Buffer.from('not a jpeg')), null);
  assert.equal(readJpegStructure(head.subarray(0, head.length - 3)), null, 'segment cut short');
});

test('CPU bomb: a JPEG with more than MAX_JPEG_SCANS scans is refused before decoding, in linear time', () => {
  const { head, scan, eoi } = jpegParts(64, 64);
  const atLimit = Buffer.concat([head, ...Array.from({ length: MAX_JPEG_SCANS }, () => scan), eoi]);
  assert.ok(processProfilePhoto(atLimit).length > 0, 'up to the limit the image decodes');
  const over = Buffer.concat([head, ...Array.from({ length: MAX_JPEG_SCANS + 1 }, () => scan), eoi]);
  assert.equal(codeOf(() => processProfilePhoto(over)), 'UNSUPPORTED');
  // ~5 MB of repeated scans: jpeg-js would walk every block once per scan
  const copies = Math.floor((MAX_PHOTO_BYTES - head.length - eoi.length) / scan.length);
  const bomb = Buffer.concat([head, ...Array.from({ length: copies }, () => scan), eoi]);
  const t0 = performance.now();
  assert.equal(codeOf(() => processProfilePhoto(bomb)), 'UNSUPPORTED');
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `refused in ${Math.round(ms)} ms`);
});

/** Marker segment FFxx with its length. */
function segment(marker: number, body: Buffer): Buffer {
  const h = Buffer.from([0xff, marker, 0, 0]);
  h.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([h, body]);
}

/**
 * Progressive 2048×2048 JPEG of `scans` AC scans of 16 bytes each: three
 * end-of-band runs cover all 65 536 blocks, so every scan makes jpeg-js walk the
 * whole frame (measured: 2 000 scans = 38 KB ≈ 0.5 s; 5 MB ≈ 70 s of blocked event loop).
 */
function progressiveScanBomb(scans: number): Buffer {
  const sof = Buffer.from([8, 0x08, 0x00, 0x08, 0x00, 1, 1, 0x11, 0]);
  const lengths = Buffer.alloc(16);
  lengths[0] = 1; // one AC code "0" → symbol 0xE0 (EOBRUN, 14 extra bits)
  const dht = segment(0xc4, Buffer.concat([Buffer.from([0x10]), lengths, Buffer.from([0xe0])]));
  const bits = ('0' + '1'.repeat(14)).repeat(3).padEnd(48, '1');
  const data = Buffer.from(bits.match(/.{8}/g)!.flatMap((b) => (b === '11111111' ? [0xff, 0x00] : [parseInt(b, 2)])));
  const scan = Buffer.concat([segment(0xda, Buffer.from([1, 1, 0x00, 1, 63, 0])), data]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])), segment(0xc2, sof), dht,
    ...Array.from({ length: scans }, () => scan), Buffer.from([0xff, 0xd9]),
  ]);
}

test('CPU bomb: progressive JPEG of thousands of end-of-band scans is refused from the marker walk', () => {
  const bomb = progressiveScanBomb(2000);
  assert.equal(readJpegStructure(bomb)?.scans, 2000);
  const t0 = performance.now();
  assert.equal(codeOf(() => processProfilePhoto(bomb)), 'UNSUPPORTED');
  assert.ok(performance.now() - t0 < 400, 'refused without decoding (decoding takes ~0.5 s)');
});

test('JPEG frames: a second frame header, a frame type jpeg-js cannot decode or too many segments are UNSUPPORTED', () => {
  const { head, scan, eoi } = jpegParts(64, 64);
  const sofAt = head.indexOf(Buffer.from([0xff, 0xc0]));
  const sof = head.subarray(sofAt, sofAt + 2 + head.readUInt16BE(sofAt + 2));
  assert.equal(codeOf(() => processProfilePhoto(Buffer.concat([head, sof, scan, eoi]))), 'UNSUPPORTED');
  const lossless = Buffer.concat([head, scan, eoi]);
  lossless[sofAt + 1] = 0xc3;
  assert.equal(codeOf(() => processProfilePhoto(lossless)), 'UNSUPPORTED');
  const comments = Array.from({ length: 600 }, () => Buffer.from([0xff, 0xfe, 0, 2]));
  const many = Buffer.concat([head.subarray(0, 2), ...comments, head.subarray(2), scan, eoi]);
  assert.equal(codeOf(() => processProfilePhoto(many)), 'UNSUPPORTED');
});

test('memory cap: the largest accepted JPEG (MAX_PHOTO_PIXELS) still decodes', () => {
  const side = Math.sqrt(MAX_PHOTO_PIXELS);
  const big = Buffer.from(jpeg.encode({ width: side, height: side, data: Buffer.alloc(side * side * 4, 200) }, 50).data);
  assert.equal(jpeg.decode(processProfilePhoto(big)).width, PHOTO_SIZE);
});

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fuzz: random, truncated and bit-flipped uploads only ever yield a 512×512 JPEG or a PhotoError', () => {
  const rand = rng(0x5eed);
  const int = (n: number) => Math.floor(rand() * n);
  const bytes = (n: number) => Buffer.from(Array.from({ length: n }, () => int(256)));
  const validPng = encodePng(halves(80, 72));
  const validJpeg = Buffer.from(jpeg.encode({ width: 80, height: 72, data: halves(80, 72).data }, 85).data);
  const inputs: Buffer[] = [];
  for (let i = 0; i < 80; i++) inputs.push(Buffer.concat([validPng.subarray(0, 8), bytes(int(400))]));
  for (let i = 0; i < 80; i++) inputs.push(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), bytes(int(400))]));
  for (let i = 0; i < 60; i++) inputs.push(validPng.subarray(0, int(validPng.length)));
  for (let i = 0; i < 60; i++) inputs.push(validJpeg.subarray(0, int(validJpeg.length)));
  for (const valid of [validPng, validJpeg]) {
    for (let i = 0; i < 80; i++) {
      const b = Buffer.from(valid);
      for (let k = 1 + int(8); k > 0; k--) b[int(b.length)] = int(256);
      inputs.push(b);
    }
  }
  let accepted = 0;
  for (const [n, input] of inputs.entries()) {
    try {
      const img = jpeg.decode(processProfilePhoto(input));
      assert.deepEqual([img.width, img.height], [PHOTO_SIZE, PHOTO_SIZE], `input ${n}`);
      accepted++;
    } catch (err) {
      assert.ok(err instanceof PhotoError, `input ${n}: ${(err as Error).stack}`);
    }
  }
  assert.ok(inputs.length >= 400);
  assert.ok(accepted > 0, 'some bit flips still decode');
});
