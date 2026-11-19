/**
 * 9.4 app icons from a custom favicon: the pure PNG codec (every 8-bit colour
 * type and row filter), the area-average scaling, and which favicons replace
 * the default icons. Object store faked via globalThis.__objectStore.
 * Run: node --import tsx --test src/lib/branding/app-icons.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { decodePng, encodePng, resizeRgba, readPngHeader, PngUnsupportedError } = await import('./png.js');
const { appIconSha, renderAppIcon, scalableFavicon } = await import('./app-icons.js');
const { brandingAssetCache } = await import('./asset-cache.js');

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Hand-built PNG: raw samples, the given colour type, row filters cycling 0..4. */
function makePng(width: number, height: number, colorType: number, samples: number[], extra: Array<[string, Buffer]> = []): Buffer {
  const bpp = CHANNELS[colorType]!;
  const stride = width * bpp;
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    rows.push(filter);
    for (let i = 0; i < stride; i++) {
      const x = samples[y * stride + i]!;
      const a = i >= bpp ? samples[y * stride + i - bpp]! : 0;
      const b = y > 0 ? samples[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= bpp ? samples[(y - 1) * stride + i - bpp]! : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!;
      rows.push((x - pred) & 0xff);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]); // the decoder does not check CRCs
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), ...extra.map(([t, d]) => chunk(t, d)),
    chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const px = (img: { width: number; data: Buffer }, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test('decodePng: grey, RGB, palette with transparency, grey+alpha and RGBA through every row filter', () => {
  const grey = decodePng(makePng(3, 5, 0, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 255]));
  assert.deepEqual(px(grey, 2, 4), [255, 255, 255, 255]);
  assert.deepEqual(px(grey, 1, 2), [70, 70, 70, 255]);

  const rgbSamples = Array.from({ length: 4 * 5 * 3 }, (_, i) => (i * 37) % 256);
  const rgb = decodePng(makePng(4, 5, 2, rgbSamples));
  for (let i = 0; i < 20; i++) assert.deepEqual(px(rgb, i % 4, Math.floor(i / 4)), [...rgbSamples.slice(i * 3, i * 3 + 3), 255]);

  const palette = decodePng(makePng(2, 5, 3, [0, 1, 1, 0, 0, 1, 1, 1, 0, 0], [
    ['PLTE', Buffer.from([255, 0, 0, 0, 0, 255])], ['tRNS', Buffer.from([128])],
  ]));
  assert.deepEqual(px(palette, 0, 0), [255, 0, 0, 128]);
  assert.deepEqual(px(palette, 1, 0), [0, 0, 255, 255], 'no tRNS entry → opaque');

  const ga = decodePng(makePng(1, 5, 4, [10, 0, 20, 50, 30, 100, 40, 150, 50, 255]));
  assert.deepEqual(px(ga, 0, 4), [50, 50, 50, 255]);

  const rgbaSamples = Array.from({ length: 3 * 5 * 4 }, (_, i) => (i * 53 + 7) % 256);
  const rgba = decodePng(makePng(3, 5, 6, rgbaSamples));
  assert.deepEqual([...rgba.data], rgbaSamples);
});

test('decodePng: 16-bit, interlaced, foreign and corrupt data are refused', () => {
  const png16 = makePng(1, 1, 0, [0]);
  png16[24] = 16;
  assert.throws(() => decodePng(png16), PngUnsupportedError);
  const interlaced = makePng(1, 1, 0, [0]);
  interlaced[28] = 1;
  assert.throws(() => decodePng(interlaced), PngUnsupportedError);
  assert.throws(() => decodePng(Buffer.from('RIFF....WEBPVP8 ')), PngUnsupportedError);
  const corrupt = makePng(2, 2, 6, Array(16).fill(1));
  corrupt.fill(7, 50, 60);
  assert.throws(() => decodePng(corrupt), PngUnsupportedError);
});

test('encodePng → decodePng round trip; resize averages areas with premultiplied alpha', () => {
  const data = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data.set(i % 2 ? [255, 255, 255, 255] : [255, 0, 0, 0], i * 4);
  const img = { width: 4, height: 4, data };
  assert.deepEqual([...decodePng(encodePng(img)).data], [...data]);
  const half = resizeRgba(img, 2);
  // half of every 2×2 block is transparent red: the colour stays white, alpha halves
  assert.deepEqual(px(half, 0, 0), [255, 255, 255, 128]);
  assert.throws(() => resizeRgba(img, 8), RangeError);
});

const sha = 'b'.repeat(64);
const branding = (favicon: string | null) => ({
  version: 1, productName: 'Example', primaryColor: null, headerColor: null, allowUserAccent: true, showPoweredBy: true, defaultBackground: 'none' as const,
  loginText: '', footerLinks: [], assets: { logoLight: null, logoDark: null, favicon, loginBackground: null },
});

function solid(size: number): Buffer {
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([10, 120, 200, 255], i * 4);
  return encodePng({ width: size, height: size, data });
}

function installStore(objects: Record<string, Buffer>): { reads: string[] } {
  const reads: string[] = [];
  (globalThis as unknown as { __objectStore: unknown }).__objectStore = {
    get: async (key: string) => {
      reads.push(key);
      const o = objects[key];
      if (!o) throw Object.assign(new Error('not found'), { name: 'ObjectNotFoundError', code: 'NotFound' });
      return o;
    },
  };
  brandingAssetCache.clear();
  return { reads };
}

test('a square PNG favicon of at least 512 px becomes the app icons; others keep the defaults', async () => {
  installStore({
    [`branding/${sha}.png`]: solid(512),
    [`branding/${'c'.repeat(64)}.png`]: solid(256),
  });
  assert.equal(await appIconSha(branding(`/branding/assets/${sha}.png`)), sha);
  assert.equal(await appIconSha(branding(`/branding/assets/${'c'.repeat(64)}.png`)), null, 'too small');
  assert.equal(await appIconSha(branding(`/branding/assets/${'d'.repeat(64)}.webp`)), null, 'WebP is not scaled');
  assert.equal(await appIconSha(branding(`/branding/assets/${'e'.repeat(64)}.png`)), null, 'missing object');
  assert.equal(await appIconSha(branding(null)), null);
  assert.equal(scalableFavicon(solid(600).subarray(0, 60)), false, 'truncated: the header alone is not enough');
  assert.equal(readPngHeader(solid(512))!.width, 512);
});

test('renderAppIcon: scales the current favicon once, refuses other hashes', async () => {
  const store = installStore({ [`branding/${sha}.png`]: solid(512) });
  const b = branding(`/branding/assets/${sha}.png`);
  const [a, c] = await Promise.all([renderAppIcon(`${sha}-192.png`, b), renderAppIcon(`${sha}-192.png`, b)]);
  assert.ok(a && c);
  const icon = decodePng(a);
  assert.equal(icon.width, 192);
  assert.deepEqual(px(icon, 100, 100), [10, 120, 200, 255]);
  assert.equal(store.reads.length, 1, 'one read for concurrent requests');
  assert.equal(await renderAppIcon(`${sha}-192.png`, b), a, 'cached');
  assert.equal(await renderAppIcon(`${'f'.repeat(64)}-192.png`, b), null, 'not the current favicon');
  assert.equal(await renderAppIcon(`${sha}-300.png`, b), null, 'no such size');
  assert.equal(await renderAppIcon(`${sha}-512.png`, branding(null)), null);
});
