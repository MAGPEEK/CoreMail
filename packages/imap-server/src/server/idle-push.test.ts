/**
 * IMAP IDLE push routing (9.4): which idling sessions a mailbox change wakes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idleWakes, queueIdleSync } from './idle-push.js';

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

test('wake-ups coalesce while a re-read waits to start; a change during a running re-read queues one more', async () => {
  const queue: Array<() => Promise<void>> = [];
  const state: { idleSyncQueued?: boolean } = {};
  let syncs = 0;
  const wake = () => queueIdleSync(state, (run) => { queue.push(run); }, async () => { syncs++; });

  assert.equal(wake(), true);
  assert.equal(wake(), false, 'second wake-up joins the waiting re-read');
  assert.equal(wake(), false);
  assert.equal(queue.length, 1);

  const running = queue.shift()!();
  assert.equal(wake(), true, 'the waiting re-read started — a new change needs another one');
  await running;
  await queue.shift()!();
  assert.equal(syncs, 2);
  assert.equal(state.idleSyncQueued, false);
});
