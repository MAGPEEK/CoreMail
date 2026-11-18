#!/usr/bin/env node
/**
 * 9.4: PNG app icons of the installable webmail, rendered at build time from
 * the default logo (public/favicon.svg: blue rounded square, white envelope
 * with a blue flap line). No dependencies — the logo is drawn from its shapes
 * with 4×4 supersampling and written with node:zlib.
 *
 *   node scripts/app-icons.mjs <outDir>
 *     → app-192.png, app-512.png            (purpose "any": the logo as is)
 *       app-maskable-192.png, -512.png      (purpose "maskable": full-bleed
 *                                            background, envelope inside the
 *                                            central safe zone)
 *
 * The gateway manifest (api-gateway lib/branding/manifest.ts) lists these
 * files under /icons/ unless a custom branding favicon replaces them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const ICON_FILES = {
  'app-192.png': { size: 192, maskable: false },
  'app-512.png': { size: 512, maskable: false },
  'app-maskable-192.png': { size: 192, maskable: true },
  'app-maskable-512.png': { size: 512, maskable: true },
};

const BLUE = [0x00, 0x78, 0xd4];
const WHITE = [0xff, 0xff, 0xff];
/** Flap line of the envelope (favicon.svg path, second sub-path), 32×32 units. */
const FLAP = [[24, 12], [16, 17], [8, 12], [8, 10], [16, 15], [24, 10]];
/** Envelope 0.8× in the maskable variant: its corners stay inside the 40 % safe-zone radius. */
const MASKABLE_SCALE = 0.8;

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Colour of the logo at (x, y) in 32×32 units, or null outside it. */
function logoAt(x, y, maskable) {
  if (!maskable && !inRoundRect(x, y, 0, 0, 32, 32, 6)) return null;
  const ex = maskable ? 16 + (x - 16) / MASKABLE_SCALE : x;
  const ey = maskable ? 16 + (y - 16) / MASKABLE_SCALE : y;
  return inRoundRect(ex, ey, 6, 8, 26, 24, 2) && !inPolygon(ex, ey, FLAP) ? WHITE : BLUE;
}

/** RGBA pixels (size × size) of the default logo. */
export function renderLogo(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let py = 0; py < size; py++) {
    for (let pxX = 0; pxX < size; pxX++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = logoAt(((pxX + (sx + 0.5) / n) * 32) / size, ((py + (sy + 0.5) / n) * 32) / size, maskable);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const o = (py * size + pxX) * 4;
      if (a > 0) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
      px[o + 3] = Math.round((a / (n * n)) * 255);
    }
  }
  return px;
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

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 8-bit RGBA PNG (filter 0 on every row). */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Writes every icon into `outDir`; returns the file names. */
export function writeIcons(outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const [name, { size, maskable }] of Object.entries(ICON_FILES)) {
    writeFileSync(join(outDir, name), encodePng(size, size, renderLogo(size, maskable)));
  }
  return Object.keys(ICON_FILES);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = process.argv[2];
  if (!outDir) { console.error('usage: node scripts/app-icons.mjs <outDir>'); process.exit(2); }
  console.log(`app icons: ${writeIcons(outDir).join(', ')} → ${outDir}`);
}
