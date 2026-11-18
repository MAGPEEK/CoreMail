/**
 * IMAP IDLE push routing (9.4): which idling sessions a mailbox change wakes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idleWakes } from './idle-push.js';

const idling = (mailboxId: string, folderId: string) => ({ idleActive: true, selected: { mailboxId, folderId } });

test('a message change of the selected folder wakes the idling session', () => {
  assert.equal(idleWakes({ mailboxId: 'mb1', kinds: ['messages'], folderIds: ['inbox'] }, idling('mb1', 'inbox')), true);
  assert.equal(idleWakes({ mailboxId: 'mb1', kinds: ['flags'] }, idling('mb1', 'inbox')), true, 'unknown folders → wake');
});

test('other folders, other mailboxes, folder-list changes and non-idling sessions stay asleep', () => {
  assert.equal(idleWakes({ mailboxId: 'mb1', kinds: ['messages'], folderIds: ['work'] }, idling('mb1', 'inbox')), false);
  assert.equal(idleWakes({ mailboxId: 'mb2', kinds: ['messages'] }, idling('mb1', 'inbox')), false);
  assert.equal(idleWakes({ mailboxId: 'mb1', kinds: ['folders'] }, idling('mb1', 'inbox')), false);
  assert.equal(idleWakes({ mailboxId: 'mb1', kinds: ['messages'] }, { idleActive: false, selected: { mailboxId: 'mb1', folderId: 'inbox' } }), false);
  assert.equal(idleWakes({ mailboxId: 'mb1', kinds: ['messages'] }, { idleActive: true, selected: null }), false);
});

test('a shared mailbox folder is matched by its own mailbox id, whoever idles on it', () => {
  assert.equal(idleWakes({ mailboxId: 'mb-team', kinds: ['messages'], folderIds: ['team-inbox'] }, idling('mb-team', 'team-inbox')), true);
});
