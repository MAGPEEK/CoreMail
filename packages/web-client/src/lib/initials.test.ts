import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInitials, nameInitials, emailInitial, normalizeDisplayName } from './initials.ts';

test('first letter of the first and of the last word', () => {
  assert.equal(getInitials('Jörg Müller'), 'JM');
  assert.equal(getInitials('Anna Maria van der Berg'), 'AB');
  assert.equal(getInitials('  max   mustermann  '), 'MM');
  assert.equal(getInitials('Özlem Çelik'), 'ÖÇ');
  assert.equal(getInitials('Ærøskøbing Ånd'), 'ÆÅ');
});

test('one word → one letter', () => {
  assert.equal(getInitials('Buchhaltung'), 'B');
  assert.equal(getInitials('élise'), 'É');
});

test('"Last, First" and parenthesised parts', () => {
  assert.equal(getInitials('Müller, Jörg'), 'JM');
  assert.equal(getInitials('Muster, Max (Vertrieb)'), 'MM');
  assert.equal(getInitials('Max Muster (extern)'), 'MM');
  assert.equal(getInitials('Max [Support] Muster'), 'MM');
  assert.equal(getInitials('"Erika Mustermann"'), 'EM');
  assert.equal(normalizeDisplayName('Müller, Jörg'), 'Jörg Müller');
});

test('words without letters are skipped', () => {
  assert.equal(getInitials('Team & Partner'), 'TP');
  assert.equal(getInitials('- Info -'), 'I');
  assert.equal(nameInitials('2024 Bericht'), 'B');
});

test('no usable name → first letter of the email local part, never "?" with an address', () => {
  assert.equal(getInitials('', 'joerg.mueller@example.test'), 'J');
  assert.equal(getInitials(null, 'info@example.test'), 'I');
  assert.equal(getInitials('   ', 'zoë@example.test'), 'Z');
  assert.equal(getInitials('()', '123@example.test'), '1', 'local part without a letter → its first character');
  assert.equal(getInitials('_', '_x@example.test'), 'X');
  assert.equal(getInitials('bob@example.test'), 'B', 'an address passed as the name');
  assert.equal(getInitials('bob@example.test', 'bob@example.test'), 'B');
  assert.equal(emailInitial(''), '');
});

test('nothing at all → "?"', () => {
  assert.equal(getInitials('', ''), '?');
  assert.equal(getInitials(undefined, null), '?');
  assert.equal(getInitials('—'), '?');
});
