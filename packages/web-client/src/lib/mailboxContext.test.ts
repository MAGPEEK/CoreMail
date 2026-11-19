import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWN_MAILBOX, mailboxKey, parseMailboxKey, mailApiBase, foldersQueryKey, mailPageUrl, sameMailbox,
  permissionLabel, permissionSummary, isReadOnlyMailbox, findMailboxEntry, visibleMailboxes,
  senderOptions, senderDraftFields, senderFromDraft, toggleExpanded, PERMISSION_LABELS,
  type AccessibleMailboxEntry,
} from './mailboxContext.ts';
import { recoverableApiBase, recoverableQueryKey } from './recoverable.ts';

const entry = (over: Partial<AccessibleMailboxEntry>): AccessibleMailboxEntry => ({
  ref: 'shared:sm1', kind: 'shared', id: 'sm1', email: 'team@ex.com', displayName: 'Team',
  readOnly: false, permissions: ['FULL_ACCESS'], hidden: false, ...over,
});

test('mailbox keys round-trip; anything invalid is the own mailbox', () => {
  assert.equal(mailboxKey(OWN_MAILBOX), 'own');
  assert.equal(mailboxKey({ kind: 'shared', id: 'sm1' }), 'shared:sm1');
  assert.equal(mailboxKey({ kind: 'delegated', id: 'mb_2' }), 'delegated:mb_2');
  assert.deepEqual(parseMailboxKey('shared:sm1'), { kind: 'shared', id: 'sm1' });
  assert.deepEqual(parseMailboxKey('delegated:mb-2'), { kind: 'delegated', id: 'mb-2' });
  for (const bad of [null, undefined, '', 'own', 'shared:', 'team:sm1', 'shared:../x', 'shared:a/b', `shared:${'x'.repeat(65)}`]) {
    assert.deepEqual(parseMailboxKey(bad), OWN_MAILBOX, String(bad));
  }
  assert.ok(sameMailbox(parseMailboxKey('shared:sm1'), { kind: 'shared', id: 'sm1' }));
  assert.ok(!sameMailbox({ kind: 'shared', id: 'x' }, { kind: 'delegated', id: 'x' }));
});

test('API base, folder query key and page URL per mailbox kind', () => {
  assert.equal(mailApiBase(OWN_MAILBOX), '/mail');
  assert.equal(mailApiBase({ kind: 'shared', id: 'sm1' }), '/mail/shared-mailboxes/sm1');
  assert.equal(mailApiBase({ kind: 'delegated', id: 'mb1' }), '/mail/delegated-mailboxes/mb1');
  assert.deepEqual(foldersQueryKey(OWN_MAILBOX), ['folders'], 'own key unchanged (prefix of all folder keys)');
  assert.deepEqual(foldersQueryKey({ kind: 'shared', id: 'sm1' }), ['folders', 'shared:sm1']);
  assert.equal(mailPageUrl(OWN_MAILBOX), '/mail');
  assert.equal(mailPageUrl({ kind: 'shared', id: 'sm1' }), '/mail/shared%3Asm1');
  // recover deleted items: delegated mailboxes use the 9.1 delegated route
  assert.equal(recoverableApiBase({ kind: 'delegated', id: 'mb1' }), '/mail/delegated-mailboxes/mb1/recoverable');
  assert.deepEqual(recoverableQueryKey({ kind: 'delegated', id: 'mb1' }), ['recoverable', 'delegated', 'mb1']);
});

test('German permission labels (schema enum SharedMailboxPermType) — no raw enum text', () => {
  assert.deepEqual(Object.keys(PERMISSION_LABELS).sort(), ['FOLDER_PERMISSIONS', 'FULL_ACCESS', 'READ_ONLY', 'SEND_AS', 'SEND_ON_BEHALF']);
  assert.equal(permissionLabel('FULL_ACCESS'), 'Vollzugriff');
  assert.equal(permissionLabel('SEND_AS'), 'Senden als');
  assert.equal(permissionLabel('SEND_ON_BEHALF'), 'Senden im Auftrag');
  assert.equal(permissionLabel('READ_ONLY'), 'Nur lesen');
  // the 9.2 banner showed "Vollzugriff · full access · send as"
  assert.equal(permissionSummary(['SEND_AS', 'FULL_ACCESS', 'SEND_AS']), 'Vollzugriff · Senden als');
  assert.equal(permissionSummary(['SEND_ON_BEHALF', 'READ_ONLY']), 'Nur lesen · Senden im Auftrag');
  assert.doesNotMatch(permissionSummary(['FULL_ACCESS', 'SEND_AS', 'SEND_ON_BEHALF', 'READ_ONLY']), /_|access|bsendb|behalf/i);
});

