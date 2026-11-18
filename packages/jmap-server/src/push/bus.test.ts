/**
 * 9.4: JMAP push is driven by mailbox:changes — every message/folder writer
 * (SMTP, IMAP, webmail, ActiveSync, restore …) reaches the JMAP listeners of
 * the mailbox's account, not only JMAP's own writes.
 * Run: node --import tsx --import ./src/test-env.ts --test src/push/bus.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['LOG_LEVEL'] ??= 'error';

const mailboxes = [
  { id: 'mb-own', userId: 'u1', sharedBoxId: null },
  { id: 'mb-team', userId: null, sharedBoxId: 's1' },
];
let lookups = 0;
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  mailbox: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      lookups++;
      return mailboxes.find((m) => m.id === where.id) ?? null;
    },
  },
  jmapPushSubscription: { findMany: async () => [] },
};

const { changeBus, dispatchMailboxChange, accountIdOf } = await import('./bus.js');

function listen(): string[] {
  const seen: string[] = [];
  changeBus.on('change', (accountId: string) => seen.push(accountId));
  return seen;
}

test('accountIdOf: user mailbox → user id, shared mailbox → shared-<id>', () => {
  assert.equal(accountIdOf({ userId: 'u1', sharedBoxId: null }), 'u1');
  assert.equal(accountIdOf({ userId: null, sharedBoxId: 's1' }), 'shared-s1');
  assert.equal(accountIdOf({ userId: null, sharedBoxId: null }), null);
});

test('a mailbox change reaches the account listeners; the mailbox→account lookup is cached', async () => {
  const seen = listen();
  await dispatchMailboxChange(JSON.stringify({ mailboxId: 'mb-own', kinds: ['flags'], folderIds: ['f1'] }));
  await dispatchMailboxChange(JSON.stringify({ mailboxId: 'mb-own', kinds: ['messages'] }));
  await dispatchMailboxChange(JSON.stringify({ mailboxId: 'mb-team', kinds: ['folders'] }));
  assert.deepEqual(seen, ['u1', 'u1', 'shared-s1']);
  assert.equal(lookups, 2);
  changeBus.removeAllListeners('change');
});

test('unknown mailboxes and malformed messages reach nobody', async () => {
  const seen = listen();
  await dispatchMailboxChange(JSON.stringify({ mailboxId: 'gone', kinds: ['messages'] }));
  await dispatchMailboxChange('{"mailboxId":1}');
  assert.deepEqual(seen, []);
  changeBus.removeAllListeners('change');
});
