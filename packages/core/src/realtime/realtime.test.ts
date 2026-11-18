/**
 * Realtime change events (9.4): vocabulary, validation, merge and publishing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const ev = await import('./events.js');
const { publishMailboxChange, publishUserEvent } = await import('./publish.js');

test('userEventsChannel / userIdOfChannel round-trip; invalid ids refused', () => {
  assert.equal(ev.userEventsChannel('u1'), 'user:u1:events');
  assert.equal(ev.userIdOfChannel('user:u1:events'), 'u1');
  assert.equal(ev.userIdOfChannel('user:a:b:events'), null);
  assert.equal(ev.userIdOfChannel('mail:new'), null);
  assert.throws(() => ev.userEventsChannel('a:b'));
  assert.throws(() => ev.userEventsChannel(''));
});

test('parseMailboxChange: valid event, unknown kinds dropped, malformed refused', () => {
  assert.deepEqual(
    ev.parseMailboxChange(JSON.stringify({ mailboxId: 'm1', kinds: ['messages', 'bogus'], folderIds: ['f1', 'f1', 7], modSeq: '42' })),
    { mailboxId: 'm1', kinds: ['messages'], folderIds: ['f1'], modSeq: '42' },
  );
  assert.equal(ev.parseMailboxChange('{'), null);
  assert.equal(ev.parseMailboxChange(JSON.stringify({ mailboxId: 'm1', kinds: [] })), null);
  assert.equal(ev.parseMailboxChange(JSON.stringify({ kinds: ['flags'] })), null);
  assert.equal(ev.parseMailboxChange('[1]'), null);
  // a bad modSeq is dropped, the event stays usable
  assert.deepEqual(ev.parseMailboxChange(JSON.stringify({ mailboxId: 'm1', kinds: ['flags'], modSeq: '1e9' })), { mailboxId: 'm1', kinds: ['flags'] });
  // too many folder ids → "any folder"
  const many = Array.from({ length: ev.MAX_EVENT_FOLDER_IDS + 1 }, (_, i) => `f${i}`);
  assert.equal(ev.parseMailboxChange(JSON.stringify({ mailboxId: 'm1', kinds: ['messages'], folderIds: many }))!.folderIds, undefined);
});

test('mergeMailboxChange: unites kinds/folders, keeps the highest modSeq, unknown folders win', () => {
  const a = { mailboxId: 'm', kinds: ['flags' as const], folderIds: ['f1'], modSeq: '9' };
  const b = { mailboxId: 'm', kinds: ['messages' as const], folderIds: ['f2'], modSeq: '10' };
  assert.deepEqual(ev.mergeMailboxChange(a, b), { mailboxId: 'm', kinds: ['messages', 'flags'], folderIds: ['f1', 'f2'], modSeq: '10' });
  assert.deepEqual(ev.mergeMailboxChange(a, { mailboxId: 'm', kinds: ['folders'] }), { mailboxId: 'm', kinds: ['flags', 'folders'], modSeq: '9' });
  assert.throws(() => ev.mergeMailboxChange(a, { ...b, mailboxId: 'x' }));
});

test('parseUserEvent: typed fields only', () => {
  assert.deepEqual(
    ev.parseUserEvent(JSON.stringify({ type: 'calendar', action: 'update', calendarIds: ['c1'], scope: 'shares', extra: 1 })),
    { type: 'calendar', action: 'update', calendarIds: ['c1'], scope: 'shares' },
  );
  assert.deepEqual(ev.parseUserEvent(JSON.stringify({ type: 'settings', section: 'signature' })), { type: 'settings', section: 'signature' });
  assert.deepEqual(ev.parseUserEvent(JSON.stringify({ type: 'settings', section: 'nope', action: 'boom' })), { type: 'settings' });
  assert.equal(ev.parseUserEvent(JSON.stringify({ type: 'mail' })), null);
  assert.equal(ev.parseUserEvent('nope'), null);
});

function capture() {
  const sent: Array<{ channel: string; message: string }> = [];
  globalThis.__realtimeRedis = { publish: async (channel, message) => { sent.push({ channel, message }); return 1; } };
  return sent;
}

test('publishUserEvent: one message per distinct user, normalised', async () => {
  const sent = capture();
  await publishUserEvent(['u1', 'u2', 'u1'], { type: 'contacts', action: 'create', ids: ['c1'] });
  assert.deepEqual(sent.map((s) => s.channel), ['user:u1:events', 'user:u2:events']);
  assert.deepEqual(JSON.parse(sent[0]!.message), { type: 'contacts', action: 'create', ids: ['c1'] });
  await publishUserEvent('bad:id', { type: 'notes' });
  assert.equal(sent.length, 2, 'invalid user id dropped');
});

test('publishMailboxChange: mailbox:changes channel; Redis failure never throws', async () => {
  const sent = capture();
  await publishMailboxChange({ mailboxId: 'm1', kinds: ['folders'] });
  assert.deepEqual(sent, [{ channel: ev.CHANNEL_MAILBOX_CHANGES, message: '{"mailboxId":"m1","kinds":["folders"]}' }]);
  globalThis.__realtimeRedis = { publish: async () => { throw new Error('down'); } };
  await publishMailboxChange({ mailboxId: 'm1', kinds: ['flags'] });
  await publishUserEvent('u1', { type: 'tasks' });
  globalThis.__realtimeRedis = null;
  await publishUserEvent('u1', { type: 'tasks' }); // no transport → no-op
});
