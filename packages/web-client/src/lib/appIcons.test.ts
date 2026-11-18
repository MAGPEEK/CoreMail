/**
 * 9.4 build-time app icons (scripts/app-icons.mjs): sizes, PNG structure and
 * the logo geometry (transparent corners for "any", full bleed for "maskable").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
// @ts-expect-error — plain build script without type declarations
import { ICON_FILES, encodePng, renderLogo } from '../../scripts/app-icons.mjs';

type Render = (size: number, maskable: boolean) => Buffer;
const render = renderLogo as Render;
const encode = encodePng as (w: number, h: number, rgba: Buffer) => Buffer;

const pixel = (rgba: Buffer, size: number, x: number, y: number) => [...rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

test('icon set: 192 and 512, each as "any" and "maskable"', () => {
  assert.deepEqual(Object.entries(ICON_FILES as Record<string, { size: number; maskable: boolean }>).map(([n, v]) => [n, v.size, v.maskable]), [
    ['app-192.png', 192, false], ['app-512.png', 512, false],
    ['app-maskable-192.png', 192, true], ['app-maskable-512.png', 512, true],
  ]);
});

test('"any" icon: transparent rounded corners, blue tile, white envelope', () => {
  const rgba = render(192, false);
  assert.equal(pixel(rgba, 192, 0, 0)[3], 0, 'corner outside the rounded square');
  assert.deepEqual(pixel(rgba, 192, 96, 20), [0x00, 0x78, 0xd4, 255]);
  assert.deepEqual(pixel(rgba, 192, 96, 130), [255, 255, 255, 255], 'lower half of the envelope');
});

test('"maskable" icon: opaque edge to edge, envelope inside the safe zone', () => {
  const rgba = render(192, true);
  assert.deepEqual(pixel(rgba, 192, 0, 0), [0x00, 0x78, 0xd4, 255]);
  // safe zone: circle of radius 0.4 × size around the centre — nothing white outside
  for (let y = 0; y < 192; y += 3) for (let x = 0; x < 192; x += 3) {
    const outside = Math.hypot(x + 0.5 - 96, y + 0.5 - 96) > 0.4 * 192;
    if (outside) assert.notDeepEqual(pixel(rgba, 192, x, y), [255, 255, 255, 255], `(${x},${y})`);
  }
});

test('encodePng: valid signature, IHDR and pixel data that inflates back', () => {
  const rgba = render(32, false);
  const png = encode(32, 32, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.toString('latin1', 37, 41), 'IDAT');
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, (32 * 4 + 1) * 32);
  assert.deepEqual([...raw.subarray(1, 1 + 32 * 4)], [...rgba.subarray(0, 32 * 4)]);
});
