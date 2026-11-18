/**
 * Foreign mailbox access policy (IMAP shared/delegated namespaces, v9.1).
 * Run: node --import tsx --test src/mailbox-access.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFromRows, listAccessibleMailboxes } from './mailbox-access.js';

const shared = (id: string, email: string, permission: string, over: Record<string, unknown> = {}) => ({
  permission,
  sharedMailbox: { id, email, displayName: email, active: true, mailbox: { id: `mb-${id}` }, ...over },
});
const delegate = (id: string, email: string, permission: string, over: Record<string, unknown> = {}) => ({
  permission,
  mailbox: { id: `mb-${id}`, user: { id, email, displayName: null, active: true, ...over } },
});

test('FULL_ACCESS is read-write, READ_ONLY is read-only, several rows per box are merged', () => {
  const out = accessFromRows('u1', [
    shared('s1', 'Team@Example.test', 'READ_ONLY'),
    shared('s1', 'Team@Example.test', 'FULL_ACCESS'),
    shared('s2', 'ro@example.test', 'READ_ONLY'),
  ], []);
  assert.deepEqual(out.map((a) => [a.email, a.readOnly, a.kind]), [
    ['ro@example.test', true, 'shared'], ['team@example.test', false, 'shared'],
  ]);
});

test('SEND_AS / SEND_ON_BEHALF alone grant no mailbox access', () => {
  const out = accessFromRows('u1', [shared('s1', 'a@x.test', 'SEND_AS'), shared('s2', 'b@x.test', 'SEND_ON_BEHALF')],
    [delegate('u2', 'c@x.test', 'SEND_AS')]);
  assert.deepEqual(out, []);
});

test('inactive shared mailboxes, boxes without a mailbox row and inactive owners are excluded', () => {
  const out = accessFromRows('u1', [
    shared('s1', 'off@x.test', 'FULL_ACCESS', { active: false }),
    shared('s2', 'nombx@x.test', 'FULL_ACCESS', { mailbox: null }),
  ], [delegate('u2', 'gone@x.test', 'FULL_ACCESS', { active: false })]);
  assert.deepEqual(out, []);
});

test('delegations: FULL_ACCESS read-write, READ_ONLY read-only, never the own mailbox', () => {
  const out = accessFromRows('u1', [], [
    delegate('u2', 'alice@x.test', 'FULL_ACCESS'),
    delegate('u3', 'carol@x.test', 'READ_ONLY'),
    delegate('u1', 'self@x.test', 'FULL_ACCESS'),
  ]);
  assert.deepEqual(out.map((a) => [a.kind, a.email, a.readOnly, a.ownerUserId]), [
    ['delegated', 'alice@x.test', false, 'u2'], ['delegated', 'carol@x.test', true, 'u3'],
  ]);
});

test("listAccessibleMailboxes queries only the caller's grants with read permissions", async () => {
  const seen: unknown[] = [];
  const db = {
    sharedMailboxPerm: { findMany: async (args: never) => { seen.push(args); return [shared('s1', 't@x.test', 'FULL_ACCESS')]; } },
    mailboxDelegate: { findMany: async (args: never) => { seen.push(args); return []; } },
  };
  const out = await listAccessibleMailboxes(db, 'u9');
  assert.equal(out.length, 1);
  const [s, d] = seen as Array<{ where: Record<string, unknown> }>;
  assert.deepEqual(s!.where, { userId: 'u9', permission: { in: ['FULL_ACCESS', 'READ_ONLY'] } });
  assert.deepEqual(d!.where, { granteeId: 'u9', permission: { in: ['FULL_ACCESS', 'READ_ONLY'] } });
});

test('reservedFolderPrefix: IMAP namespace prefixes (any case), env overrides, disabled prefixes', async () => {
  const { reservedFolderPrefix, reservedNamespacePrefixes } = await import('./mailbox-access.js');
  assert.deepEqual(reservedNamespacePrefixes({}), ['Other Users', 'Shared']);
  assert.equal(reservedFolderPrefix('Shared/x', {}), 'Shared');
  assert.equal(reservedFolderPrefix('sHaReD/x', {}), 'Shared');
  assert.equal(reservedFolderPrefix('other users/a@b/INBOX', {}), 'Other Users');
  assert.equal(reservedFolderPrefix('Shared', {}), null, 'the bare level is not reserved');
  assert.equal(reservedFolderPrefix('SharedStuff/x', {}), null);
  assert.equal(reservedFolderPrefix('Projects', {}), null);
  assert.equal(reservedFolderPrefix('Public/x', { IMAP_NAMESPACE_SHARED: 'Public' }), 'Public');
  assert.equal(reservedFolderPrefix('Shared/x', { IMAP_NAMESPACE_SHARED: 'Public' }), null);
  assert.equal(reservedFolderPrefix('Shared/x', { IMAP_NAMESPACE_SHARED: 'off' }), null);
  assert.equal(reservedFolderPrefix('Shared/x', { IMAP_NAMESPACE_SHARED: 'bad/prefix.x' }), 'Shared', 'invalid → default');
});

test('9.4 auto-mapping: default on, off only when every read grant has it off; delegations carry their flag', async () => {
  const { isMailboxMapped, accessibleMailboxRef } = await import('./mailbox-access.js');
  const out = accessFromRows('u1', [
    { ...shared('s1', 'a@x.test', 'READ_ONLY'), autoMap: false },
    { ...shared('s1', 'a@x.test', 'FULL_ACCESS'), autoMap: true },
    { ...shared('s2', 'b@x.test', 'FULL_ACCESS'), autoMap: false },
    shared('s3', 'c@x.test', 'FULL_ACCESS'),
  ], [{ ...delegate('o1', 'owner@x.test', 'FULL_ACCESS'), autoMap: false }]);
  const byEmail = new Map(out.map((a) => [a.email, a]));
  assert.equal(byEmail.get('a@x.test')!.autoMap, true, 'one auto-mapped read grant suffices');
  assert.equal(byEmail.get('b@x.test')!.autoMap, false);
  assert.equal(byEmail.get('c@x.test')!.autoMap, true, 'rows without the column (pre-9.4 fakes) are auto-mapped');
  assert.equal(byEmail.get('owner@x.test')!.autoMap, false);

  const b = byEmail.get('b@x.test')!;
  const owner = byEmail.get('owner@x.test')!;
  assert.equal(accessibleMailboxRef(b), 'shared:s2');
  assert.equal(accessibleMailboxRef(owner), 'delegated:mb-o1');
  assert.equal(isMailboxMapped(b, new Set()), false, 'not mapped until added');
  assert.equal(isMailboxMapped(b, new Set(['shared:s2'])), true);
  assert.equal(isMailboxMapped(owner, new Set(['delegated:mb-o1'])), true);
  assert.equal(isMailboxMapped(byEmail.get('c@x.test')!, new Set()), true);
});
