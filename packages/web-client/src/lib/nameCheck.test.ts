import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNameCheck, needsNameCheck, nameCheckQuery, resolveRecipient } from './nameCheck.ts';

const book = [
  { displayName: 'Bob Builder', email: 'bob@example.test' },
  { displayName: 'Bobby Tables', email: 'bobby@example.test' },
  { displayName: 'Carol', email: 'carol@example.test' },
];

test('which entries are looked up, and with which text', () => {
  assert.equal(needsNameCheck('Bob Builder <bob@example.test>'), false);
  assert.equal(needsNameCheck('bob@example.test'), true);
  assert.equal(needsNameCheck('bob'), true);
  assert.equal(nameCheckQuery('bob@example.test'), 'bob@example.test');
  assert.equal(nameCheckQuery('Carol <carol@>'), 'Carol');
  assert.equal(nameCheckQuery(' bob '), 'bob');
});

test('valid addresses: found ones get their name, unknown ones stay (external)', () => {
  assert.deepEqual(resolveRecipient('carol@example.test', book), { kind: 'resolved', entry: 'Carol <carol@example.test>', from: 'carol@example.test' });
  assert.deepEqual(resolveRecipient('CAROL@example.test', book).kind, 'resolved', 'case-insensitive');
  assert.deepEqual(resolveRecipient('Carol C. <carol@example.test>', book), { kind: 'known', entry: 'Carol C. <carol@example.test>' });
  assert.deepEqual(resolveRecipient('x@ext.test', book), { kind: 'external', entry: 'x@ext.test' });
});

test('names: one match resolves, an exact match wins over partial ones, several or none stay unresolved', () => {
  assert.deepEqual(resolveRecipient('carol', book), { kind: 'resolved', entry: 'Carol <carol@example.test>', from: 'carol' });
  assert.deepEqual(resolveRecipient('bob', book), { kind: 'resolved', entry: 'Bob Builder <bob@example.test>', from: 'bob' }, 'local part matches exactly');
  assert.deepEqual(resolveRecipient('bo', book.slice(0, 2)), { kind: 'ambiguous', entry: 'bo', matches: 2 });
  assert.deepEqual(resolveRecipient('dave', []), { kind: 'notFound', entry: 'dave' });
  assert.deepEqual(resolveRecipient('bob', [book[0]!, book[0]!]).kind, 'resolved', 'duplicates of one entry are one match');
  assert.deepEqual(resolveRecipient('"Doe, J" <j@>', [{ displayName: 'Doe, J', email: 'j@example.test' }]),
    { kind: 'resolved', entry: '"Doe, J" <j@example.test>', from: '"Doe, J" <j@>' }, 'a name with a comma is quoted');
});

test('applyNameCheck: replaced in place, duplicates dropped, unresolved entries reported with the reason', () => {
  const r = applyNameCheck([
    { kind: 'resolved', entry: 'Bob Builder <bob@example.test>', from: 'bob' },
    { kind: 'external', entry: 'x@ext.test' },
    { kind: 'resolved', entry: 'Bob Builder <bob@example.test>', from: 'bob@example.test' },
    { kind: 'ambiguous', entry: 'bo', matches: 2 },
    { kind: 'notFound', entry: 'dave' },
  ]);
  assert.deepEqual(r.entries, ['Bob Builder <bob@example.test>', 'x@ext.test', 'bo', 'dave']);
  assert.deepEqual(r.unresolved, { bo: 'ambiguous', dave: 'notFound' });
});
