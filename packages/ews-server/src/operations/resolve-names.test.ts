import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

/**
 * ResolveNames must only search the caller's own personal contacts.
 * The Prisma client is replaced via the globalThis.__prisma seam of
 * @coremail/storage; the fake applies the userId filter like the database would.
 */
const contacts = [
  { userId: 'alice', email: 'bob@partner.com', displayName: 'Bob Partner', company: 'Partner' },
  { userId: 'mallory-victim', email: 'secret@client.com', displayName: 'Secret Client', company: 'Client' },
];
const contactWheres: Array<Record<string, unknown>> = [];

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  user: { findMany: async () => [] },
  contact: {
    findMany: async (args: { where: Record<string, unknown> }) => {
      contactWheres.push(args.where);
      const userId = args.where['userId'];
      return contacts.filter((c) => userId === undefined || c.userId === userId);
    },
  },
};

const { resolveNames } = await import('./resolve-names.js');
const alice = { userId: 'alice', email: 'alice@example.com', role: 'USER' };

test('the contact query is scoped to the calling user', async () => {
  await resolveNames({ UnresolvedEntry: 'co' }, alice);
  assert.equal(contactWheres.at(-1)?.['userId'], 'alice');
});

test('own contacts are returned, other users\' contacts are not', async () => {
  const xml = await resolveNames({ UnresolvedEntry: 'co' }, alice);
  assert.match(xml, /bob@partner\.com/);
  assert.doesNotMatch(xml, /secret@client\.com/);
});

test('entries shorter than two characters do not query contacts', async () => {
  const before = contactWheres.length;
  await resolveNames({ UnresolvedEntry: 'a' }, alice);
  assert.equal(contactWheres.length, before);
});
