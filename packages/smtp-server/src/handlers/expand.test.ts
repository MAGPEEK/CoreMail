/**
 * Tests for expandRecipients() — alias resolution only (distribution groups were removed in v5.6.1).
 * Prisma is replaced by an in-memory fake through test-hooks.mjs.
 *
 * Run (from the repository root, Node >= 22.15):
 *   node --experimental-transform-types --import ./packages/smtp-server/src/test-hooks.mjs \
 *        --test packages/smtp-server/src/handlers/expand.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { expandRecipients } from './expand.js';

interface AliasTarget { email: string; active: boolean }
interface AliasRow {
  address: string;
  active: boolean;
  targetUser: AliasTarget | null;
  targetShared: AliasTarget | null;
}
interface AliasQuery { where: { address: string; active: boolean } }

const testGlobals = globalThis as unknown as { __coremailTest: { prisma?: unknown } };

function fakeAliases(rows: AliasRow[]): void {
  // Only  is faked: any access to another model (e.g. a distribution group) throws.
  testGlobals.__coremailTest.prisma = {
    emailAlias: {
      findFirst: async ({ where }: AliasQuery) =>
        rows.find((row) => row.address === where.address && row.active === where.active) ?? null,
    },
  };
}

const alias = (address: string, target: Partial<Pick<AliasRow, 'targetUser' | 'targetShared'>>, active = true): AliasRow =>
  ({ address, active, targetUser: null, targetShared: null, ...target });

beforeEach(() => fakeAliases([]));

test('an address without an alias is returned unchanged', async () => {
  const result = await expandRecipients(['bob@example.test']);

  assert.deepEqual(result, ['bob@example.test']);
});

test('recipient addresses are normalized to lower case', async () => {
  const result = await expandRecipients(['Bob@Example.TEST']);

  assert.deepEqual(result, ['bob@example.test']);
});

test('an alias is replaced by the primary address of its target user', async () => {
  fakeAliases([alias('sales@example.test', { targetUser: { email: 'Bob@example.test', active: true } })]);

  const result = await expandRecipients(['sales@example.test']);

  assert.deepEqual(result, ['bob@example.test']);
});

test('an alias lookup is case-insensitive on the recipient address', async () => {
  fakeAliases([alias('sales@example.test', { targetUser: { email: 'bob@example.test', active: true } })]);

  const result = await expandRecipients(['SALES@example.test']);

  assert.deepEqual(result, ['bob@example.test']);
});

test('an alias of a shared mailbox is replaced by the shared mailbox address', async () => {
  fakeAliases([alias('team@example.test', { targetShared: { email: 'support@example.test', active: true } })]);

  const result = await expandRecipients(['team@example.test']);

  assert.deepEqual(result, ['support@example.test']);
});

test('an alias whose target user is inactive is not resolved', async () => {
  fakeAliases([alias('sales@example.test', { targetUser: { email: 'bob@example.test', active: false } })]);

  const result = await expandRecipients(['sales@example.test']);

  assert.deepEqual(result, ['sales@example.test']);
});

test('a deactivated alias is not resolved', async () => {
  fakeAliases([alias('sales@example.test', { targetUser: { email: 'bob@example.test', active: true } }, false)]);

  const result = await expandRecipients(['sales@example.test']);

  assert.deepEqual(result, ['sales@example.test']);
});

test('alias and target given together are delivered only once', async () => {
  fakeAliases([alias('sales@example.test', { targetUser: { email: 'bob@example.test', active: true } })]);

  const result = await expandRecipients(['sales@example.test', 'bob@example.test']);

  assert.deepEqual(result, ['bob@example.test']);
});

test('the same alias given twice is resolved both times to one target', async () => {
  fakeAliases([alias('sales@example.test', { targetUser: { email: 'bob@example.test', active: true } })]);

  const result = await expandRecipients(['sales@example.test', 'Sales@example.test']);

  assert.deepEqual(result, ['bob@example.test']);
});

// ─── postmaster (RFC 5321 §4.5.1, review fix) ─────────────────────────────────

interface UserRow { email: string; active: boolean; role: string; createdAt: Date }

function fakePostmasterDb(users: UserRow[], shared: string[] = []): void {
  testGlobals.__coremailTest.prisma = {
    emailAlias: { findFirst: async () => null },
    user: {
      findFirst: async ({ where }: { where: { email?: string; active: boolean; role?: { in: string[] } } }) => {
        const rows = users
          .filter((u) => u.active === where.active)
          .filter((u) => (where.email === undefined ? true : u.email === where.email))
          .filter((u) => (where.role === undefined ? true : where.role.in.includes(u.role)))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return rows[0] ? { id: rows[0].email, email: rows[0].email } : null;
      },
    },
    sharedMailbox: {
      findFirst: async ({ where }: { where: { email: string } }) => (shared.includes(where.email) ? { id: where.email } : null),
    },
  };
}

const ADMINS: UserRow[] = [
  { email: 'user@example.test', active: true, role: 'USER', createdAt: new Date('2020-01-01') },
  { email: 'Newadmin@example.test', active: true, role: 'SERVER_MANAGEMENT', createdAt: new Date('2024-01-01') },
  { email: 'boss@example.test', active: true, role: 'ORGANIZATION_MANAGEMENT', createdAt: new Date('2021-01-01') },
];

test('the bare <Postmaster> recipient is delivered to the oldest active administrator', async () => {
  fakePostmasterDb(ADMINS);

  const result = await expandRecipients(['postmaster']);

  assert.deepEqual(result, ['boss@example.test']);
});

test('postmaster@<local domain> without an own mailbox is delivered to an administrator', async () => {
  fakePostmasterDb(ADMINS);

  const result = await expandRecipients(['PostMaster@example.test']);

  assert.deepEqual(result, ['boss@example.test']);
});

test('a real postmaster mailbox (user or shared mailbox) is kept', async () => {
  fakePostmasterDb([...ADMINS, { email: 'postmaster@example.test', active: true, role: 'USER', createdAt: new Date() }], ['postmaster@other.test']);

  const result = await expandRecipients(['postmaster@example.test', 'postmaster@other.test']);

  assert.deepEqual(result, ['postmaster@example.test', 'postmaster@other.test']);
});
