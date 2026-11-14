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
