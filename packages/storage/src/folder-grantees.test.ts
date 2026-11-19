/**
 * w3 scope leaks (review): folder-grantees.ts — whom a caller may name as a new
 * folder-permission grantee (REST PUT and IMAP SETACL share the rule).
 * Run: node --import tsx --test src/folder-grantees.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_GRANTEE_DIRECTORY, resolvableGrantees, shownGranteeIds, webmailGranteeDirectory, type GranteeDb,
} from './folder-grantees.js';
import { GAL_VISIBLE_WHERE } from './gal-visible.js';

function fakeDb(domainOf: Record<string, string | null>) {
  const calls: Array<Record<string, unknown>> = [];
  const db: GranteeDb = {
    user: {
      findUnique: async ({ where }) => (where.id in domainOf ? { domainId: domainOf[where.id] ?? null } : null),
      findMany: async (args) => { calls.push(args.where); return [{ id: 'u2', email: 'Alice@A.example' }]; },
    },
  };
  return { db, calls };
}

test('webmailGranteeDirectory: active address-list users of the caller\'s domain; nobody without a domain', async () => {
  const { db } = fakeDb({ u1: 'dA', u9: null });
  assert.deepEqual(await webmailGranteeDirectory(db, 'u1'), { domainId: 'dA', active: true, ...GAL_VISIBLE_WHERE });
  assert.equal(await webmailGranteeDirectory(db, 'u9'), EMPTY_GRANTEE_DIRECTORY);
  assert.equal(await webmailGranteeDirectory(db, 'unknown'), EMPTY_GRANTEE_DIRECTORY);
  assert.equal(await webmailGranteeDirectory(db, ''), EMPTY_GRANTEE_DIRECTORY);
});

test('resolvableGrantees: one query, directory OR always-resolvable ids, addresses compared lower-cased', async () => {
  const { db, calls } = fakeDb({});
  const directory = { domainId: 'dA' };
  const known = await resolvableGrantees(db, { emails: [' ALICE@a.example ', 'alice@a.example'], ids: ['u7'] }, directory, ['u3', 'u3']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    AND: [
      { OR: [{ email: { in: ['alice@a.example'] } }, { id: { in: ['u7'] } }] },
      { OR: [directory, { id: { in: ['u3'] } }] },
    ],
  });
  assert.equal(known.byEmail.get('alice@a.example'), 'u2');
  assert.deepEqual([...known.ids], ['u2']);
});

test('resolvableGrantees: nothing named → no query', async () => {
  const { db, calls } = fakeDb({});
  const known = await resolvableGrantees(db, { emails: [' '], ids: [] }, {}, ['u1']);
  assert.equal(calls.length, 0);
  assert.equal(known.byEmail.size, 0);
});

test('shownGranteeIds: own and inherited user entries, Default left out', () => {
  assert.deepEqual(shownGranteeIds({
    entries: [{ user: null }, { user: { id: 'u1' } }],
    inherited: [{ user: { id: 'u2' } }],
  }), ['u1', 'u2']);
});
