import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_RECIPIENTS, addEntries, backspace, commitText, commitsOnKey, formatRecipient, fromList, initialRecipients, isValidAddress,
  parseRecipient, pillLabel, recipientList, removeEntry, replyAllRecipients, replyRecipients, sendBlockers, typeText,
} from './recipients.ts';

test('parseRecipient: name + address, bare and bracketed addresses, quoted names', () => {
  assert.deepEqual(parseRecipient('Anna Muster <anna@example.test>'), { name: 'Anna Muster', address: 'anna@example.test', valid: true });
  assert.deepEqual(parseRecipient(' bob@example.test '), { name: '', address: 'bob@example.test', valid: true });
  assert.deepEqual(parseRecipient('<c@example.test>'), { name: '', address: 'c@example.test', valid: true });
  assert.deepEqual(parseRecipient('"Doe, John" <j@example.test>'), { name: 'Doe, John', address: 'j@example.test', valid: true });
  assert.equal(parseRecipient('bob').valid, false);
  assert.equal(parseRecipient('bob@').valid, false);
  assert.equal(parseRecipient('a b@example.test').valid, false);
  assert.equal(parseRecipient('x@example.test\r\nBcc: y@example.test').valid, false, 'header injection');
});

test('isValidAddress follows the server rule (unicode domains ok, no TLD-less hosts)', () => {
  assert.ok(isValidAddress('user@mail.example.test'));
  assert.ok(isValidAddress('müller@bücher.example'));
  assert.equal(isValidAddress('user@localhost'), false);
  assert.equal(isValidAddress('user@-bad.example'), false);
  assert.equal(isValidAddress(`${'a'.repeat(65)}@example.test`), false);
});

test('formatRecipient quotes names with separators; pillLabel shows the name, else the address', () => {
  assert.equal(formatRecipient('Anna', 'a@example.test'), 'Anna <a@example.test>');
  assert.equal(formatRecipient('Doe, John', 'j@example.test'), '"Doe, John" <j@example.test>');
  assert.equal(formatRecipient('', 'a@example.test'), 'a@example.test');
  assert.equal(formatRecipient('A@Example.test', 'a@example.test'), 'a@example.test', 'name = address → address only');
  assert.equal(parseRecipient(formatRecipient('Say "hi", Bob', 'b@example.test')).name, 'Say "hi", Bob');
  assert.equal(pillLabel(parseRecipient('Anna <a@example.test>')), 'Anna');
  assert.equal(pillLabel(parseRecipient('a@example.test')), 'a@example.test');
});

test('typing: a separator commits the entries before it, the rest stays in the input', () => {
  assert.deepEqual(typeText(EMPTY_RECIPIENTS, 'anna@example.test'), { entries: [], text: 'anna@example.test' });
  assert.deepEqual(typeText(EMPTY_RECIPIENTS, 'anna@example.test,'), { entries: ['anna@example.test'], text: '' });
  assert.deepEqual(typeText(EMPTY_RECIPIENTS, 'a@example.test; b@exa'), { entries: ['a@example.test'], text: 'b@exa' });
  // quoted name with a comma is not split while it is being typed
  assert.deepEqual(typeText(EMPTY_RECIPIENTS, '"Doe, J'), { entries: [], text: '"Doe, J' });
  assert.deepEqual(typeText(EMPTY_RECIPIENTS, '"Doe,'), { entries: [], text: '"Doe,' });
  assert.deepEqual(typeText(EMPTY_RECIPIENTS, '"Doe, John" <j@example.test>, '), { entries: ['"Doe, John" <j@example.test>'], text: '' });
  // pasted list with line breaks
  assert.deepEqual(typeText(EMPTY_RECIPIENTS, 'a@example.test\nb@example.test\n'), { entries: ['a@example.test', 'b@example.test'], text: '' });
});

test('commit: duplicates (case-insensitive address) are dropped, empty text is cleared', () => {
  const v = fromList(['Anna <anna@example.test>']);
  assert.deepEqual(commitText({ ...v, text: 'ANNA@example.test, bob@example.test' }).entries, ['Anna <anna@example.test>', 'bob@example.test']);
  assert.deepEqual(commitText({ entries: ['a@example.test'], text: '   ' }), { entries: ['a@example.test'], text: '' });
  assert.deepEqual(addEntries(['a@example.test'], ['', ' a@EXAMPLE.test ', 'c@example.test']), ['a@example.test', 'c@example.test']);
  assert.deepEqual(fromList(['a@example.test', 'A@example.test']).entries, ['a@example.test']);
});

