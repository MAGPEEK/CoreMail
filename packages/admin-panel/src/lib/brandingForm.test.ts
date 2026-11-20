import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advancedHasOverride, applyDefault, applySuggestion, changeCount, dirtyStatusText, draftFrom, draftToBody, editDraft,
  effectiveAssets, isDraftDirty, parseAdminBranding, parseFieldError, parseWarnings, releasedPreviewUrls, savePlan,
  saveSummary, validateDraft, withAssetRemoved, withAssetUpload,
  type AssetChanges, type SaveStep,
} from './brandingForm.ts';
import { DEFAULT_BRANDING } from './branding.ts';

const saved = parseAdminBranding({
  version: 2, productName: 'Acme Mail', primaryColor: '#0078d4', headerColor: null,
  allowUserAccent: true, showPoweredBy: true, loginText: '',
  footerLinks: [{ label: 'Impressum', url: 'https://example.org/impressum' }],
  assets: {},
  defaults: { productName: 'CoreMail', primaryColor: '#0078d4' },
  explicit: { productName: true, primaryColor: false, headerColor: false },
});
/** Nothing stored; BRANDING_NAME / BRANDING_COLOR set on the server. */
const envDefaults = parseAdminBranding({
  ...DEFAULT_BRANDING, productName: 'Env Mail', primaryColor: '#aa3300',
  defaults: { productName: 'Env Mail', primaryColor: '#aa3300' },
  explicit: { productName: false, primaryColor: false, headerColor: false },
});

test('a fresh draft is valid and not dirty', () => {
  const d = draftFrom(saved);
  assert.deepEqual(validateDraft(d), {});
  assert.equal(isDraftDirty(d, saved), false);
  assert.equal(isDraftDirty({ ...d, productName: '  Acme Mail ' }, saved), false, 'whitespace only');
  assert.equal(isDraftDirty({ ...d, primaryColor: '#0078D4' }, saved), false, 'case only');
  assert.equal(isDraftDirty({ ...d, showPoweredBy: false }, saved), true);
  // editing the draft never mutates the saved object
  d.footerLinks[0]!.label = 'X';
  assert.equal(saved.branding.footerLinks[0]!.label, 'Impressum');
});

test('admin answer: defaults + explicit parsed; missing (older server) → stored, so "Standard" still sends null', () => {
  assert.deepEqual(saved.defaults, { productName: 'CoreMail', primaryColor: '#0078d4' });
  assert.deepEqual(saved.explicit, { productName: true, primaryColor: false, headerColor: false });
  const old = parseAdminBranding({ ...DEFAULT_BRANDING, headerColor: '#112233' });
  assert.deepEqual(old.defaults, { productName: 'CoreMail', primaryColor: '#0078d4' });
  assert.deepEqual(old.explicit, { productName: true, primaryColor: true, headerColor: true });
  const junk = parseAdminBranding({ ...DEFAULT_BRANDING, defaults: { productName: 'x'.repeat(41), primaryColor: 'red' }, explicit: { productName: 'yes' } });
  assert.deepEqual(junk.defaults, { productName: 'CoreMail', primaryColor: '#0078d4' });
  assert.equal(junk.explicit.productName, true);
});

test('save sends only changed fields — untouched env defaults are never frozen into the database', () => {
  const d = draftFrom(envDefaults);
  assert.deepEqual(d.useDefault, { productName: true, primaryColor: true });
  assert.equal(d.productName, 'Env Mail');
  assert.deepEqual(draftToBody(d, envDefaults), {}, 'nothing changed → empty body');
  assert.deepEqual(draftToBody({ ...d, showPoweredBy: false }, envDefaults), { showPoweredBy: false }, 'other fields alone');
  // typing the current default again is no change
  assert.deepEqual(draftToBody(editDraft(d, 'productName', ' Env Mail '), envDefaults), {});
  assert.deepEqual(draftToBody(editDraft(d, 'primaryColor', '#AA3300'), envDefaults), {});
  // a real edit is sent
  assert.deepEqual(draftToBody(editDraft(d, 'productName', 'Acme'), envDefaults), { productName: 'Acme' });
  assert.deepEqual(draftToBody(editDraft(d, 'primaryColor', '#123'), envDefaults), { primaryColor: '#112233' });
  assert.deepEqual(draftToBody({ ...d, headerColor: '#ffffff' }, envDefaults), { headerColor: '#ffffff' });
  assert.deepEqual(draftToBody({ ...d, loginText: ' Hi ' }, envDefaults), { loginText: 'Hi' });
  assert.deepEqual(draftToBody({ ...d, footerLinks: [{ label: ' A ', url: ' https://a.org ' }] }, envDefaults), { footerLinks: [{ label: 'A', url: 'https://a.org' }] });
});

