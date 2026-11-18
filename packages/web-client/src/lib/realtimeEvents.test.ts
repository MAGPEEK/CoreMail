import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realtimePlan, parseEventData, InvalidationBatch, REALTIME_EVENTS, type QueryKey } from './realtimeEvents.ts';

test('mailbox (own): folder list, lists of the changed folders, search, message, quota', () => {
  assert.deepEqual(realtimePlan('mailbox', { mailbox: 'own', kinds: ['messages'], folderIds: ['f1', 'f2'] }).invalidate, [
    ['folders'], ['messages', 'f1'], ['messages', 'f2'], ['messages', 'search'], ['message'],
    ['user-quota'], ['user-storage'], ['recoverable'],
  ]);
});

test('mailbox: flags only → no quota; unknown folders → every list', () => {
  assert.deepEqual(realtimePlan('mailbox', { mailbox: 'own', kinds: ['flags'] }).invalidate, [['folders'], ['messages'], ['message']]);
});

test('mailbox: shared / delegated keys; a folder-list change only refreshes that folder list', () => {
  assert.deepEqual(realtimePlan('mailbox', { mailbox: 'shared:s1', kinds: ['messages'], folderIds: ['f9'] }).invalidate, [
    ['folders', 'shared:s1'], ['messages', 'f9'], ['messages', 'search'], ['message'], ['shared-mailbox-quota', 's1'],
  ]);
  assert.deepEqual(realtimePlan('mailbox', { mailbox: 'delegated:mb2', kinds: ['folders'] }).invalidate, [['folders', 'delegated:mb2']]);
  assert.deepEqual(realtimePlan('mailbox', { mailbox: 'bogus', kinds: ['folders'] }).invalidate, [['folders']], 'invalid key → own');
});

test('typed user events map to their caches', () => {
  assert.deepEqual(realtimePlan('contacts', { type: 'contacts' }).invalidate, [['contacts']]);
  assert.deepEqual(realtimePlan('notes', {}).invalidate, [['notes'], ['note-detail']]);
  assert.deepEqual(realtimePlan('tasks', {}).invalidate, [['tasks'], ['calendar-events']]);
  assert.deepEqual(realtimePlan('settings', { section: 'signature' }).invalidate, [['user-signature'], ['user', 'signature']]);
  assert.ok(realtimePlan('settings', {}).invalidate.length > 5, 'no section → every settings cache');
  assert.deepEqual(realtimePlan('quota', {}).invalidate, [['user-quota'], ['user-storage'], ['shared-mailbox-quota']]);
});

test('calendar: data refresh; share hints only for the grantee actions create / delete', () => {
  const keys: QueryKey[] = [['calendars'], ['calendar-events'], ['event'], ['calendar-shares']];
  assert.deepEqual(realtimePlan('calendar', { action: 'update', calendarIds: ['c'] }), { invalidate: keys });
  assert.equal(realtimePlan('calendar', { scope: 'shares', action: 'create' }).hint, 'Ein Kalender wurde mit dir geteilt');
  assert.equal(realtimePlan('calendar', { scope: 'shares', action: 'delete' }).hint, 'Eine Kalender-Freigabe wurde entfernt');
  assert.equal(realtimePlan('calendar', { scope: 'shares', action: 'update' }).hint, undefined);
});

test('mail:new is a hint only; branding refreshes the branding; unknown / malformed change nothing', () => {
  assert.deepEqual(realtimePlan('mail:new', { fromName: 'Ann', subject: 'Hi' }), { invalidate: [], hint: 'Ann: Hi', icon: '📧' });
  assert.equal(realtimePlan('mail:new', { fromAddr: 'a@example.test' }).hint, 'a@example.test: (Kein Betreff)');
  assert.equal(realtimePlan('mail:new', null).hint, 'Unbekannt: (Kein Betreff)');
  assert.deepEqual(realtimePlan('branding', {}), { invalidate: [], refreshBranding: true });
  assert.deepEqual(realtimePlan('nope', {}), { invalidate: [] });
  assert.deepEqual(realtimePlan('mailbox', 'garbage').invalidate, [['folders']]);
  assert.ok(REALTIME_EVENTS.includes('mailbox'));
});

test('parseEventData: JSON or null', () => {
  assert.deepEqual(parseEventData('{"a":1}'), { a: 1 });
  assert.equal(parseEventData('{'), null);
  assert.equal(parseEventData(undefined), null);
});

test('InvalidationBatch: coalesces duplicate keys of a burst into one flush', () => {
  const flushed: QueryKey[][] = [];
  let pending: (() => void) | null = null;
  const batch = new InvalidationBatch((k) => flushed.push(k), 250, (fn) => { pending = fn; return 1; }, () => { pending = null; });
  batch.add([['folders'], ['messages', 'f1']]);
  batch.add([['folders']]);
  assert.equal(flushed.length, 0);
  pending!();
  assert.deepEqual(flushed, [[['folders'], ['messages', 'f1']]]);
  batch.add([['notes']]);
  batch.dispose();
  assert.equal(pending, null);
  assert.equal(flushed.length, 1);
});

test('hintPresentation: new-mail setting (toast / sound once per browser / none), other hints toast in visible tabs', async () => {
  const { hintPresentation } = await import('./realtimeEvents.ts');
  const mail = realtimePlan('mail:new', { fromAddr: 'a@b.c', subject: 'Hi' });
  const opts = (style: 'toast' | 'sound' | 'none', visible: boolean, fromStream: boolean) => ({ style, visible, fromStream });
  assert.equal(hintPresentation('mail:new', mail, opts('toast', true, false)), 'toast');
  assert.equal(hintPresentation('mail:new', mail, opts('toast', false, true)), null, 'hidden tab: no toast');
  assert.equal(hintPresentation('mail:new', mail, opts('sound', true, true)), 'sound');
  assert.equal(hintPresentation('mail:new', mail, opts('sound', true, false)), null, 'forwarded event: the leader already played it');
  assert.equal(hintPresentation('mail:new', mail, opts('none', true, true)), null);
  const share = realtimePlan('calendar', { scope: 'shares', action: 'create' });
  assert.equal(hintPresentation('calendar', share, opts('none', true, false)), 'toast', 'the mail setting does not silence other hints');
  assert.equal(hintPresentation('contacts', realtimePlan('contacts', {}), opts('toast', true, true)), null, 'no hint');
});
