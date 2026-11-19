/**
 * 9.5: whose copy of a meeting is written — the organizer's own copy (it sends
 * invitations / cancellations) or an attendee's copy (changes only itself).
 * Run: node --import tsx --test src/lib/organizer-copy.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

installFakePrisma({
  user: { findUnique: async (a: unknown) => ((a as { where: { id: string } }).where.id === 'bob' ? { email: 'Bob@Example.com' } : null) },
  emailAlias: {
    findFirst: async (a: unknown) => {
      const where = (a as { where: { targetUserId: { in: string[] }; address: { equals: string } } }).where;
      return where.targetUserId.in.includes('alice') && where.address.equals === 'sales@example.com' ? { id: 'al1' } : null;
    },
  },
});

const { isOrganizerCopy } = await import('./organizer-copy.js');

const alice = { userId: 'alice', email: 'alice@example.com', calendarOwnerId: 'alice' };

test('an appointment without organizer and the acting user\'s own meeting are organizer copies', async () => {
  assert.equal(await isOrganizerCopy(null, alice), true);
  assert.equal(await isOrganizerCopy('mailto:Alice@Example.com ', alice), true);
});

test('an active alias of the acting user counts as an own address', async () => {
  assert.equal(await isOrganizerCopy('sales@example.com', alice), true);
});

test('a delegate with WRITE on the organizer\'s calendar writes the organizer\'s copy', async () => {
  assert.equal(await isOrganizerCopy('bob@example.com', { ...alice, calendarOwnerId: 'bob' }), true);
});

test('someone else\'s meeting in the own calendar is an attendee\'s copy', async () => {
  assert.equal(await isOrganizerCopy('olga@ext.test', alice), false);
  assert.equal(await isOrganizerCopy('bob@example.com', alice), false, 'bob\'s meeting in alice\'s own calendar');
});