test('"Standard verwenden": shows the default and sends null only for a stored value', () => {
  const d = draftFrom(saved); // productName stored, primaryColor default
  assert.deepEqual(d.useDefault, { productName: false, primaryColor: true });
  const n = applyDefault(editDraft(d, 'productName', 'Typo'), 'productName', saved);
  assert.equal(n.productName, 'CoreMail');
  assert.equal(n.useDefault.productName, true);
  assert.deepEqual(draftToBody(n, saved), { productName: null });
  assert.equal(isDraftDirty(n, saved), true);
  // the colour is not stored: "Standard" after an edit just discards the edit
  const c = applyDefault(editDraft(d, 'primaryColor', '#000000'), 'primaryColor', saved);
  assert.equal(c.primaryColor, '#0078d4');
  assert.deepEqual(draftToBody(c, saved), {});
  // a stored value equal to the default is still removed on request
  const eq = parseAdminBranding({ ...DEFAULT_BRANDING, explicit: { productName: true, primaryColor: true, headerColor: false } });
  assert.deepEqual(draftToBody(applyDefault(applyDefault(draftFrom(eq), 'productName', eq), 'primaryColor', eq), eq), { productName: null, primaryColor: null });
  // the header colour's default is "no own colour" (null)
  const h = parseAdminBranding({ ...DEFAULT_BRANDING, headerColor: '#123456', explicit: { productName: false, primaryColor: false, headerColor: true } });
  assert.deepEqual(draftToBody({ ...draftFrom(h), headerColor: null }, h), { headerColor: null });
});

test('validation: name, colours, login text, footer links', () => {
  const d = draftFrom(parseAdminBranding(DEFAULT_BRANDING));
  assert.ok(validateDraft({ ...d, productName: '  ' }).productName);
  assert.ok(validateDraft({ ...d, productName: 'x'.repeat(41) }).productName);
  assert.equal(validateDraft({ ...d, productName: 'x'.repeat(40) }).productName, undefined);
  assert.ok(validateDraft({ ...d, primaryColor: '#12' }).primaryColor);
  assert.equal(validateDraft({ ...d, primaryColor: '#abc' }).primaryColor, undefined);
  assert.ok(validateDraft({ ...d, headerColor: 'blue' }).headerColor);
  assert.equal(validateDraft({ ...d, headerColor: null }).headerColor, undefined);
  assert.ok(validateDraft({ ...d, loginText: 'x'.repeat(281) }).loginText);
  assert.match(validateDraft({ ...d, footerLinks: [{ label: 'A', url: 'http://x.org' }] }).footerLinks!, /^Link 1:/);
  const six = Array(6).fill({ label: 'A', url: 'https://x.org' });
  assert.equal(validateDraft({ ...d, footerLinks: six }).footerLinks, 'Höchstens 5 Links.');
});

