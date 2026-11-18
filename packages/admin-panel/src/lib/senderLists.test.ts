import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterEntries, importErrorText, linesToList, envOverrideNote, dnsblActionOptions, patternPlaceholder, spoofFormFrom, spoofPayload,
  type SenderListEntry,
} from './senderLists.ts';

const e = (over: Partial<SenderListEntry>): SenderListEntry => ({
  id: 'x', listType: 'BLOCK', scope: 'GLOBAL', scopeId: null, target: '', patternType: 'EXACT',
  pattern: 'a@spam.example', comment: '', active: true, ...over,
});

test('filterEntries: by list type and search text (pattern, target, comment)', () => {
  const all = [e({ id: '1' }), e({ id: '2', listType: 'ALLOW', pattern: 'boss@partner.example' }),
    e({ id: '3', scope: 'USER', target: 'bob@corp.test', pattern: 'x@y.example' }), e({ id: '4', comment: 'Rechnung-Spam' })];
  assert.deepEqual(filterEntries(all, 'BLOCK').map((x) => x.id), ['1', '3', '4']);
  assert.deepEqual(filterEntries(all, 'ALLOW').map((x) => x.id), ['2']);
  assert.deepEqual(filterEntries(all, 'BLOCK', ' BOB@ ').map((x) => x.id), ['3']);
  assert.deepEqual(filterEntries(all, 'BLOCK', 'rechnung').map((x) => x.id), ['4']);
});

test('importErrorText: at most five lines, rest counted', () => {
  const errs = Array.from({ length: 7 }, (_, i) => ({ line: i + 2, error: 'kaputt' }));
  const text = importErrorText(errs);
  assert.equal(text.split('\n').length, 6);
  assert.match(text, /^Zeile 2: kaputt/);
  assert.match(text, /… und 2 weitere$/);
  assert.equal(importErrorText([{ line: 0, error: 'zu groß' }]), 'zu groß');
});

test('linesToList: lines and commas, trimmed, de-duplicated', () => {
  assert.deepEqual(linesToList(' 203.0.113.0/24\nmailer.example, mailer.example\n\n'), ['203.0.113.0/24', 'mailer.example']);
});

test('envOverrideNote names the variable', () => {
  assert.equal(envOverrideNote(undefined), null);
  assert.match(envOverrideNote('LOCAL_SPOOF_ACTION')!, /LOCAL_SPOOF_ACTION/);
});

test('DNSBL action options: Score disabled without rspamd, kept in the list', () => {
  assert.deepEqual(dnsblActionOptions(false).map((o) => [o.value, o.disabled]), [['REJECT', false], ['TAG', false], ['SCORE_ONLY', false]]);
  const absent = dnsblActionOptions(true).find((o) => o.value === 'SCORE_ONLY')!;
  assert.equal(absent.disabled, true);
  assert.match(absent.label, /nur mit Rspamd/);
});

test('pattern placeholders per type', () => {
  assert.match(patternPlaceholder('WILDCARD'), /^\*@/);
  assert.match(patternPlaceholder('EXACT'), /@/);
});

test('spoofing form: environment-set fields show the value in effect and are not saved', () => {
  const view = {
    localSpoofAction: 'junk' as const, localSpoofAllow: ['198.51.100.1'], arcTrustedSealers: ['a.example'],
    effective: { action: 'reject' as const, allow: ['198.51.100.1'], arcTrustedSealers: ['b.example', 'c.example'] },
    envOverrides: [{ field: 'localSpoofAction' as const, variable: 'LOCAL_SPOOF_ACTION' }, { field: 'arcTrustedSealers' as const, variable: 'ARC_TRUSTED_SEALERS' }],
  };
  const form = spoofFormFrom(view);
  assert.deepEqual(form, { action: 'reject', allow: '198.51.100.1', sealers: 'b.example\nc.example' });
  assert.deepEqual(spoofPayload({ ...form, allow: '198.51.100.1\n203.0.113.0/24' }, ['localSpoofAction', 'arcTrustedSealers']),
    { localSpoofAllow: ['198.51.100.1', '203.0.113.0/24'] });
  assert.deepEqual(spoofPayload(form, []), {
    localSpoofAction: 'reject', localSpoofAllow: ['198.51.100.1'], arcTrustedSealers: ['b.example', 'c.example'],
  });
});
