import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFERENCES, applyPatch, bridgedDiff, bridgedFromPrefs, isEmptyPatch, localToPatch, mergePatches,
  jwtSubject, normalizePreferences, persistedState,
} from './preferences.ts';
import { PatchQueue } from './patchQueue.ts';

test('normalizePreferences: defaults for garbage, wrong kinds dropped, cache owner fields kept', () => {
  assert.deepEqual(normalizePreferences(null), DEFAULT_PREFERENCES);
  const p = normalizePreferences({
    migratedAt: '2026-01-01T00:00:00Z',
    view: { density: 'compact', readingPane: 7, unknown: 1 },
    theme: { accentRgb: null, mode: 'dark' },
    calendar: { defaultReminderMinutes: null, workDays: 'mon' },
  });
  assert.equal(p.migratedAt, '2026-01-01T00:00:00Z');
  assert.equal(p.view.density, 'compact');
  assert.equal(p.view.readingPane, 'right');
  assert.equal('unknown' in p.view, false);
  assert.equal(p.theme.mode, 'dark');
  assert.equal(p.calendar.defaultReminderMinutes, null);
  assert.deepEqual(p.calendar.workDays, [1, 2, 3, 4, 5]);
  // the defaults object itself is never mutated
  p.calendar.workDays.push(0);
  assert.deepEqual(DEFAULT_PREFERENCES.calendar.workDays, [1, 2, 3, 4, 5]);
});

test('applyPatch / mergePatches follow the server rules', () => {
  let p = applyPatch(DEFAULT_PREFERENCES, { view: { sortBy: 'from' }, signatures: { defaults: { own: { newId: 'a', replyId: null } } } });
  assert.equal(p.view.sortBy, 'from');
  assert.equal(p.view.density, 'normal');
  p = applyPatch(p, { signatures: { defaults: { 'shared:t': { newId: 'b', replyId: null } } } });
  assert.deepEqual(Object.keys(p.signatures.defaults).sort(), ['own', 'shared:t']);
  p = applyPatch(p, { signatures: { defaults: { own: { newId: null, replyId: null } } } });
  assert.deepEqual(Object.keys(p.signatures.defaults), ['shared:t']);
  assert.deepEqual(
    mergePatches({ view: { density: 'compact' }, signatures: { defaults: { own: { newId: 'a', replyId: null } } } },
      { view: { density: 'normal', sortDir: 'asc' }, signatures: { defaults: { 'shared:x': { newId: 'b', replyId: null } } } }),
    { view: { density: 'normal', sortDir: 'asc' }, signatures: { defaults: { own: { newId: 'a', replyId: null }, 'shared:x': { newId: 'b', replyId: null } } } },
  );
  assert.equal(isEmptyPatch({}), true);
  assert.equal(isEmptyPatch({ view: {} }), true);
  assert.equal(isEmptyPatch({ view: { density: 'compact' } }), false);
});

test('localToPatch imports only valid pre-9.4 browser values', () => {
  const ui = persistedState(JSON.stringify({ state: {
    density: 'compact', readingPane: 'bottom', groupByConversation: true, shortcutSet: 'gmail', sendDelaySec: 7,
    calendarShowWeekNumbers: false, hiddenCalendarIds: ['cal1', 'bad id', 3], favoritesCollapsed: true,
  } }));
  const patch = localToPatch(ui, { theme: 'dark', accentRgb: '16 124 16' }, { lang: 'en' });
  assert.deepEqual(patch, {
    view: { density: 'compact', readingPane: 'bottom', groupByConversation: true, shortcutSet: 'gmail' },
    theme: { mode: 'dark', accentRgb: '16 124 16' },
    regional: { language: 'en' },
    calendar: { showWeekNumbers: false, hiddenCalendarIds: ['cal1'] },
  });
  assert.deepEqual(localToPatch({}, { accentRgb: '#fff' }, { lang: 'fr' }), {});
  assert.deepEqual(localToPatch({}, { accentRgb: null }, {}), { theme: { accentRgb: null } });
  assert.deepEqual(persistedState('not json'), {});
  assert.deepEqual(persistedState(null), {});
});

