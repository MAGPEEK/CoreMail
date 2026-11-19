import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryCounts, contactInfoLines, countLabel, filterByCategory, isOwnContact, nameParts, primaryPhone,
  sameView, sortContacts, telHref, ALL_CONTACTS_VIEW, type ListContact,
} from './contactsList.ts';

const c = (id: string, displayName: string, extra: Partial<ListContact> = {}): ListContact => ({ id, displayName, email: `${id}@example.test`, ...extra });

test('nameParts reads both name orders', () => {
  assert.deepEqual(nameParts('Anna Maria Beispiel'), { given: 'Anna Maria', family: 'Beispiel' });
  assert.deepEqual(nameParts('Beispiel, Anna'), { given: 'Anna', family: 'Beispiel' });
  assert.deepEqual(nameParts('Cher'), { given: 'Cher', family: '' });
});

test('sortContacts by given and family name (umlauts, case) without mutating', () => {
  const list = [c('1', 'Zoe Adler'), c('2', 'Änne Zander'), c('3', 'bob Müller')];
  assert.deepEqual(sortContacts(list, 'given').map((x) => x.id), ['2', '3', '1']);
  assert.deepEqual(sortContacts(list, 'family').map((x) => x.id), ['1', '3', '2']);
  assert.deepEqual(list.map((x) => x.id), ['1', '2', '3']);
});

test('isOwnContact drops address-list entries and lists', () => {
  assert.equal(isOwnContact({ id: 'abc' }), true);
  assert.equal(isOwnContact({ id: 'gal-1' }), false);
  assert.equal(isOwnContact({ id: 'group-1' }), false);
});

test('primaryPhone prefers the typed list, then mobile, then phone', () => {
  assert.equal(primaryPhone({ phones: [{ value: ' ' }, { value: '+49 1' }], mobile: '2', phone: '3' }), '+49 1');
  assert.equal(primaryPhone({ mobile: '2', phone: '3' }), '2');
  assert.equal(primaryPhone({ phone: '3' }), '3');
  assert.equal(primaryPhone({ mobile: '', phone: ' ' }), null);
});

test('telHref keeps digits and the plus only', () => {
  assert.equal(telHref('+49 (30) 12-34'), 'tel:+4930 1234'.replace(' ', ''));
});

test('contactInfoLines lists the primary e-mail and phone', () => {
  assert.deepEqual(contactInfoLines(c('1', 'A', { mobile: '0171' })), ['1@example.test', '0171']);
  assert.deepEqual(contactInfoLines({ id: '2', displayName: 'B', email: '' }), []);
});

test('categoryCounts merges spellings case-insensitively and sorts', () => {
  const list = [c('1', 'A', { categories: ['Kunde', 'VIP'] }), c('2', 'B', { categories: ['kunde'] }), c('3', 'C')];
  assert.deepEqual(categoryCounts(list), [{ name: 'Kunde', count: 2 }, { name: 'VIP', count: 1 }]);
});

test('filterByCategory', () => {
  const list = [c('1', 'A', { categories: ['Kunde'] }), c('2', 'B')];
  assert.deepEqual(filterByCategory(list, 'kunde').map((x) => x.id), ['1']);
  assert.equal(filterByCategory(list, null).length, 2);
});

test('sameView compares kind and category', () => {
  assert.equal(sameView(ALL_CONTACTS_VIEW, { kind: 'contacts', category: null }), true);
  assert.equal(sameView(ALL_CONTACTS_VIEW, { kind: 'contacts', category: 'x' }), false);
  assert.equal(sameView({ kind: 'groups' }, { kind: 'directory' }), false);
  assert.equal(sameView({ kind: 'groups' }, { kind: 'groups' }), true);
});

test('countLabel pluralises', () => {
  assert.equal(countLabel(1, 'Kontakt', 'Kontakte'), '1 Kontakt');
  assert.equal(countLabel(0, 'Kontakt', 'Kontakte'), '0 Kontakte');
});
