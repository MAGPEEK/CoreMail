/**
 * 9.4 mailbox management in JMAP: access audit events of foreign accounts,
 * principals hidden from the address list, per-mailbox send limit SetErrors.
 * Run: node --import tsx --import ./src/test-env.ts --test src/mailbox-mgmt.test.ts  (in packages/jmap-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { foreignTarget, emailSetAccessEvents, mailboxSetAccessEvents } = await import('./access-audit.js');
const { principalListed } = await import('./methods/principal.js');
const { sendLimitSetError, foreignSendFields } = await import('./methods/submission.js');

const base = { name: 'n', readOnly: false, maySend: true };
const own = { ...base, accountId: 'u1', mailboxId: 'mb1', ownerUserId: 'u1', sharedMailboxId: null, email: 'me@x.test', isPersonal: true };
const shared = { ...base, accountId: 'shared-s1', mailboxId: 'mb-s1', ownerUserId: null, sharedMailboxId: 's1', email: 'team@x.test', isPersonal: false };
const delegated = { ...base, accountId: 'o1', mailboxId: 'mb-o1', ownerUserId: 'o1', sharedMailboxId: null, email: 'owner@x.test', isPersonal: false };

test('audit target: none for the own account, sharedMailbox for shared, the owner mailbox for delegations', () => {
  assert.equal(foreignTarget(own), null);
  assert.deepEqual(foreignTarget(shared), { kind: 'shared', sharedMailboxId: 's1', mailboxId: 'mb-s1', email: 'team@x.test' });
  assert.deepEqual(foreignTarget(delegated), { kind: 'delegated', sharedMailboxId: null, mailboxId: 'mb-o1', email: 'owner@x.test' });
});

test('Email/set: moves are updates that change mailboxIds, destroys are deletes; flag changes are not audited', () => {
  const update = { e1: { 'mailboxIds/f2': true }, e2: { 'keywords/$seen': true }, e3: { mailboxIds: { f3: true } }, e4: { mailboxIds: { f4: true } } };
  const response = { updated: { e1: null, e2: null, e3: null }, destroyed: ['e5', 'e6'] };
  assert.deepEqual(emailSetAccessEvents(update, response), [
    { action: 'mailbox.foreign.message.move', count: 2 },
    { action: 'mailbox.foreign.message.delete', count: 2 },
  ]);
  assert.deepEqual(emailSetAccessEvents({ e2: { 'keywords/$seen': true } }, { updated: { e2: null }, destroyed: null }), []);
});

test('Mailbox/set: created / updated / destroyed folders', () => {
  assert.deepEqual(mailboxSetAccessEvents({ created: { k: { id: 'f9' } }, updated: {}, destroyed: ['f1', 'f2'] }), [
    { action: 'mailbox.foreign.folder.create', count: 1 },
    { action: 'mailbox.foreign.folder.delete', count: 2 },
  ]);
});

test('principals: hidden mailboxes are listed only when the caller has an account for them', () => {
  assert.equal(principalListed(undefined, false), true);
  assert.equal(principalListed(false, false), true);
  assert.equal(principalListed(true, false), false);
  assert.equal(principalListed(true, true), true);
});

test('per-mailbox send limits map to tooLarge (maxSize) / tooManyRecipients (maxRecipients)', () => {
  assert.equal(sendLimitSetError({ ok: true }), null);
  assert.deepEqual(sendLimitSetError({ ok: false, kind: 'size', limit: 1024 }), {
    type: 'tooLarge', description: "message exceeds the sender's size limit of 1024 octets", maxSize: 1024,
  });
  const many = sendLimitSetError({ ok: false, kind: 'recipients', limit: 3 }) as unknown as Record<string, unknown>;
  assert.equal(many['type'], 'tooManyRecipients');
  assert.equal(many['maxRecipients'], 3);
});

test('EmailSubmission: send-as step from the personal account (audit + copy), audit only from a Shared Mailbox account', () => {
  assert.deepEqual(foreignSendFields(own), { foreignSendSource: 'jmap' });
  assert.deepEqual(foreignSendFields(shared), { foreignSendSource: 'jmap', foreignSendAuditOnly: true },
    'the Email already lives in the shared mailbox — no second Sent copy, but the send is audited');
  assert.deepEqual(foreignSendFields(delegated), {});
});
