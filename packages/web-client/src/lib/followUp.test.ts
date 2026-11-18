import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFlagReminder, flagPresetDates, followUpStatusOf, isOverdue, relativeDueDay } from './followUp.ts';
import { combineItems, formatWorkHours, parseWorkHours } from './taskItems.ts';
import { eventReminderItems, flagReminderItems } from './reminderSources.ts';

const TZ = 'Europe/Berlin';
const WORK = [1, 2, 3, 4, 5];
// Wednesday 11 March 2026, 14:00 Berlin
const NOW = new Date('2026-03-11T13:00:00Z');

test('flagPresetDates: Heute, Morgen, Diese Woche, Nächste Woche, Kein Datum (local midnight)', () => {
  assert.deepEqual(flagPresetDates('today', NOW, TZ, WORK), { startAt: '2026-03-10T23:00:00.000Z', dueAt: '2026-03-10T23:00:00.000Z' });
  assert.deepEqual(flagPresetDates('tomorrow', NOW, TZ, WORK), { startAt: '2026-03-11T23:00:00.000Z', dueAt: '2026-03-11T23:00:00.000Z' });
  assert.deepEqual(flagPresetDates('thisWeek', NOW, TZ, WORK), { startAt: '2026-03-10T23:00:00.000Z', dueAt: '2026-03-12T23:00:00.000Z' });
  assert.deepEqual(flagPresetDates('nextWeek', NOW, TZ, WORK), { startAt: '2026-03-15T23:00:00.000Z', dueAt: '2026-03-19T23:00:00.000Z' });
  assert.deepEqual(flagPresetDates('noDate', NOW, TZ, WORK), { startAt: null, dueAt: null });
});

test('flagPresetDates: on a Saturday "Diese Woche" is due today; DST week of next week', () => {
  const saturday = new Date('2026-03-21T10:00:00Z');
  const thisWeek = flagPresetDates('thisWeek', saturday, TZ, WORK);
  assert.equal(thisWeek.dueAt, thisWeek.startAt);
  // next week starts Monday 23 March, ends Friday 27 March (still CET)
  assert.deepEqual(flagPresetDates('nextWeek', saturday, TZ, WORK), { startAt: '2026-03-22T23:00:00.000Z', dueAt: '2026-03-26T23:00:00.000Z' });
  // week after the DST change (29 March): Friday 3 April is CEST
  assert.equal(flagPresetDates('nextWeek', new Date('2026-03-28T10:00:00Z'), TZ, WORK).dueAt, '2026-04-02T22:00:00.000Z');
});

test('followUpStatusOf / isOverdue / relativeDueDay / default reminder', () => {
  assert.equal(followUpStatusOf({ flags: ['\\Flagged'] }), 'flagged');
  assert.equal(followUpStatusOf({ flags: [], flagStatus: 'complete' }), 'complete');
  assert.equal(followUpStatusOf({ flags: [], flagStatus: 'none' }), 'none');
  assert.equal(isOverdue('2026-03-09T23:00:00.000Z', NOW, TZ), true);
  assert.equal(isOverdue('2026-03-10T23:00:00.000Z', NOW, TZ), false, 'due today is not overdue');
  assert.equal(isOverdue(null, NOW, TZ), false);
  assert.equal(relativeDueDay('2026-03-11T23:00:00.000Z', NOW, TZ), 'tomorrow');
  assert.equal(relativeDueDay('2026-03-20T23:00:00.000Z', NOW, TZ), null);
  assert.equal(defaultFlagReminder('2026-03-11T23:00:00.000Z', NOW, TZ), '2026-03-12T08:00:00.000Z');
  assert.ok(new Date(defaultFlagReminder('2026-03-10T23:00:00.000Z', NOW, TZ)).getTime() > NOW.getTime(), 'never in the past');
});

test('combineItems: tasks + flagged mails, filters and due-date order', () => {
  const tasks = [
    { id: 't1', subject: 'Bericht', status: 'IN_PROGRESS', dueDate: '2026-03-12T23:00:00.000Z' },
    { id: 't2', subject: 'Alt', status: 'NOT_STARTED', dueDate: '2026-03-01T23:00:00.000Z' },
    { id: 't3', subject: 'Fertig', status: 'COMPLETED', dueDate: null },
  ];
  const mails = [
    { id: 'm1', subject: 'Angebot', fromName: 'Bob', fromAddr: 'bob@example.com', folderName: 'Posteingang', flagStatus: 'flagged', flagDueAt: null, flagStartAt: null },
    { id: 'm2', subject: 'Rechnung', fromName: '', fromAddr: 'carol@example.com', folderName: 'Archiv', flagStatus: 'flagged', flagDueAt: '2026-03-05T23:00:00.000Z', flagStartAt: null },
    { id: 'm3', subject: 'Erledigt', fromName: 'Dan', fromAddr: 'dan@example.com', folderName: 'Posteingang', flagStatus: 'complete', flagDueAt: null, flagStartAt: null },
  ];
  assert.deepEqual(combineItems(tasks, mails, 'active', NOW, TZ).map((i) => i.id), ['t2', 'm2', 't1', 'm1']);
  assert.deepEqual(combineItems(tasks, mails, 'overdue', NOW, TZ).map((i) => i.id), ['t2', 'm2']);
  assert.deepEqual(combineItems(tasks, mails, 'completed', NOW, TZ).map((i) => [i.kind, i.id]), [['mail', 'm3'], ['task', 't3']]);
  assert.equal(combineItems(tasks, mails, 'active', NOW, TZ)[1]!.detail, 'carol@example.com · Archiv');
});

test('work hours: minutes ⇄ "1,5"', () => {
  assert.equal(formatWorkHours(90), '1,5');
  assert.equal(formatWorkHours(null), '');
  assert.equal(parseWorkHours('2,25'), 135);
  assert.equal(parseWorkHours('3'), 180);
  assert.equal(parseWorkHours(''), null);
  assert.equal(parseWorkHours('zwei'), undefined);
});

test('reminder sources: flag reminders, event reminders per occurrence within the grace window', () => {
  assert.deepEqual(flagReminderItems([
    { id: 'm1', subject: 'Angebot', flagStatus: 'flagged', flagReminderAt: '2026-03-11T08:00:00.000Z' },
    { id: 'm2', subject: 'x', flagStatus: 'complete', flagReminderAt: '2026-03-11T08:00:00.000Z' },
    { id: 'm3', subject: 'y', flagStatus: 'flagged', flagReminderAt: null },
  ]), [{ id: 'mail:m1', subject: 'Angebot', reminder: '2026-03-11T08:00:00.000Z', reminderByMail: false }]);
  const items = eventReminderItems([
    { id: 'e1', instanceId: 'e1:2026-03-11T14:00:00.000Z', summary: 'Daily', dtStart: '2026-03-11T14:00:00.000Z', reminder: { minutes: 15, byMail: true } },
    { id: 'e2', summary: 'Gestern', dtStart: '2026-03-10T09:00:00.000Z', reminder: { minutes: 15, byMail: false } },
    { id: 'e3', summary: 'Ohne', dtStart: '2026-03-11T15:00:00.000Z', reminder: null },
  ], NOW);
  assert.deepEqual(items, [{ id: 'event:e1:2026-03-11T14:00:00.000Z', subject: 'Daily', reminder: '2026-03-11T13:45:00.000Z', reminderByMail: true }]);
});
