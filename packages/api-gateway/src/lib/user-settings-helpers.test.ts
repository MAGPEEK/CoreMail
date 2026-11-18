/**
 * 9.4 helpers: ?markRead=, list sort order, invitation times, legacy signature mirror.
 * Run: node --import tsx --test src/lib/user-settings-helpers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
const { markReadRequested } = await import('./mark-read.js');
const { messageOrderBy } = await import('./message-sort.js');
const { formatInvitationTime } = await import('./imip.js');
const { legacyMirror } = await import('./signatures.js');

test('markReadRequested: default true, false only for markRead=false|0', () => {
  assert.equal(markReadRequested({}), true);
  assert.equal(markReadRequested({ markRead: 'true' }), true);
  assert.equal(markReadRequested({ markRead: 'false' }), false);
  assert.equal(markReadRequested({ markRead: '0' }), false);
  assert.equal(markReadRequested({ markRead: ['false'] }), true);
});

test('messageOrderBy: pinned first, chosen column, stable ties; unknown → date desc', () => {
  const pinned = { pinnedAt: { sort: 'desc', nulls: 'last' } };
  assert.deepEqual(messageOrderBy({}), [pinned, { date: 'desc' }, { id: 'asc' }]);
  assert.deepEqual(messageOrderBy({ sort: 'from', dir: 'asc' }), [pinned, { fromAddr: 'asc' }, { date: 'desc' }, { id: 'asc' }]);
  assert.deepEqual(messageOrderBy({ sort: 'size' }), [pinned, { rawSize: 'desc' }, { date: 'desc' }, { id: 'asc' }]);
  assert.deepEqual(messageOrderBy({ sort: 'date', dir: 'asc' }), [pinned, { date: 'asc' }, { id: 'asc' }]);
  assert.deepEqual(messageOrderBy({ sort: 'evil', dir: 'sideways' }), [pinned, { date: 'desc' }, { id: 'asc' }]);
});

test('formatInvitationTime: organizer zone for timed events, date only for all-day', () => {
  const d = new Date('2026-03-10T08:00:00Z');
  assert.match(formatInvitationTime(d, false, 'Europe/Berlin'), /09:00/);
  assert.match(formatInvitationTime(d, false, 'America/New_York'), /04:00/);
  const allDay = formatInvitationTime(new Date('2026-03-10T00:00:00Z'), true, 'America/New_York');
  assert.match(allDay, /10\. März 2026/);
  assert.doesNotMatch(allDay, /:/);
});

test('legacyMirror: primary = default for new, else for replies, else the first', () => {
  const sigs = [{ id: 'a', name: 'A', html: '<p>A</p>', sortOrder: 0 }, { id: 'b', name: 'B', html: '<p>B</p>', sortOrder: 1 }];
  assert.deepEqual(legacyMirror(sigs, { newId: 'b', replyId: 'a' }), { signature: '<p>B</p>', signatureAutoNew: true, signatureAutoReply: true });
  assert.deepEqual(legacyMirror(sigs, { newId: null, replyId: 'b' }), { signature: '<p>B</p>', signatureAutoNew: false, signatureAutoReply: true });
  assert.deepEqual(legacyMirror(sigs, undefined), { signature: '<p>A</p>', signatureAutoNew: false, signatureAutoReply: false });
  assert.deepEqual(legacyMirror([], { newId: 'gone', replyId: null }), { signature: '', signatureAutoNew: false, signatureAutoReply: false });
});
