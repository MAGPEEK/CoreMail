import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  comboKey, hasOperatorSyntax, keepActive, personSearch, suggestGroups, suggestTerm,
  type SuggestItem, type SuggestResponse,
} from './searchSuggest.ts';

const DATA: SuggestResponse = {
  people: [{ name: 'Anna Koch', address: 'Anna@Kunde.de' }, { name: '', address: 'anna.w@partner.de' }],
  messages: [{ id: 'm1', folderId: 'f1', folderName: 'Posteingang', subject: 'Angebot', fromName: 'Anna Koch', fromAddr: 'anna@kunde.de', date: '2026-01-01T00:00:00Z' }],
};

test('suggest term: 2+ characters, whitespace collapsed, operator syntax gets none', () => {
  assert.equal(suggestTerm('  an  na '), 'an na');
  assert.equal(suggestTerm('a'), '');
  assert.equal(suggestTerm(''), '');
  for (const q of ['from:anna', 'is:unread rechnung', '"angebot 2026"', 'rechnung -spam', 'in:sent x']) {
    assert.equal(hasOperatorSyntax(q), true, q);
    assert.equal(suggestTerm(q), '', q);
  }
  // a hyphen inside a word or a time is no operator
  assert.equal(suggestTerm('e-mail 12:30'), 'e-mail 12:30');
  assert.equal(personSearch('anna@kunde.de'), 'from:anna@kunde.de');
});

test('groups: recent searches only for an empty field; people + messages for a term; nothing otherwise', () => {
  const empty = suggestGroups('', DATA, ['rechnung', 'from:x@y.de']);
  assert.deepEqual(empty.groups.map((g) => g.key), ['recent']);
  assert.deepEqual(empty.flat.map((i) => i.key), ['r:rechnung', 'r:from:x@y.de']);
  assert.deepEqual(suggestGroups('   ', undefined, []).flat, []);

  const term = suggestGroups('anna', DATA, ['rechnung']);
  assert.deepEqual(term.groups.map((g) => g.key), ['people', 'messages']);
  assert.deepEqual(term.flat.map((i) => i.key), ['p:anna@kunde.de', 'p:anna.w@partner.de', 'm:m1']);

  assert.deepEqual(suggestGroups('a', DATA, ['x']).flat, [], 'one character: no suggestions (and no recent list)');
  assert.deepEqual(suggestGroups('from:anna', DATA, ['x']).flat, [], 'operators: plain full search');
  assert.deepEqual(suggestGroups('anna', undefined, ['x']).flat, [], 'nothing loaded yet');
  assert.deepEqual(suggestGroups('anna', { people: [], messages: DATA.messages }, []).groups.map((g) => g.key), ['messages']);
});

const state = (open: boolean, count: number, active: number, kinds: Array<SuggestItem['kind']> = []) =>
  ({ open, count, active, kindAt: (i: number) => kinds[i] });

test('keyboard: ↓/↑ move with wrap-around and open a closed list', () => {
  assert.deepEqual(comboKey('ArrowDown', state(true, 3, -1)), { type: 'move', index: 0 });
  assert.deepEqual(comboKey('ArrowDown', state(true, 3, 0)), { type: 'move', index: 1 });
  assert.deepEqual(comboKey('ArrowDown', state(true, 3, 2)), { type: 'move', index: 0 });
  assert.deepEqual(comboKey('ArrowUp', state(true, 3, -1)), { type: 'move', index: 2 });
  assert.deepEqual(comboKey('ArrowUp', state(true, 3, 0)), { type: 'move', index: 2 });
  assert.deepEqual(comboKey('ArrowUp', state(true, 3, 2)), { type: 'move', index: 1 });
  assert.deepEqual(comboKey('ArrowDown', state(false, 3, 1)), { type: 'move', index: 0 }, 'a closed list opens on the first entry');
  assert.equal(comboKey('ArrowDown', state(true, 0, -1)), null, 'nothing to move through');
  assert.equal(comboKey('ArrowUp', state(false, 0, -1)), null);
});

test('keyboard: Enter selects the highlighted entry, else runs the full search; Escape closes', () => {
  assert.deepEqual(comboKey('Enter', state(true, 3, 1)), { type: 'select', index: 1 });
  assert.deepEqual(comboKey('Enter', state(true, 3, -1)), { type: 'submit' });
  assert.deepEqual(comboKey('Enter', state(false, 3, 1)), { type: 'submit' }, 'a closed list selects nothing');
  assert.deepEqual(comboKey('Enter', state(true, 0, 0)), { type: 'submit' });
  assert.deepEqual(comboKey('Escape', state(true, 3, 1)), { type: 'close' });
  assert.equal(comboKey('Escape', state(false, 3, -1)), null, 'closed: the field keeps its own Escape (clear)');
  assert.equal(comboKey('a', state(true, 3, 1)), null);
  assert.equal(comboKey('Tab', state(true, 3, 1)), null);
});

test('keyboard: Delete removes a highlighted recent search only', () => {
  assert.deepEqual(comboKey('Delete', state(true, 2, 1, ['recent', 'recent'])), { type: 'remove', index: 1 });
  assert.equal(comboKey('Delete', state(true, 2, 0, ['person', 'message'])), null);
  assert.equal(comboKey('Delete', state(true, 2, -1, ['recent', 'recent'])), null);
  assert.equal(comboKey('Delete', state(false, 2, 0, ['recent'])), null);
});

test('the highlight follows its entry when the list changes', () => {
  const { flat } = suggestGroups('anna', DATA, []);
  assert.equal(keepActive('m:m1', flat), 2);
  assert.equal(keepActive('p:gone@x.de', flat), -1);
  assert.equal(keepActive(null, flat), -1);
});
