#!/usr/bin/env node
/**
 * 10.1: the built-in webmail backgrounds — CoreMail's own layered SVG drawings
 * (no photos, no third-party assets), one light and one dark variant each:
 * Bergsee bei Nacht (lake), Morgendämmerung (dawn), Wald (forest), Küste (coast),
 * Dünen (dunes), Wellen (waves), Polarlicht (aurora), Neutral (neutral).
 *
 *   node scripts/backgrounds.mjs [outDir]   (default: public/backgrounds)
 *
 * The output is checked in (served as static files, also by the admin panel's
 * picker at /backgrounds/…); run this again after changing a drawing. Shapes
 * come from a seeded noise function, so the output is deterministic. Calm and
 * low-contrast on purpose: the panes on top stay legible (lib/paneSurface.test.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const W = 1600;
const H = 1000;

/** Small deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 1-D value noise in [-1, 1] (cosine-interpolated random knots). */
function noise1d(seed, knots = 12) {
  const r = rng(seed);
  const values = Array.from({ length: knots + 2 }, () => r() * 2 - 1);
  return (x) => {
    const p = x * knots;
    const i = Math.floor(p);
    const f = (1 - Math.cos((p - i) * Math.PI)) / 2;
    return values[i] * (1 - f) + values[i + 1] * f;
  };
}

const n1 = (v) => Math.round(v * 10) / 10;

/** Closed path of a ridge line y = base + amp·noise(x) down to the bottom edge. */
function ridge({ seed, base, amp, knots = 10, octave = 0, step = 20, bottom = H }) {
  const a = noise1d(seed, knots);
  const b = noise1d(seed + 99, knots * 3);
  const pts = [];
  for (let x = 0; x <= W; x += step) {
    const t = x / W;
    pts.push([x, base + amp * (a(t) + octave * b(t))]);
  }
  return `M0 ${bottom} L${pts.map(([x, y]) => `${x} ${n1(y)}`).join(' L')} L${W} ${bottom} Z`;
}

/** Ridge mirrored at the water line (lake reflection). */
function reflection({ seed, base, amp, knots = 10, octave = 0, step = 20, water }) {
  const a = noise1d(seed, knots);
  const b = noise1d(seed + 99, knots * 3);
  const pts = [];
  for (let x = 0; x <= W; x += step) {
    const t = x / W;
    const y = base + amp * (a(t) + octave * b(t));
    pts.push([x, water + (water - y) * 0.55]);
  }
  return `M0 ${water} L${pts.map(([x, y]) => `${x} ${n1(y)}`).join(' L')} L${W} ${water} Z`;
}

/** Soft band (wave / aurora): area between two noisy lines. */
function band({ seed, top, thickness, amp, knots = 6, step = 25 }) {
  const a = noise1d(seed, knots);
  const b = noise1d(seed + 7, knots);
  const upper = [];
  const lower = [];
  for (let x = 0; x <= W; x += step) {
    const t = x / W;
    const y = top + amp * a(t);
    upper.push(`${x} ${n1(y)}`);
    lower.unshift(`${x} ${n1(y + thickness * (0.6 + 0.4 * (b(t) + 1) / 2))}`);
  }
  return `M${upper.join(' L')} L${lower.join(' L')} Z`;
}

/** Tree silhouettes standing on a ridge (forest). */
function trees({ seed, base, amp, count, minH, maxH }) {
  const r = rng(seed);
  const a = noise1d(seed, 8);
  let d = '';
  for (let i = 0; i < count; i++) {
    const x = (i + r() * 0.8) * (W / count);
    const y = base + amp * a(x / W);
    const h = minH + r() * (maxH - minH);
    const w = h * (0.28 + r() * 0.08);
    d += `M${n1(x - w / 2)} ${n1(y)} L${n1(x)} ${n1(y - h)} L${n1(x + w / 2)} ${n1(y)} Z `;
  }
  return d.trim();
}

function stars(seed, count, maxY, color) {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < count; i++) {
    out += `<circle cx="${n1(r() * W)}" cy="${n1(r() * maxY)}" r="${n1(0.6 + r() * 1.4)}" fill="${color}" opacity="${n1(0.3 + r() * 0.6)}"/>`;
  }
  return out;
}

const linear = (id, stops, x2 = 0, y2 = 1) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map(([o, c, op = 1]) => `<stop offset="${o}" stop-color="${c}"${op === 1 ? '' : ` stop-opacity="${op}"`}/>`).join('')}</linearGradient>`;
const radial = (id, cx, cy, rr, stops) =>
  `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${rr}">${stops.map(([o, c, op = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${op}"/>`).join('')}</radialGradient>`;
const path = (d, fill, opacity = 1) => `<path d="${d}" fill="${fill}"${opacity === 1 ? '' : ` opacity="${opacity}"`}/>`;
const svg = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"><defs>${defs}</defs>${body}</svg>\n`;

// ── Scenes (palette per theme) ────────────────────────────────────────────────

