/**
 * 9.4 "Zugriffe auf mein Postfach" labels.
 * Run: node --test src/lib/mailboxAccessLog.test.ts  (in packages/web-client)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessActionLabel, accessSourceLabel } from './mailboxAccessLog.ts';

test('action labels with count and folder; unknown actions shown as is', () => {
  assert.equal(accessActionLabel({ action: 'open' }), 'Postfach geöffnet');
  assert.equal(accessActionLabel({ action: 'message.delete', count: 3, folder: 'INBOX' }), 'Nachrichten gelöscht (3) · INBOX');
  assert.equal(accessActionLabel({ action: 'something.new' }), 'something.new');
});

test('client labels', () => {
  assert.equal(accessSourceLabel('imap'), 'IMAP');
  assert.equal(accessSourceLabel('activesync'), 'Mobilgerät (ActiveSync)');
  assert.equal(accessSourceLabel(null), '—');
});
