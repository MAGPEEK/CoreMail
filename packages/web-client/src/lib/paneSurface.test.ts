/**
 * 10.1: panes over a background picture use the surface tokens at
 * PANE_SURFACE_ALPHA. Whatever the picture is (worst cases: pure black or pure
 * white behind the pane), every text token must keep 4.5:1 on the blended
 * surface — in light and dark mode (SC 1.4.3), and control borders 3:1 (SC 1.4.11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { contrastRatio, parseRgbChannels, type Rgb } from '../theme/contrast.ts';
import { PANE_SURFACE_ALPHA } from './backgroundPrefs.ts';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'theme', 'tokens.css'), 'utf8');

function block(selector: string): Record<string, Rgb> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, Rgb> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([\d\s]+);/g)) out[m[1]!] = parseRgbChannels(m[2]!);
  return out;
}

const light = block(':root');
const dark = { ...light, ...block(':root.dark') };
const blend = (top: Rgb, below: Rgb, alpha: number): Rgb =>
  [0, 1, 2].map((i) => Math.round(top[i]! * alpha + below[i]! * (1 - alpha))) as unknown as Rgb;

const TEXT = ['fg', 'fg-muted', 'fg-subtle', 'color-accent-fg', 'danger-fg', 'success-fg', 'warning-fg', 'info-fg'];
const BEHIND: Rgb[] = [[0, 0, 0], [255, 255, 255], [128, 128, 128]];

for (const [mode, tokens] of [['light', light], ['dark', dark]] as const) {
  test(`${mode}: text keeps 4.5:1 and control borders 3:1 on a ${PANE_SURFACE_ALPHA * 100} % surface over any picture`, () => {
    assert.ok(PANE_SURFACE_ALPHA >= 0.9);
    for (const surface of ['surface', 'surface-2']) {
      for (const behind of BEHIND) {
        const bg = blend(tokens[surface]!, behind, PANE_SURFACE_ALPHA);
        for (const fg of TEXT) {
          const r = contrastRatio(tokens[fg]!, bg);
          assert.ok(r >= 4.5, `${mode} ${fg} on ${surface} over ${behind.join(',')}: ${r.toFixed(2)}`);
        }
        const border = contrastRatio(tokens['line-strong']!, bg);
        assert.ok(border >= 3, `${mode} line-strong on ${surface} over ${behind.join(',')}: ${border.toFixed(2)}`);
      }
    }
  });
}
