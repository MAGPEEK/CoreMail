import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagsToKeywords, keywordsToFlags, isValidKeyword, roleForFolder } from './keywords.js';

test('IMAP-Flags ↔ JMAP-Keywords round-trip', () => {
  assert.deepEqual(flagsToKeywords(['\\Seen', '\\Flagged', '$Forwarded', 'MyLabel', '\\Recent']), { $seen: true, $flagged: true, $forwarded: true, mylabel: true });
  assert.deepEqual(keywordsToFlags({ $seen: true, $draft: true, custom: true, ignored: false }).sort(), ['\\Draft', '\\Seen', 'custom'].sort());
});

test('Keyword-Syntax (RFC 8621 §4.1.1)', () => {
  assert.ok(isValidKeyword('$seen'));
  assert.ok(isValidKeyword('Projekt-X'));
  assert.ok(!isValidKeyword('has space'));
  assert.ok(!isValidKeyword('a(b)'));
  assert.ok(!isValidKeyword(''));
});

test('Folder roles only on top level', () => {
  assert.equal(roleForFolder('INBOX', null), 'inbox');
  assert.equal(roleForFolder('Junk', null), 'junk');
  assert.equal(roleForFolder('Sent', 'parent'), null);
  assert.equal(roleForFolder('Projekte', null), null);
});
