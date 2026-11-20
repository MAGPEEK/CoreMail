import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addRecentSearch, removeRecentSearch, parseRecentSearches, loadRecentSearches, saveRecentSearches, recentSearchKey,
  RECENT_SEARCH_LIMIT, RECENT_SEARCH_MAX_LENGTH, type StorageLike,
} from './recentSearches.ts';

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

test('add: newest first, trimmed, de-duplicated case-insensitively, at most 5', () => {
  let list: string[] = [];
  for (const term of ['Rechnung', 'angebot', '  from:anna@ex.com ', 'RECHNUNG', 'a', 'b', 'c']) list = addRecentSearch(list, term);
  assert.deepEqual(list, ['c', 'b', 'a', 'RECHNUNG', 'from:anna@ex.com']);
  assert.equal(list.length, RECENT_SEARCH_LIMIT);
  assert.deepEqual(addRecentSearch(['x'], '   '), ['x']);
  assert.deepEqual(addRecentSearch(['x'], 'y'.repeat(RECENT_SEARCH_MAX_LENGTH + 1)), ['x']);
  assert.deepEqual(addRecentSearch(['x'], 'a   b'), ['a b', 'x']);
});

test('remove: case-insensitive, the others keep their order', () => {
  assert.deepEqual(removeRecentSearch(['a', 'Rechnung', 'b'], 'rechnung'), ['a', 'b']);
  assert.deepEqual(removeRecentSearch(['a'], 'zzz'), ['a']);
});

test('parse: tolerant of anything a browser may hold', () => {
  assert.deepEqual(parseRecentSearches(null), []);
  assert.deepEqual(parseRecentSearches('not json'), []);
  assert.deepEqual(parseRecentSearches('{"a":1}'), []);
  assert.deepEqual(parseRecentSearches('["b", 3, null, "a", "B"]'), ['b', 'a']);
  assert.deepEqual(parseRecentSearches(JSON.stringify(['1', '2', '3', '4', '5', '6', '7'])), ['1', '2', '3', '4', '5']);
});

test('storage: one key per user, round trip, other users unaffected', () => {
  const s = memoryStorage();
  assert.equal(saveRecentSearches(s, 'u1', ['b', 'a']), true);
  assert.deepEqual(loadRecentSearches(s, 'u1'), ['b', 'a']);
  assert.deepEqual(loadRecentSearches(s, 'u2'), []);
  assert.deepEqual([...s.data.keys()], [recentSearchKey('u1')]);
});

test('storage failures never throw: no storage, no user, getItem/setItem throwing', () => {
  const broken: StorageLike = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.deepEqual(loadRecentSearches(broken, 'u1'), []);
  assert.equal(saveRecentSearches(broken, 'u1', ['a']), false);
  assert.deepEqual(loadRecentSearches(null, 'u1'), []);
  assert.equal(saveRecentSearches(memoryStorage(), null, ['a']), false);
  assert.deepEqual(loadRecentSearches(memoryStorage(), null), []);
});
