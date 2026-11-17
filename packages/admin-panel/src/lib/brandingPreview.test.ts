import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PREVIEW_THEME_VARS, PREVIEW_TOKEN_NAMES, previewStyle } from './brandingPreview.ts';
import { contrastRatio, parseRgbChannels } from '../theme/contrast.ts';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'theme', 'tokens.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`));
  assert.ok(start >= 0, selector);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([\d\s]+);/g)) out[m[1]!] = m[2]!.trim().replace(/\s+/g, ' ');
  return out;
}

test('preview token values match tokens.css (light and dark)', () => {
  const light = block(':root');
  const dark = { ...light, ...block(':root.dark') };
  for (const name of PREVIEW_TOKEN_NAMES) {
    assert.equal(PREVIEW_THEME_VARS.light[name], light[name], `light ${name}`);
    assert.equal(PREVIEW_THEME_VARS.dark[name], dark[name], `dark ${name}`);
  }
});

test('previewStyle: theme tokens + brand variables from the unsaved colours', () => {
  const s = previewStyle({ primaryColor: '#ffeb3b', headerColor: null }, true);
  assert.equal(s['--surface'], '27 30 37');
  assert.equal(s['colorScheme'], 'dark');
  assert.equal(s['--header'], '255 235 59');
  assert.equal(s['--header-fg'], '0 0 0');
  assert.ok(contrastRatio([255, 255, 255], parseRgbChannels(s['--color-accent']!)) >= 4.5);
  const custom = previewStyle({ primaryColor: '#0078d4', headerColor: '#111111' }, false);
  assert.equal(custom['--header'], '17 17 17');
  assert.equal(custom['--header-fg'], '255 255 255');
  // invalid input while typing → defaults, never a broken style
  const typing = previewStyle({ primaryColor: '#12', headerColor: 'x' }, false);
  assert.equal(typing['--header'], '0 120 212');
  assert.equal(typing['--color-accent'], '0 120 212');
});
