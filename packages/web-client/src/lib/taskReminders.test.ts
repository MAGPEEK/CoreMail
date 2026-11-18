import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueReminders, markSeen, parseReminderMessage, reminderKey, reminderMessage, type ReminderSeen,
} from './taskReminders.ts';

const seen = (): ReminderSeen => ({ due: new Set(), reminders: new Set() });
const now = new Date(2026, 10, 18, 9, 30);

test('due today and reached reminders fire once; completed tasks and future reminders never', () => {
  const tasks = [
    { id: 't1', subject: 'Report', dueDate: new Date(2026, 10, 18, 17, 0).toISOString() },
    { id: 't2', subject: 'Call', reminder: new Date(2026, 10, 18, 9, 0).toISOString(), reminderByMail: true },
    { id: 't3', subject: 'Later', reminder: new Date(2026, 10, 18, 10, 0).toISOString() },
    { id: 't4', subject: 'Done', status: 'COMPLETED', dueDate: new Date(2026, 10, 18).toISOString() },
  ];
  const s = seen();
  const fires = dueReminders(tasks, now, s);
  assert.deepEqual(fires.map((f) => [f.kind, f.taskId, f.mail]), [['due', 't1', false], ['reminder', 't2', true]]);
  for (const f of fires) assert.equal(markSeen(s, f), true);
  assert.deepEqual(dueReminders(tasks, now, s), [], 'nothing fires twice');
});

test('a pre-v6 reminder key (ISO string) counts as notified', () => {
  const iso = new Date(2026, 10, 18, 9, 0).toISOString();
  const s = seen();
  s.reminders.add(`t2:${iso}`);
  assert.deepEqual(dueReminders([{ id: 't2', subject: 'Call', reminder: iso }], now, s), []);
  assert.equal(reminderKey('t2', iso), `t2:${new Date(iso).getTime()}`);
});

test('reminder messages between tabs round-trip and reject anything else', () => {
  const [fire] = dueReminders([{ id: 't2', subject: 'Call', reminder: new Date(2026, 10, 18, 9, 0).toISOString() }], now, seen());
  const msg = structuredClone(reminderMessage(fire!));
  assert.deepEqual(parseReminderMessage(msg), { t: 'reminder', kind: 'reminder', key: fire!.key, subject: 'Call' });
  assert.equal(parseReminderMessage({ t: 'reminder', kind: 'other', key: 'k', subject: 's' }), null);
  assert.equal(parseReminderMessage({ t: 'event', name: 'tasks' }), null);
  assert.equal(parseReminderMessage(null), null);
});

test('a follower that saw the announcement does not fire it again as the next leader', () => {
  const tasks = [{ id: 't2', subject: 'Call', reminder: new Date(2026, 10, 18, 9, 0).toISOString() }];
  const leader = seen();
  const follower = seen();
  const [fire] = dueReminders(tasks, now, leader);
  markSeen(leader, fire!);
  const received = parseReminderMessage(reminderMessage(fire!))!;
  assert.equal(markSeen(follower, received), true, 'follower shows it once');
  assert.equal(markSeen(follower, received), false);
  assert.deepEqual(dueReminders(tasks, now, follower), []);
});
