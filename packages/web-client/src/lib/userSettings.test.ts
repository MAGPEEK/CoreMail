import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatTime, formatListDate, formatDateTime, zonedParts, type RegionalSettings } from './regionalFormat.ts';
import { autoReadDelayMs, receiptAction, receiptRequestOption, MDN_SENT_FLAG } from './readBehaviour.ts';
import { conversationKey, orderForDisplay, sortParams } from './conversationOrder.ts';
import { attachmentKeyword, needsAttachmentReminder } from './attachmentReminder.ts';
import { mailPath, parseMailPath, calendarEventPath, contactPath, itemIdFromPath } from './mailLinks.ts';
import { describeUserAgent } from './sessionDevice.ts';
import { businessHours, hiddenDaysForWorkWeek, slotDuration } from './calendarPrefs.ts';
import { defaultSignatureHtml, signatureIdentity } from './signaturePick.ts';

test('calendar settings → FullCalendar options', () => {
  assert.deepEqual(hiddenDaysForWorkWeek([1, 2, 3, 4, 5]), [0, 6]);
  assert.deepEqual(hiddenDaysForWorkWeek([0, 1, 2, 3, 4]), [5, 6]);
  assert.deepEqual(hiddenDaysForWorkWeek([]), []);
  assert.equal(slotDuration(15), '00:15:00');
  assert.equal(slotDuration(60), '01:00:00');
  assert.equal(slotDuration(1), '00:05:00');
  assert.deepEqual(businessHours({ workDays: [1, 2], workStart: '08:00', workEnd: '17:00' }), { daysOfWeek: [1, 2], startTime: '08:00', endTime: '17:00' });
  assert.equal(businessHours({ workDays: [1], workStart: '18:00', workEnd: '08:00' }), false);
  assert.equal(businessHours({ workDays: [], workStart: '08:00', workEnd: '17:00' }), false);
});

test('signature pick: per identity and kind; deleted or unset → none', () => {
  const sigs = [{ id: 'a', name: 'A', html: '<p>A</p>' }, { id: 'b', name: 'B', html: '<p>B</p>' }];
  const defaults = { own: { newId: 'a', replyId: 'b' }, 'shared:t1': { newId: 'b', replyId: null } };
  assert.equal(signatureIdentity({ kind: 'own' }, false), 'own');
  assert.equal(signatureIdentity({ kind: 'shared', id: 't1' }, true), 'shared:t1');
  assert.equal(signatureIdentity({ kind: 'shared', id: 't1' }, false), 'own');
  assert.equal(signatureIdentity({ kind: 'delegated', id: 'x' }, true), 'own');
  assert.equal(defaultSignatureHtml(sigs, defaults, 'own', false), '<p>A</p>');
  assert.equal(defaultSignatureHtml(sigs, defaults, 'own', true), '<p>B</p>');
  assert.equal(defaultSignatureHtml(sigs, defaults, 'shared:t1', true), '');
  assert.equal(defaultSignatureHtml(sigs, defaults, 'shared:zz', false), '');
  assert.equal(defaultSignatureHtml([], defaults, 'own', false), '');
});

const r = (o: Partial<RegionalSettings> = {}): RegionalSettings => ({ language: 'de', timeZone: 'UTC', dateFormat: 'dd.MM.yyyy', timeFormat: '24h', ...o });

test('regional formatting: zone, date patterns, 12/24 h', () => {
  const d = new Date('2026-03-09T23:30:00Z');
  assert.equal(formatDate(d, r()), '09.03.2026');
  assert.equal(formatDate(d, r({ timeZone: 'Europe/Berlin' })), '10.03.2026');
  assert.equal(formatDate(d, r({ dateFormat: 'yyyy-MM-dd' })), '2026-03-09');
  assert.equal(formatDate(d, r({ dateFormat: 'MM/dd/yyyy' })), '03/09/2026');
  assert.equal(formatDate(d, r({ dateFormat: 'd. MMM yyyy', language: 'en' })), '9. Mar 2026');
  assert.equal(formatTime(d, r()), '23:30');
  assert.equal(formatTime(d, r({ timeFormat: '12h' })), '11:30 PM');
  assert.equal(formatTime(new Date('2026-03-09T00:05:00Z'), r({ timeFormat: '12h' })), '12:05 AM');
  assert.equal(formatDateTime(d, r({ timeZone: 'America/New_York' })), '09.03.2026 19:30');
  assert.equal(zonedParts(new Date('2026-01-01T00:00:00Z'), 'UTC').hour, 0);
});

test('formatListDate: today → time, yesterday → label, else date (user zone)', () => {
  const now = new Date('2026-03-10T10:00:00Z');
  assert.equal(formatListDate(new Date('2026-03-10T08:15:00Z'), now, r(), 'Gestern'), '08:15');
  assert.equal(formatListDate(new Date('2026-03-09T08:15:00Z'), now, r(), 'Gestern'), 'Gestern');
  assert.equal(formatListDate(new Date('2026-03-01T08:15:00Z'), now, r(), 'Gestern'), '01.03.2026');
  // 23:30 UTC on the 9th is already the 10th in Berlin
  assert.equal(formatListDate(new Date('2026-03-09T23:30:00Z'), now, r({ timeZone: 'Europe/Berlin' }), 'Gestern'), '00:30');
});

