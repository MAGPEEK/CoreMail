import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRecoverShared, recoverableApiBase, recoverableQueryKey } from './recoverable.ts';
import { quotaPath, quotaQueryKey } from './quota.ts';

test('recover deleted items: own vs shared mailbox API and query key', () => {
  assert.equal(recoverableApiBase(), '/mail/recoverable');
  assert.equal(recoverableApiBase({ kind: 'own' }), '/mail/recoverable');
  assert.equal(recoverableApiBase({ kind: 'shared', id: 'sm1' }), '/user/shared-mailboxes/sm1/recoverable');
  assert.equal(recoverableApiBase({ kind: 'shared', id: 'a/../b' }), '/user/shared-mailboxes/a%2F..%2Fb/recoverable', 'id is encoded');
  assert.deepEqual(recoverableQueryKey(), ['recoverable']);
  assert.deepEqual(recoverableQueryKey({ kind: 'shared', id: 'sm1' }), ['recoverable', 'shared', 'sm1']);
  assert.notDeepEqual(recoverableQueryKey({ kind: 'shared', id: 'sm1' }), recoverableQueryKey({ kind: 'shared', id: 'sm2' }));
});

test('only FULL_ACCESS offers "Recover deleted items" in a shared mailbox', () => {
  assert.equal(canRecoverShared(['FULL_ACCESS']), true);
  assert.equal(canRecoverShared(['SEND_AS', 'FULL_ACCESS']), true);
  assert.equal(canRecoverShared(['READ_ONLY']), false);
  assert.equal(canRecoverShared(['SEND_AS', 'SEND_ON_BEHALF']), false);
  assert.equal(canRecoverShared([]), false);
});

test('quota of the open shared mailbox vs the own quota', () => {
  assert.equal(quotaPath(), '/user/quota');
  assert.equal(quotaPath(null), '/user/quota');
  assert.equal(quotaPath('sm1'), '/user/shared-mailboxes/sm1/quota');
  assert.deepEqual(quotaQueryKey(), ['user-quota']);
  assert.deepEqual(quotaQueryKey('sm1'), ['shared-mailbox-quota', 'sm1']);
});
