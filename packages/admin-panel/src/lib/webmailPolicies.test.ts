import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBMAIL_FEATURES, draftFromView, formatExtensions, isEmptyPatch, parseExtensionText, patchFromDraft,
  type WebmailPolicyView,
} from './webmailPolicies.ts';

const all = <T>(v: T) => Object.fromEntries(WEBMAIL_FEATURES.map((f) => [f, v])) as Record<typeof WEBMAIL_FEATURES[number], T>;
const content = { blockedExtensions: ['exe'], downloadOnlyExtensions: [], maxUploadMb: 20, externalImages: 'ask' as const };

function view(level: WebmailPolicyView['level'], settings: Partial<WebmailPolicyView['settings']['content']> = {}): WebmailPolicyView {
  const own = level === 'global'
    ? { ...content, ...settings }
    : { blockedExtensions: null, downloadOnlyExtensions: null, maxUploadMb: null, externalImages: null, ...settings };
  return {
    level, features: [...WEBMAIL_FEATURES],
    settings: { features: all(level === 'global' ? 'on' : 'inherit'), content: own },
    inherited: { features: all(true), content },
    effective: { features: all(true), content },
    sources: { features: all('default'), content: { blockedExtensions: 'global', downloadOnlyExtensions: 'default', maxUploadMb: 'global', externalImages: 'default' } },
  };
}

test('extension lists: parsed tolerant, formatted for the text field', () => {
  assert.deepEqual(parseExtensionText(' EXE, .js;bat  exe ,, a/b'), ['exe', 'js', 'bat']);
  assert.equal(formatExtensions(['exe', 'js']), 'exe, js');
});

test('an untouched draft sends nothing — server, domain and mailbox level', () => {
  for (const level of ['global', 'domain', 'user'] as const) {
    const v = view(level);
    const r = patchFromDraft(v, draftFromView(v));
    assert.ok(r.ok && isEmptyPatch(r.patch), level);
  }
});

test('below the server level: inherit shows the broader value, an own value is sent', () => {
  const v = view('domain');
  const d = draftFromView(v);
  assert.deepEqual(d.blockedExtensions, { inherit: true, text: 'exe' });
  assert.equal(d.externalImages, 'inherit');
  d.blockedExtensions = { inherit: false, text: 'exe, js' };
  d.externalImages = 'block';
  d.features.calendar = 'off';
  const r = patchFromDraft(v, d);
  assert.deepEqual(r, { ok: true, patch: { features: { calendar: 'off' }, content: { blockedExtensions: ['exe', 'js'], externalImages: 'block' } } });
});

test('back to inherit sends null; the server level clears its upload limit with an empty field', () => {
  const d = view('user', { blockedExtensions: ['zip'], maxUploadMb: 5 });
  const draft = draftFromView(d);
  draft.blockedExtensions.inherit = true;
  draft.maxUploadMb.inherit = true;
  assert.deepEqual(patchFromDraft(d, draft), { ok: true, patch: { content: { blockedExtensions: null, maxUploadMb: null } } });
  const g = view('global');
  const gd = draftFromView(g);
  gd.maxUploadMb.text = '';
  assert.deepEqual(patchFromDraft(g, gd), { ok: true, patch: { content: { maxUploadMb: null } } });
});

test('invalid upload limits are refused before saving', () => {
  const v = view('global');
  for (const text of ['0', '-3', '1.5', 'abc', '99999']) {
    const d = draftFromView(v);
    d.maxUploadMb.text = text;
    assert.deepEqual(patchFromDraft(v, d), { ok: false, error: 'maxUploadMb' }, text);
  }
});
