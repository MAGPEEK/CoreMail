import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MAX_NOTIFICATIONS, addNotification, hintNotification, mailNotification, markAllRead, reminderHref, unreadCount,
} from './notifications.ts';

const labels = { unknownSender: 'Unbekannter Absender', noSubject: '(Kein Betreff)' };
const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');

test('new mail: sender, subject and a link to the message in its mailbox', () => {
  const n = mailNotification({ mailbox: 'shared:abc', folderId: 'f1', messageId: 'm1', fromName: 'Anna', fromAddr: 'a@x.de', subject: 'Hallo' }, 5, labels)!;
  assert.deepEqual(n, { id: 'mail:m1', kind: 'mail', title: 'Anna', detail: 'Hallo', at: 5, href: '/mail/shared%3Aabc/f1/m1', read: false });
  const bare = mailNotification({ fromAddr: 'b@x.de' }, 6, labels)!;
  assert.equal(bare.title, 'b@x.de');
  assert.equal(bare.detail, '(Kein Betreff)');
  assert.equal(bare.href, '/mail', 'without ids the mail view opens');
  assert.equal(mailNotification(null, 7, labels)!.title, 'Unbekannter Absender');
  assert.equal(mailNotification({ messageId: 'j', isJunk: true }, 8, labels), null, 'junk mail is not listed');
});

test('list: newest first, no duplicates, bounded; unread count and mark all read', () => {
  let list = addNotification([], mailNotification({ messageId: 'a', folderId: 'f' }, 1, labels)!);
  list = addNotification(list, mailNotification({ messageId: 'b', folderId: 'f' }, 2, labels)!);
  list = addNotification(list, mailNotification({ messageId: 'a', folderId: 'f' }, 3, labels)!);
  assert.deepEqual(list.map((n) => n.id), ['mail:b', 'mail:a']);
  assert.equal(unreadCount(list), 2);
  assert.equal(unreadCount(markAllRead(list)), 0);
  for (let i = 0; i < MAX_NOTIFICATIONS + 5; i++) list = addNotification(list, hintNotification('calendar', `${i}`, 'x', i, '/calendar'));
  assert.equal(list.length, MAX_NOTIFICATIONS);
});

test('reminders lead to the calendar, the mail view or the tasks', () => {
  assert.equal(reminderHref('event:e1:2026'), '/calendar');
  assert.equal(reminderHref('mail:m1:2026'), '/mail');
  assert.equal(reminderHref('t1:2026-11-21'), '/tasks');
  assert.equal(hintNotification('reminder', 'k', 'Erinnerung: X', 1, '/tasks').kind, 'reminder');
});

test('the bell is wired: realtime new mail + reminders fill the store, the panel has the empty state', () => {
  assert.match(read('hooks/useRealtime.ts'), /mailNotification\(data, now/);
  assert.match(read('hooks/useTaskReminders.ts'), /useNotifications\.getState\(\)\.add\(hintNotification\('reminder'/);
  const panel = read('components/NotificationsPanel.tsx');
  assert.match(panel, /t\('notifications_empty'\)/);
  assert.match(panel, /open\('\/settings#notifications'\)/);
  assert.match(panel, /role="dialog"/);
});