test('keys: , and ; always commit, Enter/Tab only with text (else Tab moves on)', () => {
  assert.ok(commitsOnKey(',', ''));
  assert.ok(commitsOnKey(';', 'x'));
  assert.ok(commitsOnKey('Enter', 'a@example.test'));
  assert.ok(commitsOnKey('Tab', 'a@example.test'));
  assert.equal(commitsOnKey('Tab', ''), false);
  assert.equal(commitsOnKey('Enter', '  '), false);
  assert.equal(commitsOnKey('a', 'x'), false);
});

test('remove: ✕ removes one pill, Backspace in the empty input the last one', () => {
  const v = fromList(['a@example.test', 'b@example.test', 'c@example.test']);
  assert.deepEqual(removeEntry(v, 1).entries, ['a@example.test', 'c@example.test']);
  assert.deepEqual(backspace(v), { value: { entries: ['a@example.test', 'b@example.test'], text: '' }, removed: 'c@example.test' });
  assert.deepEqual(backspace({ ...v, text: 'x' }).removed, null, 'text in the input: Backspace edits the text');
  assert.deepEqual(backspace(EMPTY_RECIPIENTS).removed, null);
});

test('recipientList includes the text still being typed; sendBlockers needs An and valid addresses', () => {
  assert.deepEqual(recipientList({ entries: ['a@example.test'], text: 'b@example.test' }), ['a@example.test', 'b@example.test']);
  const empty = { to: EMPTY_RECIPIENTS, cc: EMPTY_RECIPIENTS, bcc: EMPTY_RECIPIENTS };
  assert.deepEqual(sendBlockers(empty), { missingTo: true, invalid: [] });
  assert.deepEqual(sendBlockers({ ...empty, to: { entries: [], text: 'a@example.test' } }), { missingTo: false, invalid: [] });
  assert.deepEqual(
    sendBlockers({ to: fromList(['a@example.test', 'bob']), cc: fromList(['x@']), bcc: EMPTY_RECIPIENTS }),
    { missingTo: false, invalid: ['bob', 'x@'] },
  );
  assert.deepEqual(sendBlockers({ ...empty, cc: fromList(['a@example.test']) }).missingTo, true, 'Cc only is not enough (the server requires An)');
});

test('reply all: sender + original An in An, original Cc in Cc, without own addresses or duplicates', () => {
  const orig = {
    fromAddr: 'boss@example.test',
    toAddrs: ['me@example.test', 'Colleague <col@example.test>'],
    ccAddrs: ['team@example.test', 'COL@example.test', 'Shared <shared@example.test>'],
  };
  assert.deepEqual(replyAllRecipients(orig, ['me@example.test', 'shared@example.test']), {
    to: ['boss@example.test', 'Colleague <col@example.test>'],
    cc: ['team@example.test'],
  });
  // reply all to an own sent mail: the original recipients
  assert.deepEqual(replyAllRecipients({ fromAddr: 'me@example.test', toAddrs: ['a@example.test'], ccAddrs: ['b@example.test'] }, ['me@example.test']),
    { to: ['a@example.test'], cc: ['b@example.test'] });
});

test('initial recipients per mode (new mail keeps given recipients, forward starts empty)', () => {
  const orig = { fromAddr: 'boss@example.test', toAddrs: ['me@example.test', 'b@example.test'], ccAddrs: ['c@example.test'] };
  assert.deepEqual(initialRecipients('reply', orig, ['me@example.test']), { to: ['boss@example.test'], cc: [] });
  assert.deepEqual(initialRecipients('replyAll', orig, ['me@example.test']), { to: ['boss@example.test', 'b@example.test'], cc: ['c@example.test'] });
  assert.deepEqual(initialRecipients('forward', orig, []), { to: [], cc: [] });
  assert.deepEqual(initialRecipients('new', { toAddrs: ['x@example.test'] }, []), { to: ['x@example.test'], cc: [] });
  assert.deepEqual(initialRecipients('new', {}, []), { to: [], cc: [] });
});

test('reply: the sender; an own sent mail goes to its recipients', () => {
  assert.deepEqual(replyRecipients({ fromAddr: 'a@example.test', toAddrs: ['me@example.test'] }, ['me@example.test']), ['a@example.test']);
  assert.deepEqual(replyRecipients({ fromAddr: 'ME@example.test', toAddrs: ['a@example.test', 'b@example.test'] }, ['me@example.test']), ['a@example.test', 'b@example.test']);
  assert.deepEqual(replyRecipients({ fromAddr: '' }, []), []);
});
