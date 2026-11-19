import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BUILTIN_BACKGROUND_IDS, BUILTIN_BACKGROUND_LABELS, backgroundFileError, builtinBackgroundUrl, parseBackgroundChoice, parseDefaultBackground, resolveBackground,
} from './backgroundPrefs.ts';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

test('choice validation: none / custom / known built-ins; everything else is "no choice"', () => {
  assert.equal(parseBackgroundChoice('none'), 'none');
  assert.equal(parseBackgroundChoice('custom'), 'custom');
  assert.equal(parseBackgroundChoice('builtin:lake'), 'builtin:lake');
  for (const bad of [null, undefined, '', 'builtin:', 'builtin:photo', 'url(x)', 3, 'BUILTIN:lake']) {
    assert.equal(parseBackgroundChoice(bad), null, String(bad));
  }
  assert.equal(parseDefaultBackground('custom'), 'none', 'the organisation default is never an uploaded image');
  assert.equal(parseDefaultBackground('builtin:aurora'), 'builtin:aurora');
  assert.equal(parseDefaultBackground(undefined), 'none');
});

test('resolve: own choice wins; no choice → organisation default; custom needs an image', () => {
  assert.deepEqual(resolveBackground(null, 'none', false), { kind: 'none' });
  assert.deepEqual(resolveBackground(null, 'builtin:forest', false), { kind: 'builtin', id: 'forest' });
  assert.deepEqual(resolveBackground('none', 'builtin:forest', true), { kind: 'none' }, '"Keiner" overrides the default');
  assert.deepEqual(resolveBackground('builtin:dunes', 'builtin:forest', false), { kind: 'builtin', id: 'dunes' });
  assert.deepEqual(resolveBackground('custom', 'builtin:forest', true), { kind: 'custom' });
  assert.deepEqual(resolveBackground('custom', 'builtin:forest', false), { kind: 'none' }, 'image removed elsewhere');
  assert.deepEqual(resolveBackground('builtin:evil', 'builtin:coast', false), { kind: 'builtin', id: 'coast' });
});

test('backgroundPrefs.ts is identical in web-client and admin-panel (the BCP picks the default from the same set)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const other = here.replace('web-client', 'admin-panel');
  assert.equal(readFileSync(join(here, 'backgroundPrefs.ts'), 'utf8'), readFileSync(join(other, 'backgroundPrefs.ts'), 'utf8'));
});

test('upload check: JPEG / PNG up to 5 MB', () => {
  assert.equal(backgroundFileError({ type: 'image/jpeg', size: 1000 }), null);
  assert.equal(backgroundFileError({ type: 'image/png', size: 5 * 1024 * 1024 }), null);
  assert.match(backgroundFileError({ type: 'image/png', size: 5 * 1024 * 1024 + 1 })!, /5 MB/);
  assert.match(backgroundFileError({ type: 'image/webp', size: 10 })!, /JPEG/);
  assert.match(backgroundFileError({ type: 'image/svg+xml', size: 10 })!, /JPEG/);
  assert.ok(backgroundFileError({ type: 'image/png', size: 0 }));
});

test('eight built-ins with German names, a light and a dark SVG each, small and self-contained', () => {
  assert.equal(BUILTIN_BACKGROUND_IDS.length, 8);
  assert.deepEqual(Object.values(BUILTIN_BACKGROUND_LABELS),
    ['Bergsee bei Nacht', 'Morgendämmerung', 'Wald', 'Küste', 'Dünen', 'Wellen', 'Polarlicht', 'Neutral']);
  for (const id of BUILTIN_BACKGROUND_IDS) {
    for (const dark of [false, true]) {
      const url = builtinBackgroundUrl(id, dark);
      assert.match(url, /^\/backgrounds\/[a-z]+-(light|dark)\.svg$/);
      const file = join(publicDir, url);
      assert.ok(existsSync(file), url);
      assert.ok(statSync(file).size < 30 * 1024, `${url} below 30 KB`);
      const svg = readFileSync(file, 'utf8');
      assert.match(svg, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.equal(/<script|href=|url\(\s*['"]?https?:|<image|<foreignObject|on[a-z]+=/i.test(svg), false, `${url}: no scripts, links or external images`);
    }
  }
});
