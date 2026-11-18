/**
 * 9.4 change scope: when recorded mailbox changes are published — after the
 * commit of their transaction, after a deferred unit of work, never after a
 * rollback — against a fake client whose `$transaction(fn)` just runs fn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MailboxChangeEvent } from '@coremail/core/realtime';
import {
  deferMailboxChanges, installChangeScope, recordMailboxChange, setMailboxChangePublisher,
} from './change-scope.js';

function client() {
  const c = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) };
  installChangeScope(c);
  return c as { $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> };
}

function capture(): MailboxChangeEvent[] {
  const seen: MailboxChangeEvent[] = [];
  setMailboxChangePublisher(async (e) => { seen.push(e); });
  return seen;
}

const change = (mailboxId: string, folderId: string): MailboxChangeEvent => ({ mailboxId, kinds: ['messages'], folderIds: [folderId] });

test('deferMailboxChanges holds the committed transaction changes until the unit of work finished', async () => {
  const seen = capture();
  const db = client();
  await deferMailboxChanges(async () => {
    await db.$transaction(async () => { recordMailboxChange(change('mb1', 'inbox')); });
    assert.deepEqual(seen, [], 'not yet — counters / attachments still follow');
    recordMailboxChange({ mailboxId: 'mb1', kinds: ['flags'], folderIds: ['inbox'] });
  });
  assert.deepEqual(seen, [{ mailboxId: 'mb1', kinds: ['messages', 'flags'], folderIds: ['inbox'] }]);
});

test('deferMailboxChanges publishes committed changes when the unit of work fails later', async () => {
  const seen = capture();
  const db = client();
  await assert.rejects(deferMailboxChanges(async () => {
    await db.$transaction(async () => { recordMailboxChange(change('mb1', 'inbox')); });
    await assert.rejects(db.$transaction(async () => {
      recordMailboxChange(change('mb1', 'junk'));
      throw new Error('rollback');
    }));
    throw new Error('attachment upload failed');
  }));
  assert.deepEqual(seen, [change('mb1', 'inbox')], 'the rolled-back transaction is not announced');
});

test('a transaction started inside a transaction publishes on its own commit, whatever the outer one does', async () => {
  const seen = capture();
  const db = client();
  await assert.rejects(db.$transaction(async () => {
    recordMailboxChange(change('mb1', 'outer'));
    await db.$transaction(async () => { recordMailboxChange(change('mb2', 'inner')); });
    assert.deepEqual(seen, [change('mb2', 'inner')]);
    throw new Error('outer rollback');
  }));
  assert.deepEqual(seen, [change('mb2', 'inner')]);
});

test('nested deferred scopes hand their changes to the outermost one', async () => {
  const seen = capture();
  await deferMailboxChanges(async () => {
    await deferMailboxChanges(async () => { recordMailboxChange(change('mb1', 'a')); });
    assert.deepEqual(seen, []);
  });
  assert.deepEqual(seen, [change('mb1', 'a')]);
  setMailboxChangePublisher(null);
});