test('w3: a folder-scoped mailbox entry reads "Ordnerberechtigungen"', () => {
  assert.equal(permissionLabel('FOLDER_PERMISSIONS'), 'Ordnerberechtigungen');
  assert.equal(permissionSummary(['FOLDER_PERMISSIONS']), 'Ordnerberechtigungen');
  assert.equal(permissionSummary(['FOLDER_PERMISSIONS', 'READ_ONLY']), 'Nur lesen · Ordnerberechtigungen');
});

test('read-only: own never, foreign by entry, unknown/loading foreign = read-only', () => {
  const list = [entry({}), entry({ ref: 'delegated:mb1', kind: 'delegated', id: 'mb1', readOnly: true, permissions: ['READ_ONLY'] })];
  assert.equal(isReadOnlyMailbox(OWN_MAILBOX, undefined), false);
  assert.equal(isReadOnlyMailbox({ kind: 'shared', id: 'sm1' }, list), false);
  assert.equal(isReadOnlyMailbox({ kind: 'delegated', id: 'mb1' }, list), true);
  assert.equal(isReadOnlyMailbox({ kind: 'shared', id: 'gone' }, list), true);
  assert.equal(isReadOnlyMailbox({ kind: 'shared', id: 'sm1' }, undefined), true);
  assert.equal(findMailboxEntry({ kind: 'shared', id: 'sm1' }, list)?.email, 'team@ex.com');
  assert.equal(findMailboxEntry(OWN_MAILBOX, list), undefined);
  assert.deepEqual(visibleMailboxes([entry({ hidden: true }), entry({ ref: 'shared:b', id: 'b' })]).map((e) => e.ref), ['shared:b']);
  assert.deepEqual(visibleMailboxes(undefined), []);
});

test('compose sender options mirror the server rule (SEND_AS/FULL_ACCESS, SEND_ON_BEHALF; delegations none)', () => {
  const me = 'me@ex.com';
  assert.deepEqual(senderOptions(me, undefined).map((o) => o.mode), ['self']);
  assert.deepEqual(senderOptions(me, entry({ kind: 'delegated', ref: 'delegated:x', permissions: ['FULL_ACCESS'] })).map((o) => o.mode), ['self']);
  assert.deepEqual(senderOptions(me, entry({ permissions: ['READ_ONLY'] })).map((o) => o.mode), ['self']);
  const both = senderOptions(me, entry({ permissions: ['READ_ONLY', 'SEND_AS', 'SEND_ON_BEHALF'] }));
  assert.deepEqual(both.map((o) => o.mode), ['sendAs', 'sendOnBehalfOf', 'self'], 'shared identity is the default');
  assert.match(both[0]!.label, /Senden als/);
  assert.match(both[1]!.label, /im Auftrag von Team <team@ex\.com>/);
  assert.deepEqual(senderOptions(me, entry({ permissions: ['FULL_ACCESS'] })).map((o) => o.mode), ['sendAs', 'self']);
  assert.deepEqual(senderDraftFields(both[0]), { sendAs: 'team@ex.com' });
  assert.deepEqual(senderDraftFields(both[1]), { sendOnBehalfOf: 'team@ex.com' });
  assert.deepEqual(senderDraftFields(both[2]), {});
  assert.deepEqual(senderDraftFields(undefined), {});
  assert.equal(senderFromDraft('team@ex.com', null, me)?.mode, 'sendAs');
  assert.equal(senderFromDraft(null, 'team@ex.com', me)?.mode, 'sendOnBehalfOf');
  assert.equal(senderFromDraft(null, null, me), undefined);
});

test('expanded mailbox roots toggle without duplicates', () => {
  assert.deepEqual(toggleExpanded([], 'shared:a'), ['shared:a']);
  assert.deepEqual(toggleExpanded(['shared:a'], 'shared:a'), []);
  assert.deepEqual(toggleExpanded(['shared:a'], 'shared:a', true), ['shared:a']);
  assert.deepEqual(toggleExpanded(['shared:a'], 'shared:b', false), ['shared:a']);
});