test('autoReadDelayMs', () => {
  assert.equal(autoReadDelayMs('immediately', 5, false, false), 0);
  assert.equal(autoReadDelayMs('delay', 5, false, false), 5000);
  assert.equal(autoReadDelayMs('delay', 0, false, false), 1000);
  assert.equal(autoReadDelayMs('delay', 999, false, false), 120_000);
  assert.equal(autoReadDelayMs('manual', 5, false, false), null);
  assert.equal(autoReadDelayMs('immediately', 5, true, false), null);
  assert.equal(autoReadDelayMs('immediately', 5, false, true), null);
});

test('receiptAction: policy, own mailbox only, junk and answered never, always only to the sender domain', () => {
  const ctx = { requestedBy: 'a@ext.example', flags: [], ownMailbox: true, inJunk: false, fromAddr: 'a@ext.example' };
  assert.equal(receiptAction('ask', ctx), 'ask');
  assert.equal(receiptAction('never', ctx), 'none');
  assert.equal(receiptAction('always', ctx), 'sendAutomatically');
  assert.equal(receiptAction('always', { ...ctx, requestedBy: 'tracker@other.example' }), 'ask');
  assert.equal(receiptAction('ask', { ...ctx, requestedBy: null }), 'none');
  assert.equal(receiptAction('ask', { ...ctx, flags: [MDN_SENT_FLAG] }), 'none');
  assert.equal(receiptAction('ask', { ...ctx, ownMailbox: false }), 'none');
  assert.equal(receiptAction('always', { ...ctx, inJunk: true }), 'none');
  assert.deepEqual(receiptRequestOption('never'), { visible: false, checked: false });
  assert.deepEqual(receiptRequestOption('ask'), { visible: true, checked: false });
  assert.deepEqual(receiptRequestOption('always'), { visible: true, checked: true });
});

test('conversation order: grouped at the first message position, inner order per setting', () => {
  const msgs = [
    { id: '1', subject: 'Re: Plan', date: '2026-01-03T00:00:00Z' },
    { id: '2', subject: 'Other', date: '2026-01-02T12:00:00Z' },
    { id: '3', subject: 'Plan', date: '2026-01-01T00:00:00Z' },
    { id: '4', subject: 'AW: re: plan', date: '2026-01-02T00:00:00Z' },
  ];
  assert.deepEqual(orderForDisplay(msgs, false, 'newestFirst').map((m) => m.id), ['1', '2', '3', '4']);
  assert.deepEqual(orderForDisplay(msgs, true, 'newestFirst').map((m) => m.id), ['1', '4', '3', '2']);
  assert.deepEqual(orderForDisplay(msgs, true, 'oldestFirst').map((m) => m.id), ['3', '4', '1', '2']);
  assert.equal(conversationKey('Fwd: WG: Hallo'), 'hallo');
  assert.equal(sortParams('from', 'asc'), 'sort=from&dir=asc');
  assert.equal(sortParams('date', 'x'), 'sort=date&dir=desc');
});

test('attachment reminder: DE/EN words in subject or own text, quotes ignored', () => {
  assert.equal(attachmentKeyword('Angebot', '<p>Im Anhang findest du das Angebot.</p>'), 'anhang');
  assert.equal(attachmentKeyword('Report attached', '<p>hi</p>'), 'attached');
  assert.equal(attachmentKeyword('Hallo', '<p>Danke!</p><blockquote>siehe Anhang</blockquote>'), null);
  assert.equal(attachmentKeyword('Hallo', '<p>Anhangslos</p>'), null);
  assert.equal(needsAttachmentReminder(true, 1, 'Anhang', ''), null);
  assert.equal(needsAttachmentReminder(false, 0, 'Anhang', ''), null);
  assert.equal(needsAttachmentReminder(true, 0, 'Anbei die Datei', ''), 'anbei');
});

test('deep links: build + parse, invalid parts dropped', () => {
  const shared = { kind: 'shared' as const, id: 'team1' };
  assert.equal(mailPath({ kind: 'own' }), '/mail');
  assert.equal(mailPath(shared), '/mail/shared%3Ateam1');
  assert.equal(mailPath({ kind: 'own' }, 'f1', 'm1'), '/mail/own/f1/m1');
  assert.equal(mailPath(shared, 'f1'), '/mail/shared%3Ateam1/f1');
  assert.deepEqual(parseMailPath('/mail/shared%3Ateam1/f1/m1'), { mailbox: shared, folderId: 'f1', messageId: 'm1' });
  assert.deepEqual(parseMailPath('/mail/shared:team1/f1'), { mailbox: shared, folderId: 'f1', messageId: null });
  assert.deepEqual(parseMailPath('/mail'), { mailbox: { kind: 'own' }, folderId: null, messageId: null });
  assert.deepEqual(parseMailPath('/mail/own/f1/<script>'), { mailbox: { kind: 'own' }, folderId: 'f1', messageId: null });
  assert.deepEqual(parseMailPath('/mail/bogus:x/f1'), { mailbox: { kind: 'own' }, folderId: 'f1', messageId: null });
  assert.equal(parseMailPath('/calendar'), null);
  assert.equal(calendarEventPath('ev1'), '/calendar/event/ev1');
  assert.equal(itemIdFromPath('/calendar/event/ev1', '/calendar/event/'), 'ev1');
  assert.equal(itemIdFromPath(contactPath('c 1'), '/contacts/'), null);
  assert.equal(itemIdFromPath('/contacts/c1', '/contacts/'), 'c1');
});

test('describeUserAgent', () => {
  assert.equal(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0'), 'Firefox · Windows');
  assert.equal(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari · iOS');
  assert.equal(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0'), 'Edge · macOS');
  assert.equal(describeUserAgent(''), 'Unbekanntes Gerät');
});
