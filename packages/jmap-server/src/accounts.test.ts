import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * resolveAccounts() reads Prisma directly. @coremail/storage exports
 * `globalThis.__prisma ?? new PrismaClient()`, so a fake is installed on
 * globalThis before the module is imported.
 */
type Delegation = { permission: string; ownerId: string; active?: boolean };
type SharedPerm = { permission: string; boxId: string };

const fixture: { delegations: Delegation[]; shared: SharedPerm[] } = { delegations: [], shared: [] };

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  mailbox: { findFirst: async () => ({ id: 'mb-self' }) },
  sharedMailboxPerm: {
    findMany: async () => fixture.shared.map((s) => ({
      permission: s.permission,
      sharedMailbox: { id: s.boxId, email: `${s.boxId}@example.com`, displayName: s.boxId, mailbox: { id: `mb-${s.boxId}` } },
    })),
  },
  mailboxDelegate: {
    findMany: async () => fixture.delegations.map((d) => ({
      permission: d.permission,
      mailbox: { id: `mb-${d.ownerId}`, user: { id: d.ownerId, email: `${d.ownerId}@example.com`, displayName: d.ownerId, active: d.active ?? true } },
    })),
  },
};

const { resolveAccounts } = await import('./accounts.js');
const user = { userId: 'self', email: 'self@example.com', displayName: 'Self' } as Parameters<typeof resolveAccounts>[0];

async function accountsFor(delegations: Delegation[], shared: SharedPerm[] = []) {
  fixture.delegations = delegations;
  fixture.shared = shared;
  return resolveAccounts(user);
}

test('own mailbox is always a writable personal account', async () => {
  const acc = (await accountsFor([])).get('self');
  assert.equal(acc?.isPersonal, true);
  assert.equal(acc?.readOnly, false);
});

test('FULL_ACCESS delegation gives a writable account that may not send as the owner', async () => {
  // Send-as policy (storage sender-identity, as SMTP/ActiveSync): a mailbox delegate
  // gets no right to use the owner's address.
  const acc = (await accountsFor([{ permission: 'FULL_ACCESS', ownerId: 'owner' }])).get('owner');
  assert.equal(acc?.readOnly, false);
  assert.equal(acc?.maySend, false);
});

test('READ_ONLY delegation gives a read-only account that may not send', async () => {
  const acc = (await accountsFor([{ permission: 'READ_ONLY', ownerId: 'owner' }])).get('owner');
  assert.equal(acc?.readOnly, true);
  assert.equal(acc?.maySend, false);
});

for (const permission of ['SEND_AS', 'SEND_ON_BEHALF']) {
  test(`${permission} delegation gives no mailbox account`, async () => {
    assert.equal((await accountsFor([{ permission, ownerId: 'owner' }])).has('owner'), false);
  });
}

test('delegation of an inactive owner gives no account', async () => {
  assert.equal((await accountsFor([{ permission: 'FULL_ACCESS', ownerId: 'owner', active: false }])).has('owner'), false);
});

test('send-only shared mailbox permission gives no account', async () => {
  const accounts = await accountsFor([], [{ permission: 'SEND_AS', boxId: 'team' }]);
  assert.equal(accounts.has('shared-team'), false);
});