test('bridgedDiff: only changed bridged values become a patch', () => {
  const a = bridgedFromPrefs(DEFAULT_PREFERENCES);
  assert.deepEqual(bridgedDiff(a, { ...a }), {});
  assert.deepEqual(bridgedDiff(a, { ...a, density: 'compact', lang: 'en', accentRgb: '1 2 3' }), {
    view: { density: 'compact' }, theme: { accentRgb: '1 2 3' }, regional: { language: 'en' },
  });
  assert.deepEqual(bridgedDiff({ ...a, accentRgb: '1 2 3' }, { ...a, accentRgb: null }), { theme: { accentRgb: null } });
  assert.deepEqual(bridgedDiff(a, { ...a, hiddenCalendarIds: ['x'] }), { calendar: { hiddenCalendarIds: ['x'] } });
});

// ── PatchQueue ───────────────────────────────────────────────────────────────

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
afterEach(() => { mock.timers.reset(); });
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => queueMicrotask(r)); };

test('PatchQueue: debounced, merged into one PATCH', async () => {
  const sent: unknown[] = [];
  const q = new PatchQueue({ delayMs: 800, retryMs: 30_000, send: async (p) => { sent.push(p); } });
  q.push({ view: { density: 'compact' } });
  mock.timers.tick(500);
  q.push({ view: { sortBy: 'size' } });
  mock.timers.tick(500);
  assert.equal(sent.length, 0);
  mock.timers.tick(300);
  await settle();
  assert.deepEqual(sent, [{ view: { density: 'compact', sortBy: 'size' } }]);
  assert.equal(q.hasPending, false);
});

test('PatchQueue: a failed send is kept and retried; newer values win', async () => {
  const sent: unknown[] = [];
  let fail = true;
  const q = new PatchQueue({ delayMs: 100, retryMs: 1000, send: async (p) => { sent.push(p); if (fail) throw new Error('offline'); } });
  q.push({ view: { density: 'compact', sortBy: 'from' } });
  mock.timers.tick(100);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(q.hasPending, true);
  fail = false;
  q.push({ view: { sortBy: 'size' } });
  mock.timers.tick(1000);
  await settle();
  assert.deepEqual(sent[sent.length - 1], { view: { density: 'compact', sortBy: 'size' } });
  assert.equal(q.hasPending, false);
});

test('PatchQueue: flush sends at once; stop drops pending changes', async () => {
  const sent: unknown[] = [];
  const q = new PatchQueue({ delayMs: 800, retryMs: 1000, send: async (p) => { sent.push(p); } });
  q.push({ theme: { mode: 'dark' } });
  await q.flush();
  assert.deepEqual(sent, [{ theme: { mode: 'dark' } }]);
  q.push({ theme: { mode: 'light' } });
  q.stop();
  mock.timers.tick(5000);
  await settle();
  assert.equal(sent.length, 1);
  q.push({});
  assert.equal(q.hasPending, false);
});

test('PatchQueue: nothing is sent before the server copy was loaded (isReady)', async () => {
  const sent: unknown[] = [];
  let ready = false;
  const q = new PatchQueue({ delayMs: 100, retryMs: 1000, isReady: () => ready, send: async (p) => { sent.push(p); } });
  q.push({ theme: { mode: 'dark' } });
  mock.timers.tick(100);
  await q.flush();
  assert.equal(sent.length, 0);
  assert.deepEqual(q.pendingPatch, { theme: { mode: 'dark' } });
  ready = true;
  mock.timers.tick(1000);
  await settle();
  assert.deepEqual(sent, [{ theme: { mode: 'dark' } }]);
  assert.deepEqual(q.pendingPatch, {});
});

test('jwtSubject reads base64url payloads; garbage → null', () => {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  // "?>>" encodes to base64url with "-" / "_" — plain atob refuses those
  const tricky = seg({ sub: 'u1', n: '?>>~~~' });
  assert.match(tricky, /[-_]/);
  assert.equal(jwtSubject(`h.${tricky}.s`), 'u1');
  assert.equal(jwtSubject(`h.${seg({ sub: 42 })}.s`), null);
  assert.equal(jwtSubject('nope'), null);
  assert.equal(jwtSubject(null), null);
});
