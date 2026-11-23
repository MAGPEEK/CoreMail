/**
 * Branding client logic (9.3). KEEP IDENTICAL in web-client and admin-panel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DEFAULT_BRANDING, BUILTIN_FAVICON, accentFillChannels, brandCssVars, channelsToHex, checkAssetFile,
  documentTitle, faviconHref, headerColors, headerHex, hexToChannels, isValidChannels, logoFor,
  migrateThemeState, normalizeHex, parseBranding, parseInjectedBrandingText, resolveAccentChannels,
  safeAssetUrl, sameBranding, validateFooterLink, validateFooterLinks, type BrandingAssets,
} from './branding.ts';
import { contrastRatio, parseRgbChannels, LIGHT_BACKGROUNDS, DARK_BACKGROUNDS } from '../theme/contrast.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WHITE = [255, 255, 255] as const;
const noAssets: BrandingAssets = { logoLight: null, logoDark: null, favicon: null, loginBackground: null };

test('branding.ts and branding.test.ts are identical in web-client and admin-panel', () => {
  const other = here.includes('web-client') ? here.replace('web-client', 'admin-panel') : here.replace('admin-panel', 'web-client');
  for (const f of ['branding.ts', 'branding.test.ts']) {
    assert.equal(readFileSync(join(here, f), 'utf8'), readFileSync(join(other, f), 'utf8'), `${f} differs`);
  }
});

// ── Accent rule ──────────────────────────────────────────────────────────────

test('accent: brand primary is the default; user choice wins only when allowed', () => {
  const brand = { primaryColor: '#107c10', allowUserAccent: true };
  assert.equal(resolveAccentChannels(brand, null), '16 124 16');
  assert.equal(resolveAccentChannels(brand, undefined), '16 124 16');
  assert.equal(resolveAccentChannels(brand, '180 0 158'), '180 0 158');
  assert.equal(resolveAccentChannels({ ...brand, allowUserAccent: false }, '180 0 158'), '16 124 16');
  assert.equal(resolveAccentChannels(brand, 'garbage'), '16 124 16');
  assert.equal(resolveAccentChannels(brand, '300 0 0'), '16 124 16');
  assert.equal(resolveAccentChannels({ primaryColor: 'nope', allowUserAccent: false }, null), '0 109 119');
});

test('accent migration: old default = never chose (null), other presets stay explicit', () => {
  assert.deepEqual(migrateThemeState({ theme: 'dark', accentRgb: '0 120 212' }, 0), { theme: 'dark', accentRgb: null });
  assert.deepEqual(migrateThemeState({ theme: 'light', accentRgb: '98 100 167' }, 0), { theme: 'light', accentRgb: '98 100 167' });
  assert.deepEqual(migrateThemeState({ theme: 'system' }, 0), { theme: 'system', accentRgb: null });
  assert.deepEqual(migrateThemeState({ accentRgb: 'evil' }, 0), { accentRgb: null });
  assert.deepEqual(migrateThemeState(null, 0), { accentRgb: null });
  // already migrated: null and explicit values are kept, junk is dropped
  assert.deepEqual(migrateThemeState({ accentRgb: '0 120 212' }, 1), { accentRgb: '0 120 212' });
  assert.deepEqual(migrateThemeState({ accentRgb: null }, 1), { accentRgb: null });
  assert.deepEqual(migrateThemeState({ accentRgb: 42 }, 1), { accentRgb: null });
});

test('accent fill keeps white text >= 4.5:1; presets stay unchanged', () => {
  for (const p of ['0 120 212', '98 100 167', '16 124 16', '216 59 1', '0 133 117', '180 0 158']) {
    assert.equal(accentFillChannels(p), p);
  }
  for (const c of ['255 235 59', '255 255 255', '0 200 255', '250 250 120', '0 0 0', '255 0 0']) {
    const fill = parseRgbChannels(accentFillChannels(c));
    assert.ok(contrastRatio(WHITE, fill) >= 4.5, `white on fill of ${c}`);
  }
});

test('brandCssVars: accent-fg readable on every surface, header text >= 4.5:1, both themes', () => {
  for (const hex of ['#ffeb3b', '#0078d4', '#ffffff', '#000000', '#7fff00', '#777777', '#e81123']) {
    const ch = hexToChannels(hex)!;
    for (const dark of [false, true]) {
      const v = brandCssVars(ch, hex, dark);
      const fg = parseRgbChannels(v['--color-accent-fg']!);
      for (const bg of dark ? DARK_BACKGROUNDS : LIGHT_BACKGROUNDS) assert.ok(contrastRatio(fg, bg) >= 4.5, `${hex} fg dark=${dark}`);
      assert.ok(contrastRatio(WHITE, parseRgbChannels(v['--color-accent']!)) >= 4.5, `${hex} fill`);
      assert.ok(contrastRatio(parseRgbChannels(v['--header-fg']!), parseRgbChannels(v['--header']!)) >= 4.5, `${hex} header`);
      assert.equal(v['--header'], ch, 'the header shows the brand colour unchanged');
    }
  }
  assert.equal(brandCssVars('junk', '#0078d4', false)['--color-accent'], '0 109 119');
});

test('header text: white on dark colours, black on light ones; overlay is the opposite', () => {
  assert.deepEqual(headerColors('#0078d4'), { bg: '0 120 212', fg: '255 255 255', overlay: '0 0 0' });
  assert.deepEqual(headerColors('#ffeb3b'), { bg: '255 235 59', fg: '0 0 0', overlay: '255 255 255' });
  assert.equal(headerColors('nonsense').bg, '0 109 119');
  // hover/selected overlay (25 %) must not lower the text contrast
  for (const hex of ['#3a8fd0', '#7a7a7a', '#808080', '#5f9ea0', '#ff8c00']) {
    const h = headerColors(hex);
    const bg = parseRgbChannels(h.bg); const ov = parseRgbChannels(h.overlay); const fg = parseRgbChannels(h.fg);
    const mixed = bg.map((c, i) => Math.round(c + (ov[i]! - c) * 0.25)) as unknown as typeof bg;
    assert.ok(contrastRatio(fg, mixed) >= contrastRatio(fg, bg), hex);
  }
  assert.equal(headerHex({ headerColor: null, primaryColor: '#123456' }), '#123456');
  assert.equal(headerHex({ headerColor: '#ABCDEF', primaryColor: '#123456' }), '#abcdef');
});

test('hex helpers', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex(' 0078D4 '), '#0078d4');
  assert.equal(normalizeHex('#12345'), null);
  assert.equal(normalizeHex('red'), null);
  assert.equal(normalizeHex(null), null);
  assert.equal(hexToChannels('#0078d4'), '0 120 212');
  assert.equal(channelsToHex('0 120 212'), '#0078d4');
  assert.equal(channelsToHex('1 2'), null);
  assert.ok(isValidChannels('255 255 255'));
  assert.ok(!isValidChannels('256 0 0'));
  assert.ok(!isValidChannels('1, 2, 3'));
});

// ── Favicon / logo / title ───────────────────────────────────────────────────

test('favicon fallback chain: favicon → logoLight → built-in', () => {
  assert.equal(faviconHref({ ...noAssets, favicon: '/branding/assets/a.png', logoLight: '/branding/assets/b.svg' }), '/branding/assets/a.png');
  assert.equal(faviconHref({ ...noAssets, logoLight: '/branding/assets/b.svg' }), '/branding/assets/b.svg');
  // a PNG logo → the square favicon the gateway derives from it; WebP / SVG logos as they are
  const sha = 'a1'.repeat(32);
  assert.equal(faviconHref({ ...noAssets, logoLight: `/branding/assets/${sha}.png` }), `/branding/favicons/${sha}-64.png`);
  assert.equal(faviconHref({ ...noAssets, logoLight: `/branding/assets/${sha}.webp` }), `/branding/assets/${sha}.webp`);
  assert.equal(faviconHref({ ...noAssets, favicon: `/branding/assets/${sha}.webp`, logoLight: `/branding/assets/${sha}.png` }), `/branding/assets/${sha}.webp`);
  assert.equal(faviconHref({ ...noAssets, logoDark: '/branding/assets/c.svg' }), BUILTIN_FAVICON);
  assert.equal(faviconHref(noAssets), BUILTIN_FAVICON);
  assert.equal(faviconHref({ ...noAssets, favicon: 'javascript:alert(1)' }), BUILTIN_FAVICON);
});

test('logo: dark logo only in dark mode and when set', () => {
  const a = { ...noAssets, logoLight: '/branding/assets/l.svg', logoDark: '/branding/assets/d.svg' };
  assert.equal(logoFor(a, false), '/branding/assets/l.svg');
  assert.equal(logoFor(a, true), '/branding/assets/d.svg');
  assert.equal(logoFor({ ...a, logoDark: null }, true), '/branding/assets/l.svg');
  assert.equal(logoFor(noAssets, true), null);
  assert.equal(documentTitle('Acme Mail', 'mwa'), 'Acme Mail');
  assert.equal(documentTitle('Acme Mail', 'bcp'), 'Acme Mail BCP');
});

test('asset URLs: only same-origin root-relative paths', () => {
  assert.equal(safeAssetUrl('/branding/assets/0a1b.svg'), '/branding/assets/0a1b.svg');
  assert.equal(safeAssetUrl('/branding/assets/0a1b.png?v=3'), '/branding/assets/0a1b.png?v=3');
  for (const bad of ['https://evil.example/x.svg', '//evil.example/x.svg', 'javascript:alert(1)', 'data:image/svg+xml,<svg>',
    '/a")+url("x', '/a b.png', '/../etc/passwd', '', 42, null]) {
    assert.equal(safeAssetUrl(bad), null, String(bad));
  }
});

// ── Footer links ─────────────────────────────────────────────────────────────

test('footer link validation: https and mailto only, label 1..40', () => {
  assert.equal(validateFooterLink({ label: 'Impressum', url: 'https://example.org/impressum' }), null);
  assert.equal(validateFooterLink({ label: 'Kontakt', url: 'mailto:info@example.org' }), null);
  assert.equal(validateFooterLink({ label: 'Kontakt', url: 'MAILTO:info@example.org?subject=Hallo' }), null);
  assert.equal(validateFooterLink({ label: '', url: 'https://example.org' }), 'LABEL_EMPTY');
  assert.equal(validateFooterLink({ label: '   ', url: 'https://example.org' }), 'LABEL_EMPTY');
  assert.equal(validateFooterLink({ label: 'x'.repeat(41), url: 'https://example.org' }), 'LABEL_TOO_LONG');
  assert.equal(validateFooterLink({ label: 'x'.repeat(40), url: 'https://example.org' }), null);
  assert.equal(validateFooterLink({ label: 'A', url: '' }), 'URL_EMPTY');
  assert.equal(validateFooterLink({ label: 'A', url: 'http://example.org' }), 'URL_SCHEME');
  assert.equal(validateFooterLink({ label: 'A', url: 'javascript:alert(1)' }), 'URL_SCHEME');
  assert.equal(validateFooterLink({ label: 'A', url: 'data:text/html,x' }), 'URL_SCHEME');
  assert.equal(validateFooterLink({ label: 'A', url: '//example.org' }), 'URL_SCHEME');
  assert.equal(validateFooterLink({ label: 'A', url: 'https://' }), 'URL_INVALID');
  assert.equal(validateFooterLink({ label: 'A', url: 'https://user:pw@example.org' }), 'URL_INVALID');
  assert.equal(validateFooterLink({ label: 'A', url: 'https://exa mple.org' }), 'URL_INVALID');
  assert.equal(validateFooterLink({ label: 'A', url: 'mailto:nobody' }), 'URL_INVALID');
  assert.equal(validateFooterLink({ label: 'A', url: 'https://example.org/"onmouseover=' }), 'URL_INVALID');
});

test('footer links: at most 5', () => {
  const ok = { label: 'A', url: 'https://example.org' };
  assert.equal(validateFooterLinks([ok, ok, ok, ok, ok]).ok, true);
  const six = validateFooterLinks([ok, ok, ok, ok, ok, ok]);
  assert.equal(six.tooMany, true);
  assert.equal(six.ok, false);
  const mixed = validateFooterLinks([ok, { label: 'B', url: 'ftp://x' }]);
  assert.deepEqual(mixed.errors, [null, 'URL_SCHEME']);
});

// ── Parsing ──────────────────────────────────────────────────────────────────

const SAMPLE = {
  version: 3,
  productName: 'Acme Mail',
  primaryColor: '#0078D4',
  headerColor: null,
  allowUserAccent: false,
  showPoweredBy: true,
  loginText: 'Willkommen <b>bei</b> Acme',
  footerLinks: [{ label: 'Impressum', url: 'https://example.org/impressum' }],
  assets: { logoLight: '/branding/assets/abc.svg', logoDark: null, favicon: null, loginBackground: null },
};

test('parseBranding: contract object is taken over (colours lower-cased)', () => {
  const b = parseBranding(SAMPLE);
  assert.equal(b.version, 3);
  assert.equal(b.productName, 'Acme Mail');
  assert.equal(b.primaryColor, '#0078d4');
  assert.equal(b.headerColor, null);
  assert.equal(b.allowUserAccent, false);
  assert.equal(b.loginText, 'Willkommen <b>bei</b> Acme', 'kept as plain text — rendered as a text node');
  assert.deepEqual(b.footerLinks, SAMPLE.footerLinks);
  assert.equal(b.assets.logoLight, '/branding/assets/abc.svg');
});

test('parseBranding: junk falls back to defaults, unsafe links/assets are dropped', () => {
  assert.deepEqual(parseBranding(null), DEFAULT_BRANDING);
  assert.deepEqual(parseBranding([]), DEFAULT_BRANDING);
  assert.deepEqual(parseBranding('x'), DEFAULT_BRANDING);
  const b = parseBranding({
    productName: '   ', primaryColor: 'blue', headerColor: '#zzzzzz', allowUserAccent: 'no', showPoweredBy: 0,
    loginText: 5, version: 'x',
    footerLinks: [{ label: 'XSS', url: 'javascript:alert(1)' }, null, 'x', ...Array(8).fill({ label: 'L', url: 'https://e.org' })],
    assets: { logoLight: 'https://evil.example/l.svg', favicon: '//evil/x', logoDark: 7 },
  });
  assert.equal(b.productName, 'CoreMail');
  assert.equal(b.primaryColor, '#006d77');
  assert.equal(b.headerColor, null);
  assert.equal(b.allowUserAccent, true);
  assert.equal(b.showPoweredBy, true);
  assert.equal(b.loginText, '');
  assert.equal(b.version, 0);
  assert.equal(b.footerLinks.length, 5);
  assert.ok(b.footerLinks.every((l) => l.url === 'https://e.org'));
  assert.deepEqual(b.assets, noAssets);
});

test('injected JSON: escaped script content parses, broken content is ignored', () => {
  // the gateway escapes "<" as < for the script context
  const injected = JSON.stringify(SAMPLE).replace(/</g, '\\u003c');
  assert.ok(!injected.includes('<'));
  const b = parseInjectedBrandingText(injected)!;
  assert.equal(b.loginText, 'Willkommen <b>bei</b> Acme');
  assert.equal(b.productName, 'Acme Mail');
  assert.equal(parseInjectedBrandingText(''), null);
  assert.equal(parseInjectedBrandingText(null), null);
  assert.equal(parseInjectedBrandingText('{broken'), null);
  assert.equal(parseInjectedBrandingText('[1,2]'), null);
  assert.equal(parseInjectedBrandingText('"string"'), null);
  assert.equal(parseInjectedBrandingText('{"productName":"</script><script>alert(1)</script>"}')!.productName,
    '</script><script>alert(1)</script>', 'only ever rendered as text');
});

test('sameBranding compares by value', () => {
  assert.ok(sameBranding(parseBranding(SAMPLE), parseBranding(structuredClone(SAMPLE))));
  assert.ok(!sameBranding(parseBranding(SAMPLE), DEFAULT_BRANDING));
});

test('asset pre-check mirrors the API limits', () => {
  assert.equal(checkAssetFile('logoLight', { type: 'image/svg+xml', size: 1000 }), null);
  assert.equal(checkAssetFile('logoLight', { type: 'image/jpeg', size: 1000 }), 'TYPE');
  assert.equal(checkAssetFile('loginBackground', { type: 'image/jpeg', size: 1000 }), null);
  assert.equal(checkAssetFile('favicon', { type: 'image/png', size: 512 * 1024 + 1 }), 'SIZE');
  assert.equal(checkAssetFile('loginBackground', { type: 'image/png', size: 2 * 1024 * 1024 }), null);
  assert.equal(checkAssetFile('loginBackground', { type: 'image/png', size: 2 * 1024 * 1024 + 1 }), 'SIZE');
  assert.equal(checkAssetFile('favicon', { type: 'image/gif', size: 10 }), 'TYPE');
  assert.equal(checkAssetFile('favicon', { type: 'image/png', size: 0 }), 'SIZE');
});

test('10.1 defaultBackground: none or builtin:<id>; anything else → none', () => {
  assert.equal(parseBranding({}).defaultBackground, 'none');
  assert.equal(parseBranding({ defaultBackground: 'builtin:lake' }).defaultBackground, 'builtin:lake');
  for (const bad of ['custom', 'url(https://x)', 'builtin:', 'builtin:Lake', 7]) {
    assert.equal(parseBranding({ defaultBackground: bad }).defaultBackground, 'none', String(bad));
  }
});
