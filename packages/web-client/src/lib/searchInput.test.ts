import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendSearchToken } from './searchInput.ts';

test('search operator: appended with one space, caret at the end', () => {
  assert.deepEqual(appendSearchToken('', 'from:'), { value: 'from:', caret: 5 });
  assert.deepEqual(appendSearchToken('  rechnung  ', 'is:unread'), { value: 'rechnung is:unread', caret: 18 });
});

test('phrase operator: caret between the quotes', () => {
  assert.deepEqual(appendSearchToken('', '""'), { value: '""', caret: 1 });
  assert.deepEqual(appendSearchToken('a', '""'), { value: 'a ""', caret: 3 });
});