function lake(dark) {
  const p = dark
    ? { sky: ['#0b1730', '#1b2f57', '#2e4a78'], m: ['#24395f', '#1a2b4a', '#111e36'], water: ['#16284a', '#0b1630'], star: '#dfe8ff', moon: '#e8eefc' }
    : { sky: ['#3d5c8f', '#6f8fbf', '#a9bedb'], m: ['#5d7aa6', '#46628f', '#334d78'], water: ['#4d6a98', '#2f4a76'], star: '#f4f7ff', moon: '#fbfcff' };
  const water = 680;
  const layers = [
    { seed: 11, base: 470, amp: 90, knots: 7, octave: 0.25 },
    { seed: 23, base: 545, amp: 70, knots: 9, octave: 0.3 },
    { seed: 37, base: 610, amp: 40, knots: 12, octave: 0.35 },
  ];
  return svg(
    linear('sky', [[0, p.sky[0]], [0.6, p.sky[1]], [1, p.sky[2]]]) + linear('wat', [[0, p.water[0]], [1, p.water[1]]])
      + radial('glow', 0.72, 0.2, 0.25, [[0, p.moon, 0.35], [1, p.moon, 0]]),
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>${stars(5, 70, 380, p.star)}<rect width="${W}" height="${H}" fill="url(#glow)"/>`
      + `<circle cx="1150" cy="200" r="38" fill="${p.moon}" opacity="0.85"/>`
      + layers.map((l, i) => path(ridge(l), p.m[i])).join('')
      + `<rect y="${water}" width="${W}" height="${H - water}" fill="url(#wat)"/>`
      + layers.map((l, i) => path(reflection({ ...l, water }), p.m[i], 0.35)).join('')
      + path(band({ seed: 3, top: 760, thickness: 3, amp: 6 }), p.moon, 0.18)
      + path(band({ seed: 4, top: 820, thickness: 2, amp: 8 }), p.moon, 0.12),
  );
}

function dawn(dark) {
  const p = dark
    ? { sky: ['#2a1e3a', '#5a3550', '#9a5a55'], sun: '#f2b27a', h: ['#5b3a4c', '#47303f', '#352433', '#271a26'] }
    : { sky: ['#f7d9c4', '#f6c3a4', '#f3ad8e'], sun: '#fff1d6', h: ['#e9b296', '#d99a82', '#c4826f', '#a96d60'] };
  return svg(
    linear('sky', [[0, p.sky[0]], [0.55, p.sky[1]], [1, p.sky[2]]]) + radial('sun', 0.5, 0.55, 0.35, [[0, p.sun, 0.9], [0.35, p.sun, 0.35], [1, p.sun, 0]]),
    `<rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${H}" fill="url(#sun)"/>`
      + `<circle cx="800" cy="560" r="70" fill="${p.sun}" opacity="0.8"/>`
      + [560, 640, 730, 830].map((base, i) => path(ridge({ seed: 50 + i * 7, base, amp: 45 - i * 6, knots: 4 + i, octave: 0.15 }), p.h[i])).join(''),
  );
}

function forest(dark) {
  const p = dark
    ? { sky: ['#0f1f1a', '#1d3a2f', '#2c5040'], mist: '#3e6555', t: ['#21402f', '#183326', '#10261c', '#0a1a13'] }
    : { sky: ['#dbe9dc', '#bfd8c2', '#a6c7a9'], mist: '#eef5ee', t: ['#8fb596', '#6f9a78', '#52805d', '#3a6545'] };
  const rows = [
    { seed: 70, base: 520, amp: 30, count: 46, minH: 60, maxH: 110 },
    { seed: 71, base: 610, amp: 30, count: 38, minH: 90, maxH: 150 },
    { seed: 72, base: 720, amp: 26, count: 30, minH: 130, maxH: 210 },
    { seed: 73, base: 860, amp: 22, count: 22, minH: 190, maxH: 300 },
  ];
  return svg(
    linear('sky', [[0, p.sky[0]], [0.7, p.sky[1]], [1, p.sky[2]]]) + linear('mist', [[0, p.mist, 0], [1, p.mist, 0.55]]),
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>`
      + rows.map((r, i) => path(`${trees(r)} ${ridge({ seed: r.seed, base: r.base, amp: r.amp, knots: 8 })}`, p.t[i])
        + (i < 3 ? `<rect y="${r.base - 120}" width="${W}" height="160" fill="url(#mist)" opacity="0.5"/>` : '')).join(''),
  );
}

function coast(dark) {
  const p = dark
    ? { sky: ['#101b2c', '#22344d', '#3b506a'], sea: ['#1a3045', '#0f2133'], cliff: ['#273447', '#1b2533'], foam: '#9fb7cf' }
    : { sky: ['#cfe3f2', '#e3eef7', '#f4f1ea'], sea: ['#7fa9c6', '#5d8db0'], cliff: ['#a7b3a3', '#8c9a89'], foam: '#ffffff' };
  const horizon = 560;
  return svg(
    linear('sky', [[0, p.sky[0]], [0.75, p.sky[1]], [1, p.sky[2]]]) + linear('sea', [[0, p.sea[0]], [1, p.sea[1]]]),
    `<rect width="${W}" height="${horizon}" fill="url(#sky)"/><rect y="${horizon}" width="${W}" height="${H - horizon}" fill="url(#sea)"/>`
      + [600, 650, 715, 790, 880].map((top, i) => path(band({ seed: 90 + i, top, thickness: 2 + i, amp: 6 + i * 2 }), p.foam, 0.12 + i * 0.03)).join('')
      + path('M1060 1000 L1110 640 C1160 560 1230 520 1320 500 C1420 480 1520 470 1600 455 L1600 1000 Z', p.cliff[0])
      + path('M1240 1000 L1270 760 C1320 700 1420 660 1600 640 L1600 1000 Z', p.cliff[1]),
  );
}

function dunes(dark) {
  const p = dark
    ? { sky: ['#1f1a2a', '#3b2f3a', '#5b4840'], d: ['#5c4636', '#4a382c', '#3a2c23', '#2b2019'] }
    : { sky: ['#f6ead6', '#f3dfc0', '#efd2a9'], d: ['#e8c99d', '#ddb886', '#cfa572', '#bd9161'] };
  return svg(
    linear('sky', [[0, p.sky[0]], [0.6, p.sky[1]], [1, p.sky[2]]]),
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>`
      + [520, 610, 720, 840].map((base, i) => path(ridge({ seed: 120 + i * 3, base, amp: 70 - i * 8, knots: 3 + (i % 2), octave: 0.08 }), p.d[i])).join(''),
  );
}

function waves(dark) {
  const p = dark
    ? { bg: ['#121a2b', '#1a2740'], w: ['#22365a', '#2a4370', '#335083', '#3b5d96'] }
    : { bg: ['#eef3fb', '#dfe8f6'], w: ['#cfdcf1', '#bccfeb', '#a9c1e4', '#97b3dd'] };
  return svg(
    linear('bg', [[0, p.bg[0]], [1, p.bg[1]]], 1, 1),
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>`
      + [380, 520, 660, 800].map((base, i) => path(ridge({ seed: 150 + i, base, amp: 80, knots: 3, octave: 0.05, step: 25 }), p.w[i], 0.85)).join(''),
  );
}

function aurora(dark) {
  const p = dark
    ? { sky: ['#06121c', '#0c2230', '#123140'], a: ['#3ddc97', '#4ac8d8', '#8b7cf0'], m: ['#0d1e27', '#081419'], star: '#e4f6ff' }
    : { sky: ['#1d3550', '#2c4d6b', '#4a6f8c'], a: ['#7ff0c0', '#86e2ef', '#b6a9ff'], m: ['#26425a', '#1a3046'], star: '#f4fbff' };
  const bands = [
    { seed: 200, top: 180, thickness: 120, amp: 70, knots: 4 },
    { seed: 201, top: 260, thickness: 90, amp: 90, knots: 5 },
    { seed: 202, top: 140, thickness: 70, amp: 60, knots: 3 },
  ];
  return svg(
    linear('sky', [[0, p.sky[0]], [0.7, p.sky[1]], [1, p.sky[2]]])
      + p.a.map((c, i) => linear(`a${i}`, [[0, c, 0], [0.5, c, 0.45], [1, c, 0]])).join('')
      + '<filter id="soft" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="18"/></filter>',
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>${stars(8, 80, 600, p.star)}`
      + `<g filter="url(#soft)">${bands.map((b, i) => path(band(b), `url(#a${i})`)).join('')}</g>`
      + path(ridge({ seed: 210, base: 760, amp: 70, knots: 6, octave: 0.3 }), p.m[0])
      + path(ridge({ seed: 211, base: 850, amp: 40, knots: 9, octave: 0.3 }), p.m[1]),
  );
}

function neutral(dark) {
  const p = dark
    ? { bg: ['#16191f', '#1d222b', '#232a35'], blob: ['#2a3442', '#26303c'] }
    : { bg: ['#f3f4f6', '#eceef2', '#e4e8ee'], blob: ['#ffffff', '#dfe5ee'] };
  return svg(
    linear('bg', [[0, p.bg[0]], [0.5, p.bg[1]], [1, p.bg[2]]], 1, 1)
      + radial('b0', 0.2, 0.25, 0.5, [[0, p.blob[0], 0.7], [1, p.blob[0], 0]])
      + radial('b1', 0.85, 0.8, 0.55, [[0, p.blob[1], 0.8], [1, p.blob[1], 0]]),
    `<rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#b0)"/><rect width="${W}" height="${H}" fill="url(#b1)"/>`,
  );
}

export const SCENES = { lake, dawn, forest, coast, dunes, waves, aurora, neutral };

export function writeBackgrounds(outDir) {
  mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const [id, draw] of Object.entries(SCENES)) {
    for (const variant of ['light', 'dark']) {
      const file = join(outDir, `${id}-${variant}.svg`);
      writeFileSync(file, draw(variant === 'dark'));
      files.push(file);
    }
  }
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = process.argv[2] ?? join(here, '..', 'public', 'backgrounds');
  for (const f of writeBackgrounds(out)) console.log(f);
}
