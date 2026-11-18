/**
 * Send as / on behalf classification and the sent-copy switches (9.4).
 * Run: node --import tsx --test src/shared-sent-copy.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { classifyForeignSend, grantsFromRows, headerSenders, wantsSentCopy } = await import('./shared-sent-copy.js');

const box = (id: string, email: string, over: Record<string, unknown> = {}) => ({
  id, email, sentCopySendAs: false, sentCopySendOnBehalf: false, aliases: [] as Array<{ address: string }>, mailbox: { id: `mb-${id}` }, ...over,
});

test('grants: one per box, SEND_AS or FULL_ACCESS = send as, SEND_ON_BEHALF = on behalf; aliases and switches kept', () => {
  const grants = grantsFromRows([
    { permission: 'FULL_ACCESS', sharedMailbox: box('s1', 'Team@X.test', { aliases: [{ address: 'Info@X.test' }], sentCopySendAs: true }) },
    { permission: 'SEND_ON_BEHALF', sharedMailbox: box('s1', 'Team@X.test', { aliases: [{ address: 'Info@X.test' }], sentCopySendAs: true }) },
    { permission: 'SEND_ON_BEHALF', sharedMailbox: box('s2', 'sales@x.test', { sentCopySendOnBehalf: true }) },
  ]);
  assert.equal(grants.length, 2);
  const [g1, g2] = grants;
  assert.deepEqual(g1!.addresses, ['team@x.test', 'info@x.test']);
  assert.deepEqual([g1!.sendAs, g1!.onBehalf, g1!.copySendAs, g1!.copySendOnBehalf], [true, true, true, false]);
  assert.deepEqual([g2!.sendAs, g2!.onBehalf, g2!.copySendOnBehalf], [false, true, true]);
});

test('classification: own address → none; shared From → send as; own Sender + on-behalf grant → on behalf', () => {
  const grants = grantsFromRows([
    { permission: 'SEND_AS', sharedMailbox: box('s1', 'team@x.test', { aliases: [{ address: 'info@x.test' }], sentCopySendAs: true }) },
    { permission: 'SEND_ON_BEHALF', sharedMailbox: box('s2', 'sales@x.test', { sentCopySendOnBehalf: true }) },
  ]);
  const own = ['me@x.test', 'me.alias@x.test'];
  assert.equal(classifyForeignSend('me@x.test', null, own, grants), null);
  assert.equal(classifyForeignSend('Me.Alias@x.test', null, own, grants), null);
  assert.equal(classifyForeignSend('stranger@y.test', null, own, grants), null);
  assert.equal(classifyForeignSend(null, null, own, grants), null);

  const asTeam = classifyForeignSend('<Team@X.test>', null, own, grants);
  assert.equal(asTeam?.mode, 'send_as');
  assert.equal(asTeam?.grant.sharedMailboxId, 's1');
  assert.equal(classifyForeignSend('info@x.test', null, own, grants)?.mode, 'send_as', 'aliases count');
  assert.equal(wantsSentCopy(asTeam!), true);

  const onBehalf = classifyForeignSend('sales@x.test', 'me@x.test', own, grants);
  assert.equal(onBehalf?.mode, 'send_on_behalf');
  assert.equal(wantsSentCopy(onBehalf!), true);
  assert.equal(classifyForeignSend('sales@x.test', null, own, grants), null, 'on-behalf grant without Sender: is no permitted send');
  assert.equal(classifyForeignSend('sales@x.test', 'other@x.test', own, grants), null, 'Sender must be the user');
});

test('switches are separate: a send-as copy does not imply an on-behalf copy and vice versa', () => {
  const [g] = grantsFromRows([
    { permission: 'SEND_AS', sharedMailbox: box('s1', 'team@x.test', { sentCopySendOnBehalf: true }) },
    { permission: 'SEND_ON_BEHALF', sharedMailbox: box('s1', 'team@x.test', { sentCopySendOnBehalf: true }) },
  ]);
  assert.equal(wantsSentCopy({ mode: 'send_as', grant: g! }), false);
  assert.equal(wantsSentCopy({ mode: 'send_on_behalf', grant: g! }), true);
  assert.equal(classifyForeignSend('team@x.test', 'me@x.test', ['me@x.test'], [g!])?.mode, 'send_on_behalf', 'Sender: = user → on behalf when granted');
});

test('headerSenders: first From: and Sender: of the header only', () => {
  const raw = Buffer.from('From: "Team" <team@x.test>\r\nSender: me@x.test\r\nSubject: s\r\n\r\nSender: fake@y.test\r\n');
  assert.deepEqual(headerSenders(raw), { from: 'team@x.test', sender: 'me@x.test' });
  assert.deepEqual(headerSenders(Buffer.from('Subject: s\r\n\r\n')), { from: null, sender: null });
});
