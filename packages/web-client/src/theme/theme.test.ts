/**
 * WCAG 2.2 AA contrast guarantees of the semantic colour tokens (tokens.css),
 * for light AND dark mode. KEEP IDENTICAL in web-client and admin-panel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { contrastRatio, parseRgbChannels, accentFgChannels, LIGHT_BACKGROUNDS, DARK_BACKGROUNDS, type Rgb } from './contrast.ts';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'tokens.css'), 'utf8');

function block(selector: string): Record<string, Rgb> {
  const start = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`));
  assert.ok(start >= 0, `selector ${selector} missing in tokens.css`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, Rgb> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([\d\s]+);/g)) out[m[1]!] = parseRgbChannels(m[2]!);
  return out;
}

const light = block(':root');
const dark = { ...light, ...block(':root.dark') };
const SURFACES = ['canvas', 'surface', 'surface-2', 'surface-3'];
const TEXT = ['fg', 'fg-muted', 'fg-subtle', 'color-accent-fg', 'danger-fg', 'success-fg', 'warning-fg', 'info-fg'];
const STATUS = ['danger', 'success', 'warning', 'info'];
const WHITE: Rgb = [255, 255, 255];

for (const [mode, t] of [['light', light], ['dark', dark]] as const) {
  test(`${mode}: every text token reaches 4.5:1 on every surface (SC 1.4.3)`, () => {
    for (const fg of TEXT) for (const bg of SURFACES) {
      const r = contrastRatio(t[fg]!, t[bg]!);
      assert.ok(r >= 4.5, `${mode} ${fg} on ${bg}: ${r.toFixed(2)}`);
    }
  });
  test(`${mode}: status tints keep their text legible`, () => {
    for (const s of STATUS) for (const fg of [`${s}-fg`, 'fg', 'fg-muted']) {
      const r = contrastRatio(t[fg]!, t[`${s}-bg`]!);
      assert.ok(r >= 4.5, `${mode} ${fg} on ${s}-bg: ${r.toFixed(2)}`);
    }
  });
  test(`${mode}: white text on solid status colours >= 4.5:1`, () => {
    for (const s of STATUS) {
      const r = contrastRatio(WHITE, t[s]!);
      assert.ok(r >= 4.5, `${mode} white on ${s}: ${r.toFixed(2)}`);
    }
  });
  test(`${mode}: line-strong reaches 3:1 on every surface (SC 1.4.11)`, () => {
    for (const bg of SURFACES) {
      const r = contrastRatio(t['line-strong']!, t[bg]!);
      assert.ok(r >= 3, `${mode} line-strong on ${bg}: ${r.toFixed(2)}`);
    }
  });
}

test('contrast.ts background lists match tokens.css', () => {
  assert.deepEqual(LIGHT_BACKGROUNDS, SURFACES.map((s) => light[s]));
  assert.deepEqual(DARK_BACKGROUNDS, SURFACES.map((s) => dark[s]));
});

test('accent presets: white on accent >= 4.5:1, derived accent-fg >= 4.5:1 in both themes', () => {
  const presets = ['0 120 212', '98 100 167', '16 124 16', '216 59 1', '0 133 117', '180 0 158'];
  for (const p of presets) {
    assert.ok(contrastRatio(WHITE, parseRgbChannels(p)) >= 4.5, `white on ${p}`);
    for (const isDark of [false, true]) {
      const fg = parseRgbChannels(accentFgChannels(p, isDark));
      for (const bg of isDark ? DARK_BACKGROUNDS : LIGHT_BACKGROUNDS) {
        assert.ok(contrastRatio(fg, bg) >= 4.5, `accent-fg ${p} dark=${isDark}`);
      }
    }
  }
  // an arbitrary, very light accent still yields a legible foreground
  const fg = parseRgbChannels(accentFgChannels('250 250 120', false));
  assert.ok(contrastRatio(fg, [255, 255, 255]) >= 4.5);
});

test('theme files are identical in web-client and admin-panel', () => {
  const other = here.includes('web-client') ? here.replace('web-client', 'admin-panel') : here.replace('admin-panel', 'web-client');
  for (const f of ['tokens.css', 'contrast.ts', 'tailwind-colors.ts', 'theme.test.ts', 'theme-guard.test.ts']) {
    assert.equal(readFileSync(join(here, f), 'utf8'), readFileSync(join(other, f), 'utf8'), `${f} differs`);
  }
});
