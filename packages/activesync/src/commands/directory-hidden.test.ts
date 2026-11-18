/**
 * 9.4: mailboxes hidden from the address list (MailFlowPolicy.hiddenFromGal)
 * are not found by the ActiveSync GAL (Search Store=GAL, ResolveRecipients).
 * Run: node --import tsx --test src/commands/directory-hidden.test.ts  (in packages/activesync)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from '../test-support/fake-db.js';

installFakeDb({
  user: [
    { id: 'u1', email: 'me@example.com', displayName: 'Me', domainId: 'd1', active: true },
    { id: 'u2', email: 'anna@example.com', displayName: 'Anna Visible', domainId: 'd1', active: true },
    { id: 'u3', email: 'boss@example.com', displayName: 'Anna Hidden', domainId: 'd1', active: true },
  ],
  sharedMailbox: [
    { id: 's1', email: 'team@example.com', displayName: 'Anna Team', domainId: 'd1', active: true },
    { id: 's2', email: 'hr@example.com', displayName: 'Anna HR', domainId: 'd1', active: true },
  ],
  mailFlowPolicy: [
    { id: 'p1', userId: 'u3', sharedMailboxId: null, hiddenFromGal: true },
    { id: 'p2', userId: null, sharedMailboxId: 's2', hiddenFromGal: true },
    { id: 'p3', userId: 'u2', sharedMailboxId: null, hiddenFromGal: false },
  ],
});

const { searchGal } = await import('./directory.js');

test('GAL search leaves out hidden users and shared mailboxes, keeps visible ones and those without a policy', async () => {
  const found = (await searchGal('u1', 'anna')).map((e) => e.email).sort();
  assert.deepEqual(found, ['anna@example.com', 'team@example.com']);
});
