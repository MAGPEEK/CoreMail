/**
 * Sender identity policy used by EAS (and other client submission paths).
 * Run: node --import tsx --test src/sender-identity.test.ts  (in packages/storage)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

interface State {
  users: Array<{ id: string; email: string; active: boolean }>;
  aliases: Array<{ address: string; targetUserId: string; active: boolean }>;
  perms: Array<{ userId: string; permission: string; shared: { email: string; active: boolean; aliases: Array<{ address: string; active: boolean }> } }>;
}
let s: State;
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  user: {
    findFirst: async ({ where }: { where: { id: string; active: boolean } }) =>
      s.users.find((u) => u.id === where.id && u.active === where.active) ?? null,
  },
  emailAlias: {
    findMany: async ({ where }: { where: { targetUserId: string; active: boolean } }) =>
      s.aliases.filter((a) => a.targetUserId === where.targetUserId && a.active === where.active),
  },
  sharedMailboxPerm: {
    findMany: async ({ where }: { where: { userId: string; permission: { in: string[] } } }) =>
      s.perms
        .filter((p) => p.userId === where.userId && where.permission.in.includes(p.permission) && p.shared.active)
        .map((p) => ({ sharedMailbox: { email: p.shared.email, aliases: p.shared.aliases.filter((a) => a.active) } })),
  },
};

const { listAllowedSenderAddresses, isSenderAddressAllowed, normalizeSenderAddress } =
  await import('./sender-identity.js');

beforeEach(() => {
  s = {
    users: [{ id: 'u1', email: 'Alice@Firma.de', active: true }, { id: 'u2', email: 'old@firma.de', active: false }],
    aliases: [
      { address: 'a.smith@firma.de', targetUserId: 'u1', active: true },
      { address: 'gone@firma.de', targetUserId: 'u1', active: false },
    ],
    perms: [
      { userId: 'u1', permission: 'SEND_AS', shared: { email: 'info@firma.de', active: true, aliases: [{ address: 'hello@firma.de', active: true }] } },
      { userId: 'u1', permission: 'READ_ONLY', shared: { email: 'hr@firma.de', active: true, aliases: [] } },
      { userId: 'u1', permission: 'FULL_ACCESS', shared: { email: 'closed@firma.de', active: false, aliases: [] } },
    ],
  };
});

test('own address, active aliases and SEND_AS shared mailboxes (incl. aliases) are allowed', async () => {
  const list = await listAllowedSenderAddresses('u1');
  assert.deepEqual(new Set(list), new Set(['alice@firma.de', 'a.smith@firma.de', 'info@firma.de', 'hello@firma.de']));
});

test('inactive alias, READ_ONLY permission and inactive shared mailbox are not allowed', async () => {
  const list = await listAllowedSenderAddresses('u1');
  for (const bad of ['gone@firma.de', 'hr@firma.de', 'closed@firma.de', 'ceo@firma.de']) {
    assert.equal(isSenderAddressAllowed(bad, list), false, bad);
  }
});

test('deactivated or unknown user may send as nobody', async () => {
  assert.deepEqual(await listAllowedSenderAddresses('u2'), []);
  assert.deepEqual(await listAllowedSenderAddresses('nope'), []);
});

test('address comparison is case-insensitive and ignores angle brackets', () => {
  assert.equal(normalizeSenderAddress(' <Info@Firma.DE> '), 'info@firma.de');
  assert.equal(isSenderAddressAllowed('<INFO@firma.de>', ['info@firma.de']), true);
  assert.equal(isSenderAddressAllowed('', ['info@firma.de']), false);
});
