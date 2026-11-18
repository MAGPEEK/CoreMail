/**
 * 9.4 realtime audience: who hears about a mailbox / calendar change. Pure row
 * mapping plus the calendar fan-out against a fake client and a fake transport.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
const { audienceFromRow, publishCalendarChange } = await import('./audience.js');

const active = { active: true };

test('mailbox audience: owner, readers of a Shared Mailbox and delegates with read access', () => {
  const own = audienceFromRow({
    id: 'mb1', userId: 'alice', sharedBoxId: null, user: active, sharedBox: null,
    delegates: [
      { granteeId: 'bob', permission: 'READ_ONLY', grantee: active },
      { granteeId: 'carol', permission: 'SEND_AS', grantee: active },
      { granteeId: 'dave', permission: 'FULL_ACCESS', grantee: { active: false } },
    ],
  });
  assert.deepEqual(own, [
    { userId: 'alice', mailboxKey: 'own' },
    { userId: 'bob', mailboxKey: 'delegated:mb1' },
  ]);

  const shared = audienceFromRow({
    id: 'mb2', userId: null, sharedBoxId: 'sb1', user: null, delegates: [],
    sharedBox: {
      active: true,
      permissions: [
        { userId: 'bob', permission: 'FULL_ACCESS', user: active },
        { userId: 'bob', permission: 'SEND_AS', user: active },
        { userId: 'erin', permission: 'SEND_AS', user: active },
      ],
    },
  });
  assert.deepEqual(shared, [{ userId: 'bob', mailboxKey: 'shared:sb1', sharedMailboxId: 'sb1' }]);
});

test('mailbox audience: a deactivated Shared Mailbox or delegating owner reaches no grantee', () => {
  assert.deepEqual(audienceFromRow({
    id: 'mb2', userId: null, sharedBoxId: 'sb1', user: null, delegates: [],
    sharedBox: { active: false, permissions: [{ userId: 'bob', permission: 'FULL_ACCESS', user: active }] },
  }), []);
  assert.deepEqual(audienceFromRow({
    id: 'mb1', userId: 'alice', sharedBoxId: null, user: { active: false }, sharedBox: null,
    delegates: [{ granteeId: 'bob', permission: 'FULL_ACCESS', grantee: active }],
  }), [{ userId: 'alice', mailboxKey: 'own' }]);
});

test('calendar change: owners get the event ids, grantees only the calendar', async () => {
  const sent: Array<{ channel: string; event: Record<string, unknown> }> = [];
  globalThis.__realtimeRedis = {
    publish: async (channel: string, message: string) => { sent.push({ channel, event: JSON.parse(message) as Record<string, unknown> }); },
  };
  const db = {
    calendar: { findMany: async () => [{ userId: 'alice', shares: [{ granteeId: 'bob' }, { granteeId: 'alice' }] }] },
  };
  try {
    await publishCalendarChange(db, ['cal1'], { action: 'create', ids: ['ev1'], extraUserIds: ['carol'] });
  } finally {
    globalThis.__realtimeRedis = null;
  }
  const byChannel = Object.fromEntries(sent.map((s) => [s.channel, s.event]));
  assert.deepEqual(Object.keys(byChannel).sort(), ['user:alice:events', 'user:bob:events', 'user:carol:events']);
  assert.deepEqual(byChannel['user:alice:events'], { type: 'calendar', action: 'create', ids: ['ev1'], calendarIds: ['cal1'] });
  assert.deepEqual(byChannel['user:bob:events'], { type: 'calendar', action: 'create', calendarIds: ['cal1'] });
  assert.deepEqual(byChannel['user:carol:events'], { type: 'calendar', action: 'create', calendarIds: ['cal1'] });
});