test('PUT body is trimmed and normalised', () => {
  const body = draftToBody({
    productName: ' Acme ', primaryColor: '#ABC', headerColor: '#FFFFFF', allowUserAccent: false,
    showPoweredBy: false, defaultBackground: 'none', loginText: ' Hallo ', footerLinks: [{ label: ' Impressum ', url: ' https://e.org/i ' }],
    useDefault: { productName: false, primaryColor: false },
  }, saved);
  assert.deepEqual(body, {
    productName: 'Acme', primaryColor: '#aabbcc', headerColor: '#ffffff', allowUserAccent: false,
    showPoweredBy: false, loginText: 'Hallo', footerLinks: [{ label: 'Impressum', url: 'https://e.org/i' }],
  });
  assert.equal(draftToBody({ ...draftFrom(saved), headerColor: null }, saved)['headerColor'], undefined, 'unchanged → not sent');
});

test('warnings: parsed defensively, suggestion applied to the colour field', () => {
  const ws = parseWarnings({ warnings: [
    { field: 'primaryColor', message: 'Kontrast 2.1:1', suggestion: '#005A9E' },
    { field: 'headerColor', message: 'zu hell', suggestion: 'nope' },
    null, 'x', { field: 'x' },
  ] });
  assert.deepEqual(ws, [
    { field: 'primaryColor', message: 'Kontrast 2.1:1', suggestion: '#005a9e' },
    { field: 'headerColor', message: 'zu hell', suggestion: null },
  ]);
  assert.deepEqual(parseWarnings({}), []);
  assert.deepEqual(parseWarnings(null), []);
  const d = draftFrom(saved);
  assert.equal(applySuggestion(d, ws[0]!).primaryColor, '#005a9e');
  assert.equal(applySuggestion(d, ws[0]!).useDefault.primaryColor, false, 'a taken suggestion is an explicit value');
  assert.equal(applySuggestion(d, { field: 'headerColor', message: '', suggestion: '#111111' }).headerColor, '#111111');
  assert.equal(applySuggestion(d, ws[1]!), d);
  assert.equal(applySuggestion(d, { field: 'productName', message: '', suggestion: '#111111' }), d);
});

test('400 body → field error', () => {
  assert.deepEqual(parseFieldError({ error: 'zu lang', field: 'loginText' }, 'x'), { field: 'loginText', message: 'zu lang' });
  assert.deepEqual(parseFieldError({ error: 'kaputt', field: 'evil' }, 'x'), { field: null, message: 'kaputt' });
  assert.deepEqual(parseFieldError(null, 'HTTP 500'), { field: null, message: 'HTTP 500' });
});

test('10.1 Standard-Hintergrund: only a change is sent', () => {
  const d = draftFrom(saved);
  assert.equal(d.defaultBackground, 'none');
  assert.deepEqual(draftToBody(d, saved), {});
  assert.deepEqual(draftToBody(editDraft(d, 'defaultBackground', 'builtin:forest'), saved), { defaultBackground: 'builtin:forest' });
  assert.equal(isDraftDirty(editDraft(d, 'defaultBackground', 'builtin:forest'), saved), true);
});

// ── Image changes in the draft ────────────────────────────────────────────────

const withLogo = parseAdminBranding({
  ...DEFAULT_BRANDING,
  assets: { logoLight: `/branding/assets/${'a'.repeat(64)}.png`, logoDark: null, favicon: null, loginBackground: null },
  explicit: { productName: false, primaryColor: false, headerColor: false },
});
const png = new Blob(['x'], { type: 'image/png' });

test('images: upload / remove in the draft, preview assets, revoked object URLs', () => {
  const saved = withLogo.branding.assets;
  let c: AssetChanges = {};
  c = withAssetUpload(c, 'favicon', png, 'blob:fav');
  c = withAssetUpload(c, 'logoLight', png, 'blob:logo1');
  const replaced = withAssetUpload(c, 'logoLight', png, 'blob:logo2');
  assert.deepEqual(releasedPreviewUrls(c, replaced), ['blob:logo1'], 'a replaced file frees its object URL');
  c = replaced;
  assert.deepEqual(effectiveAssets(saved, c), { ...saved, logoLight: 'blob:logo2', favicon: 'blob:fav' });

  // "Entfernen" on a pending upload drops it: the saved image shows again
  const dropped = withAssetRemoved(c, 'logoLight', saved);
  assert.equal(dropped.logoLight, undefined);
  assert.deepEqual(releasedPreviewUrls(c, dropped), ['blob:logo2']);
  // … then on the saved image marks it for removal
  const removed = withAssetRemoved(dropped, 'logoLight', saved);
  assert.deepEqual(removed.logoLight, { kind: 'remove' });
  assert.equal(effectiveAssets(saved, removed).logoLight, null);
  // an empty slot without a pending change stays unchanged
  assert.deepEqual(withAssetRemoved({}, 'logoDark', saved), {});
  assert.deepEqual(releasedPreviewUrls(c, {}).sort(), ['blob:fav', 'blob:logo2']);
});

