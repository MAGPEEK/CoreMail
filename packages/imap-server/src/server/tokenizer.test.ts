import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, tokenizePrefix, tokenToArg, literalMarker, ImapParseError, type Token } from './tokenizer.js';

const atom = (value: string): Token => ({ type: 'atom', value });
const quoted = (value: string): Token => ({ type: 'quoted', value });

test('splits atoms and quoted strings, keeping empty quoted strings', () => {
  assert.deepEqual(tokenize(['A1 LIST "" "*"']), [atom('A1'), atom('LIST'), quoted(''), quoted('*')]);
});

test('resolves \\" and \\\\ escapes inside quoted strings', () => {
  assert.deepEqual(tokenize(['A1 LOGIN "a\\"b" "c\\\\d e"']).slice(2), [quoted('a"b'), quoted('c\\d e')]);
});

test('rejects invalid escapes and unterminated strings', () => {
  assert.throws(() => tokenize(['A1 LOGIN "a\\x"']), ImapParseError);
  assert.throws(() => tokenize(['A1 LOGIN "abc']), ImapParseError);
});

test('groups parenthesised lists (nested)', () => {
  const tokens = tokenize(['A1 STATUS INBOX (MESSAGES (UNSEEN SIZE))']);
  assert.deepEqual(tokens[3], {
    type: 'list',
    items: [atom('MESSAGES'), { type: 'list', items: [atom('UNSEEN'), atom('SIZE')] }],
  });
  assert.equal(tokenToArg(tokens[3] as Token), '(MESSAGES (UNSEEN SIZE))');
});

test('rejects unbalanced parentheses', () => {
  assert.throws(() => tokenize(['A1 STATUS INBOX (MESSAGES']), ImapParseError);
  assert.throws(() => tokenize(['A1 NOOP )']), ImapParseError);
});

test('keeps bracketed sections inside one atom', () => {
  const tokens = tokenize(['A1 FETCH 1 (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM)] UID)']);
  assert.equal(tokenToArg(tokens[3] as Token), '(BODY.PEEK[HEADER.FIELDS (SUBJECT FROM)] UID)');
});

test('turns literal segments into literal tokens', () => {
  const tokens = tokenize(['A1 LOGIN {3+}', Buffer.from('bob'), ' {2}', Buffer.from('pw'), '']);
  assert.deepEqual(tokens.map(tokenToArg), ['A1', 'LOGIN', 'bob', 'pw']);
  assert.equal(tokens[2]?.type, 'literal');
});

test('literal octets are kept byte-exact', () => {
  const body = Buffer.from([0x00, 0xff, 0x0d, 0x0a]);
  const tokens = tokenize(['A1 APPEND INBOX (\\Seen) {4}', body, '']);
  const last = tokens[tokens.length - 1];
  assert.ok(last?.type === 'literal' && last.value.equals(body));
});

test('literalMarker detects synchronizing and non-synchronizing literals', () => {
  assert.deepEqual(literalMarker('A1 APPEND x {12}'), { size: 12, sync: true });
  assert.deepEqual(literalMarker('A1 APPEND x {12+}'), { size: 12, sync: false });
  assert.equal(literalMarker('A1 NOOP {12} x'), null);
});

test('tokenizePrefix ignores the trailing literal marker', () => {
  assert.deepEqual(tokenizePrefix(['A1 APPEND "Sent Items" (\\Seen) {10}']).map(tokenToArg), ['A1', 'APPEND', 'Sent Items', '(\\Seen)']);
});
