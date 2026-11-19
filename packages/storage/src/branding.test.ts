/** Branding (9.3): defaults, validation and row → public mapping. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

let row: Record<string, unknown> | null = null;
let fail = false;
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  branding: { findUnique: async () => { if (fail) throw new Error('db down'); return row; } },
};
const b = await import('./branding.js');

const SHA = 'a'.repeat(64);

test('defaults: CoreMail / #0078d4, overridable by valid BRANDING_NAME / BRANDING_COLOR', () => {
  assert.deepEqual(b.brandingDefaults({}), { productName: 'CoreMail', primaryColor: '#0078d4' });
  assert.deepEqual(b.brandingDefaults({ BRANDING_NAME: '  Acme Mail ', BRANDING_COLOR: '#AA0011' }), { productName: 'Acme Mail', primaryColor: '#aa0011' });
  assert.deepEqual(b.brandingDefaults({ BRANDING_NAME: 'x'.repeat(41), BRANDING_COLOR: 'red' }), { productName: 'CoreMail', primaryColor: '#0078d4' });
  assert.deepEqual(b.brandingDefaults({ BRANDING_NAME: 'a\nb', BRANDING_COLOR: '#12345' }), { productName: 'CoreMail', primaryColor: '#0078d4' });
});

test('validators', () => {
  assert.equal(b.normalizeProductName(''), null);
  assert.equal(b.normalizeProductName('   '), null);
  assert.equal(b.normalizeProductName('ü'.repeat(40)), 'ü'.repeat(40));
  assert.equal(b.normalizeProductName('a\u0000'), null);
  assert.equal(b.normalizeHexColor('#ABCDEF'), '#abcdef');
  assert.equal(b.normalizeHexColor('#abc'), null);
  assert.equal(b.normalizeHexColor('abcdef'), null);
  assert.equal(b.normalizeLoginText('Hello\r\nworld'), 'Hello\nworld');
  assert.equal(b.normalizeLoginText('x'.repeat(281)), null);
  assert.equal(b.normalizeLoginText('tab\there'), null);
  assert.equal(b.normalizeFooterUrl('https://example.org/imprint'), 'https://example.org/imprint');
  assert.equal(b.normalizeFooterUrl('mailto:privacy@example.org'), 'mailto:privacy@example.org');
  for (const bad of ['http://example.org', 'javascript:alert(1)', 'data:text/html,x', 'mailto:nobody', '//example.org', 'https://exa mple.org', 'ftp://x.org', `https://x.org/${'a'.repeat(500)}`]) {
    assert.equal(b.normalizeFooterUrl(bad), null, bad);
  }
});

/** Footer URL cases; `true` = accepted. The frontend rule (validateFooterLink) must agree on each. */
const FOOTER_URL_CASES: Array<[string, boolean]> = [
  ['https://example.org/imprint', true],
  ['HTTPS://EXAMPLE.ORG/Imprint', true],
  ['https://example.org/p?a=1&b=2#top', true],
  ['mailto:privacy@example.org', true],
  ['mailto:privacy@example.org?subject=Hello', true],
  // mailto without a dotted domain
  ['mailto:privacy@localhost', false],
  ['mailto:privacy@example', false],
  ['mailto:@example.org', false],
  ['mailto:a@b@example.org', false],
  ['mailto:a@example.org/x', false],
  // user info in https URLs
  ['https://user:pw@example.org/', false],
  ['https://user@example.org/', false],
  ['https://:pw@example.org/', false],
  // quotes, backticks, angle brackets, backslashes, whitespace
  ['https://example.org/"onmouseover="x', false],
  ["https://example.org/'x", false],
  ['https://example.org/`x`', false],
  ['https://example.org/<b>', false],
  ['https://example.org\\@evil.example', false],
  ['mailto:"a"@example.org', false],
  ['https://example.org/a b', false],
  // schemes
  ['http://example.org', false],
  ['javascript:alert(1)', false],
  ['//example.org', false],
  ['https:example.org', false],
];

test('footer URL: strict rule (mailto needs a dotted domain, no user info, no quotes)', () => {
  for (const [url, ok] of FOOTER_URL_CASES) {
    assert.equal(b.normalizeFooterUrl(url), ok ? url : null, url);
  }
});

test('footer URL: backend and frontend rule agree on every case', async () => {
  // Test-only read of the frontend rule (a computed specifier keeps it out of the storage build).
  const spec = new URL('../../web-client/src/lib/branding.ts', import.meta.url).href;
  const fe = (await import(spec)) as { validateFooterLink: (l: { label: string; url: string }) => string | null };
  for (const [url] of FOOTER_URL_CASES) {
    assert.equal(b.normalizeFooterUrl(url) !== null, fe.validateFooterLink({ label: 'L', url }) === null, url);
  }
});

test('stored footer links: an entry that fails the rules is dropped, the others stay', () => {
  const p = b.toPublicBranding({
    version: 1, productName: null, primaryColor: null, headerColor: null, logoLightKey: null, logoDarkKey: null,
    faviconKey: null, loginBackgroundKey: null, loginText: '', allowUserAccent: true, showPoweredBy: true,
    footerLinks: [{ label: 'Old', url: 'mailto:a@localhost' }, { label: 'Impressum', url: 'https://example.org/i' }],
  }, {});
  assert.deepEqual(p.footerLinks, [{ label: 'Impressum', url: 'https://example.org/i' }]);
});