test('images: dirty count includes image changes; status text', () => {
  const d = draftFrom(withLogo);
  assert.equal(changeCount(d, withLogo, {}), 0);
  assert.equal(dirtyStatusText(0), 'Alle Änderungen gespeichert');
  const c = withAssetRemoved(withAssetUpload({}, 'favicon', png, 'blob:f'), 'logoLight', withLogo.branding.assets);
  assert.equal(changeCount(d, withLogo, c), 2);
  assert.equal(changeCount(editDraft(d, 'loginText', 'Hallo'), withLogo, c), 3);
  assert.equal(dirtyStatusText(1), '1 ungespeicherte Änderung');
  assert.equal(dirtyStatusText(3), '3 ungespeicherte Änderungen');
});

test('"Erweitert" opens when a dark logo or an own favicon is set', () => {
  assert.equal(advancedHasOverride({ logoDark: null, favicon: null }), false);
  assert.equal(advancedHasOverride({ logoDark: '/branding/assets/x.svg', favicon: null }), true);
  assert.equal(advancedHasOverride({ logoDark: null, favicon: '/branding/assets/x.png' }), true);
});

test('save plan: image requests first (slot order), then the settings PUT only when a setting changed', () => {
  const d = draftFrom(withLogo);
  assert.deepEqual(savePlan(d, withLogo, {}), []);
  const c: AssetChanges = {
    loginBackground: { kind: 'upload', file: png, previewUrl: 'blob:bg' },
    logoLight: { kind: 'remove' },
    favicon: { kind: 'upload', file: png, previewUrl: 'blob:f' },
  };
  const plan = savePlan(editDraft(d, 'loginText', 'Hallo'), withLogo, c);
  assert.deepEqual(plan.map((s) => (s.kind === 'settings' ? 'settings' : `${s.kind}:${s.slot}`)),
    ['remove:logoLight', 'upload:favicon', 'upload:loginBackground', 'settings']);
  assert.deepEqual(plan[3], { kind: 'settings', body: { loginText: 'Hallo' } });
  assert.deepEqual(savePlan(d, withLogo, c).map((s) => s.kind), ['remove', 'upload', 'upload'], 'no settings change → no PUT');
});

test('save summary: everything saved, partial failure, nothing saved', () => {
  const up: SaveStep = { kind: 'upload', slot: 'logoLight', file: png };
  const fav: SaveStep = { kind: 'upload', slot: 'favicon', file: png };
  const settings: SaveStep = { kind: 'settings', body: { loginText: 'x' } };
  assert.deepEqual(saveSummary([{ step: up, error: null }, { step: settings, error: null }]),
    { ok: true, message: null, failedSlots: [], settingsFailed: false });
  const partial = saveSummary([{ step: up, error: 'Die SVG-Datei enthält unsichere Inhalte' }, { step: fav, error: null }, { step: settings, error: null }]);
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.failedSlots, ['logoLight']);
  assert.equal(partial.settingsFailed, false);
  assert.equal(partial.message, 'Teilweise gespeichert (Favicon, Einstellungen). Nicht gespeichert — Logo: Die SVG-Datei enthält unsichere Inhalte');
  const none = saveSummary([{ step: settings, error: 'HTTP 500' }]);
  assert.deepEqual([none.settingsFailed, none.message], [true, 'Nicht gespeichert — Einstellungen: HTTP 500']);
});
