/**
 * 9.4 roaming preferences: tolerant read, strict patch, merge rules.
 * Run: node --import tsx --test src/lib/user-preferences.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFERENCES, PreferencesPatchSchema, applyPreferencesPatch, isTimeZone, readPreferences, withoutSignature,
} from './user-preferences.js';

test('readPreferences: never written → defaults, not migrated', () => {
  const p = readPreferences({});
  assert.deepEqual(p, DEFAULT_PREFERENCES);
  assert.equal(p.migratedAt, null);
  assert.deepEqual(readPreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences('garbage'), DEFAULT_PREFERENCES);
});

test('readPreferences: invalid fields fall back one by one, unknown keys dropped', () => {
  const p = readPreferences({
    migratedAt: '2026-01-01T00:00:00.000Z',
    view: { density: 'compact', readingPane: 'sideways', extra: 1 },
    theme: 'dark',
    calendar: { workDays: [1, 1], weekStart: 6 },
    unknown: { a: 1 },
  });
  assert.equal(p.migratedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(p.view.density, 'compact');
  assert.equal(p.view.readingPane, 'right');
  assert.equal('extra' in p.view, false);
  assert.deepEqual(p.theme, DEFAULT_PREFERENCES.theme);
  assert.deepEqual(p.calendar.workDays, [1, 2, 3, 4, 5]);
  assert.equal(p.calendar.weekStart, 6);
  assert.equal('unknown' in p, false);
});

test('readPreferences does not share array/object instances with the defaults', () => {
  const p = readPreferences({});
  p.calendar.workDays.push(6);
  assert.deepEqual(DEFAULT_PREFERENCES.calendar.workDays, [1, 2, 3, 4, 5]);
});

test('PreferencesPatchSchema: strict — unknown sections/fields and bad values refused', () => {
  assert.equal(PreferencesPatchSchema.safeParse({ view: { density: 'compact' } }).success, true);
  assert.equal(PreferencesPatchSchema.safeParse({ nope: {} }).success, false);
  assert.equal(PreferencesPatchSchema.safeParse({ view: { nope: 1 } }).success, false);
  assert.equal(PreferencesPatchSchema.safeParse({ view: { sendDelaySec: 7 } }).success, false);
  assert.equal(PreferencesPatchSchema.safeParse({ theme: { accentRgb: '0 120 212' } }).success, true);
  assert.equal(PreferencesPatchSchema.safeParse({ theme: { accentRgb: '#0078d4' } }).success, false);
  assert.equal(PreferencesPatchSchema.safeParse({ regional: { timeZone: 'Europe/Berlin' } }).success, true);
  assert.equal(PreferencesPatchSchema.safeParse({ regional: { timeZone: 'Mars/Olympus' } }).success, false);
  assert.equal(PreferencesPatchSchema.safeParse({ calendar: { workStart: '25:00' } }).success, false);
  assert.equal(PreferencesPatchSchema.safeParse({ calendar: { hiddenCalendarIds: ['a b'] } }).success, false);
  assert.equal(PreferencesPatchSchema.safeParse({ reading: { markReadDelaySec: 0 } }).success, false);
  assert.equal(PreferencesPatchSchema.safeParse({ signatures: { defaults: { 'delegated:x': { newId: null, replyId: null } } } }).success, false);
  assert.equal(PreferencesPatchSchema.safeParse({ signatures: { defaults: { 'shared:abc': { newId: 's1', replyId: null } } } }).success, true);
});

test('compose.composeFormatBar: default on, a boolean only, roams through a patch', () => {
  assert.equal(DEFAULT_PREFERENCES.compose.composeFormatBar, true);
  assert.equal(readPreferences({ compose: { format: 'plain' } }).compose.composeFormatBar, true, 'stored before the field existed');
  assert.equal(readPreferences({ compose: { composeFormatBar: false } }).compose.composeFormatBar, false);
  assert.equal(readPreferences({ compose: { composeFormatBar: 'off' } }).compose.composeFormatBar, true);
  assert.equal(PreferencesPatchSchema.safeParse({ compose: { composeFormatBar: false } }).success, true);
  assert.equal(PreferencesPatchSchema.safeParse({ compose: { composeFormatBar: 'off' } }).success, false);
  const p = applyPreferencesPatch(readPreferences({}), { compose: { composeFormatBar: false } }, new Date('2026-02-03T04:05:06Z'));
  assert.equal(p.compose.composeFormatBar, false);
  assert.equal(p.compose.format, 'html');
});

test('applyPreferencesPatch: fields replace, other sections stay, migratedAt set once', () => {
  const now = new Date('2026-02-03T04:05:06Z');
  const a = applyPreferencesPatch(readPreferences({}), { view: { density: 'compact' }, regional: { language: 'en' } }, now);
  assert.equal(a.view.density, 'compact');
  assert.equal(a.view.readingPane, 'right');
  assert.equal(a.regional.language, 'en');
  assert.equal(a.migratedAt, now.toISOString());
  const b = applyPreferencesPatch(a, { view: { readingPane: 'bottom' } }, new Date('2027-01-01T00:00:00Z'));
  assert.equal(b.view.density, 'compact');
  assert.equal(b.migratedAt, now.toISOString());
});

test('applyPreferencesPatch: signature defaults merge per identity; empty entry removed', () => {
  let p = applyPreferencesPatch(readPreferences({}), { signatures: { defaults: { own: { newId: 's1', replyId: 's2' } } } });
  p = applyPreferencesPatch(p, { signatures: { defaults: { 'shared:t1': { newId: 's3', replyId: null } } } });
  assert.deepEqual(p.signatures.defaults, { own: { newId: 's1', replyId: 's2' }, 'shared:t1': { newId: 's3', replyId: null } });
  p = applyPreferencesPatch(p, { signatures: { defaults: { 'shared:t1': { newId: null, replyId: null } } } });
  assert.deepEqual(p.signatures.defaults, { own: { newId: 's1', replyId: 's2' } });
});

test('withoutSignature clears only the references to the deleted signature', () => {
  const p = applyPreferencesPatch(readPreferences({}), {
    signatures: { defaults: { own: { newId: 's1', replyId: 's2' }, 'shared:t': { newId: 's2', replyId: null } } },
  });
  assert.deepEqual(withoutSignature(p, 's2'), {
    signatures: { defaults: { own: { newId: 's1', replyId: null }, 'shared:t': { newId: null, replyId: null } } },
  });
  assert.equal(withoutSignature(p, 'zzz'), null);
});

test('isTimeZone', () => {
  assert.equal(isTimeZone(''), true);
  assert.equal(isTimeZone('UTC'), true);
  assert.equal(isTimeZone('America/New_York'), true);
  assert.equal(isTimeZone('Not/AZone'), false);
});