test('footer links: max 5, label ≤ 40, unknown fields rejected', () => {
  assert.deepEqual(b.normalizeFooterLinks([{ label: ' Impressum ', url: 'https://example.org/i' }]), [{ label: 'Impressum', url: 'https://example.org/i' }]);
  const link = { label: 'L', url: 'https://example.org' };
  assert.ok('error' in (b.normalizeFooterLinks(Array(6).fill(link)) as object));
  assert.ok('error' in (b.normalizeFooterLinks([{ label: 'x'.repeat(41), url: 'https://example.org' }]) as object));
  assert.ok('error' in (b.normalizeFooterLinks([{ label: 'x', url: 'https://example.org', onclick: 'x' }]) as object));
  assert.ok('error' in (b.normalizeFooterLinks('nope') as object));
  assert.ok('error' in (b.normalizeFooterLinks([{ label: 'x', url: 'javascript:alert(1)' }]) as object));
});

test('asset URLs only for content-addressed branding keys', () => {
  assert.equal(b.brandingAssetUrl(`branding/${SHA}.svg`), `/branding/assets/${SHA}.svg`);
  assert.equal(b.brandingAssetUrl(`raw/aa/${SHA}.eml`), null);
  assert.equal(b.brandingAssetUrl(`branding/../${SHA}.svg`), null);
  assert.equal(b.brandingAssetUrl(`branding/${SHA}.html`), null);
  assert.equal(b.brandingAssetUrl(null), null);
});

test('toPublicBranding: contract shape, defaults for null fields, invalid stored values ignored', () => {
  assert.deepEqual(b.toPublicBranding(null, {}), {
    version: 0, productName: 'CoreMail', primaryColor: '#0078d4', headerColor: null,
    allowUserAccent: true, showPoweredBy: true, defaultBackground: 'none', loginText: '', footerLinks: [],
    assets: { logoLight: null, logoDark: null, favicon: null, loginBackground: null },
  });
  const p = b.toPublicBranding({
    version: 3, productName: 'Acme', primaryColor: '#112233', headerColor: '#445566',
    logoLightKey: `branding/${SHA}.svg`, logoDarkKey: null, faviconKey: `branding/${SHA}.png`, loginBackgroundKey: null,
    loginText: 'Welcome', footerLinks: [{ label: 'Impressum', url: 'https://example.org/impressum' }],
    allowUserAccent: false, showPoweredBy: false, defaultBackground: 'builtin:forest',
  }, { BRANDING_NAME: 'Env' });
  assert.equal(p.defaultBackground, 'builtin:forest');
  assert.equal(p.version, 3);
  assert.equal(p.productName, 'Acme');
  assert.equal(p.headerColor, '#445566');
  assert.equal(p.assets.logoLight, `/branding/assets/${SHA}.svg`);
  assert.equal(p.assets.favicon, `/branding/assets/${SHA}.png`);
  assert.deepEqual(p.footerLinks, [{ label: 'Impressum', url: 'https://example.org/impressum' }]);
  const q = b.toPublicBranding({ ...{ version: 1, productName: null, primaryColor: 'evil', headerColor: 'x', logoLightKey: null, logoDarkKey: null, faviconKey: null, loginBackgroundKey: null, loginText: '', footerLinks: 'junk', allowUserAccent: true, showPoweredBy: true } }, { BRANDING_NAME: 'Env', BRANDING_COLOR: '#00ff00' });
  assert.equal(q.productName, 'Env');
  assert.equal(q.primaryColor, '#00ff00');
  assert.equal(q.headerColor, null);
  assert.deepEqual(q.footerLinks, []);
  assert.equal(q.defaultBackground, 'none', 'missing column (older row) → none');
  assert.equal(b.toPublicBranding({ ...{ version: 1, productName: null, primaryColor: null, headerColor: null, logoLightKey: null, logoDarkKey: null, faviconKey: null, loginBackgroundKey: null, loginText: '', footerLinks: [], allowUserAccent: true, showPoweredBy: true }, defaultBackground: 'builtin:evil' }).defaultBackground, 'none');
});

test('getBranding never throws; brandDisplayName prefers a branded product name', async () => {
  row = { version: 2, productName: 'Acme', primaryColor: null, headerColor: null, logoLightKey: null, logoDarkKey: null, faviconKey: null, loginBackgroundKey: null, loginText: '', footerLinks: [], allowUserAccent: true, showPoweredBy: true };
  assert.equal((await b.getBranding()).productName, 'Acme');
  assert.equal(await b.getProductName(), 'Acme');
  fail = true;
  assert.equal((await b.getBranding()).version, 0);
  fail = false;
  assert.equal(b.brandDisplayName('Acme', 'Org GmbH'), 'Acme');
  assert.equal(b.brandDisplayName('CoreMail', 'Org GmbH'), 'Org GmbH');
  assert.equal(b.brandDisplayName('CoreMail', '  '), 'CoreMail');
});
