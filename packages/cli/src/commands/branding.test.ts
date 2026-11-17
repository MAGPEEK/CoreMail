/**
 * `coremail branding` helpers: option → PUT body, content type by extension, slots, summary.
 * Run: node --import tsx --test src/commands/branding.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrandingUpdate, contentTypeForFile, assertSlot, formatBranding } from './branding.js';

test('buildBrandingUpdate maps only the given options', () => {
  assert.deepEqual(buildBrandingUpdate({ name: ' Acme Mail ', color: '0A5BD3' }), { productName: 'Acme Mail', primaryColor: '#0a5bd3' });
  assert.deepEqual(buildBrandingUpdate({ name: 'default', color: 'default', headerColor: 'none' }), { productName: null, primaryColor: null, headerColor: null });
  assert.deepEqual(buildBrandingUpdate({ allowUserAccent: 'false', poweredBy: 'yes', loginText: 'Hi' }), { allowUserAccent: false, showPoweredBy: true, loginText: 'Hi' });
  assert.throws(() => buildBrandingUpdate({}), /Nothing to set/);
  assert.throws(() => buildBrandingUpdate({ color: 'red' }), /#rrggbb/);
  assert.throws(() => buildBrandingUpdate({ headerColor: '#12345' }), /#rrggbb/);
  assert.throws(() => buildBrandingUpdate({ name: 'x'.repeat(41) }), /1–40/);
  assert.throws(() => buildBrandingUpdate({ poweredBy: 'maybe' }), /true or false/);
});

test('content type by extension, slot names', () => {
  assert.equal(contentTypeForFile('logo.SVG'), 'image/svg+xml');
  assert.equal(contentTypeForFile('/x/bg.jpeg'), 'image/jpeg');
  assert.equal(contentTypeForFile('a.webp'), 'image/webp');
  assert.throws(() => contentTypeForFile('a.gif'), /Unsupported/);
  assert.equal(assertSlot('favicon'), 'favicon');
  assert.throws(() => assertSlot('banner'), /Unknown slot/);
});

test('formatBranding summary', () => {
  const s = formatBranding({
    version: 4, productName: 'Acme', primaryColor: '#112233', headerColor: null, allowUserAccent: false, showPoweredBy: true,
    loginText: '', footerLinks: [{ label: 'Imprint', url: 'https://x.org/i' }],
    assets: { logoLight: '/branding/assets/x.svg', logoDark: null, favicon: null, loginBackground: null },
  });
  assert.match(s, /Product name: +Acme/);
  assert.match(s, /locked to the brand colour/);
  assert.match(s, /Imprint <https:\/\/x.org\/i>/);
  assert.match(s, /logoLight: +\/branding\/assets\/x.svg/);
  assert.match(s, /Version: +4/);
});
