/**
 * SMTP submission (587/465): From:/Sender: header enforcement.
 * Run: node --import tsx --test src/submission/handler.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

const PASSED = new Error('header check passed (delivery reached)');

(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  user: {
    findFirst: async ({ where }: { where: { id: string } }) =>
      where.id === 'u1' ? { email: 'bob@corp.test' } : null,
  },
  emailAlias: {
    findMany: async ({ where }: { where: { targetUserId: string } }) =>
      where.targetUserId === 'u1' ? [{ address: 'robert@corp.test' }] : [],
  },
  sharedMailboxPerm: {
    findMany: async ({ where }: { where: { userId: string; permission: { in: string[] } } }) => {
      const rows = [
        { permission: 'SEND_AS', email: 'info@corp.test' },
        { permission: 'SEND_ON_BEHALF', email: 'sales@corp.test' },
        { permission: 'READ_ONLY', email: 'board@corp.test' },
      ];
      return rows
        .filter((r) => where.userId === 'u1' && where.permission.in.includes(r.permission))
        .map((r) => ({ sharedMailbox: { email: r.email, aliases: [] } }));
    },
  },
  serverSettings: { findUnique: async () => ({ publicHostname: 'mail.corp.test' }) },
  mailFlowPolicy: { findUnique: async () => null },
  // First DB access after the header check → proves the message was accepted for delivery.
  domain: { findFirst: async () => { throw PASSED; } },
  systemLog: { create: async () => ({}) },
};

const { submissionHandlers } = await import('./handler.js');
const user = { id: 'u1', email: 'bob@corp.test' };
const raw = (headers: string): Buffer => Buffer.from(`${headers}\r\nTo: x@ext.test\r\nSubject: s\r\n\r\nbody\r\n`);
const submit = (headers: string) =>
  submissionHandlers.onMessage(raw(headers), 'bob@corp.test', ['x@ext.test'], user, '192.0.2.1');

test('own address, alias and SEND_AS shared mailbox in From: are accepted', async () => {
  await assert.rejects(submit('From: Bob <bob@corp.test>'), (e) => e === PASSED);
  await assert.rejects(submit('From: robert@corp.test'), (e) => e === PASSED);
  await assert.rejects(submit('From: "Info" <info@corp.test>'), (e) => e === PASSED);
  await assert.rejects(submit('From: sales@corp.test\r\nSender: bob@corp.test'), (e) => e === PASSED);
});

test('a foreign From:/Sender: is rejected with 550 5.7.1 before delivery', async () => {
  for (const h of [
    'From: CEO <ceo@corp.test>',
    'From: board@corp.test',
    'From: sales@corp.test',
    'From: bob@corp.test\r\nSender: ceo@corp.test',
    'From: bob@corp.test\r\nFrom: ceo@corp.test',
  ]) {
    await assert.rejects(submit(h), /^Error: 550 5\.7\.1 /, h);
  }
});

test('the envelope sender accepts aliases (shared sender policy)', async () => {
  assert.equal(await submissionHandlers.onMailFrom('robert@corp.test', '192.0.2.1', user), null);
  assert.match(String(await submissionHandlers.onMailFrom('ceo@corp.test', '192.0.2.1', user)), /^5\.7\.1/);
});

test('9.2 review: a client-supplied X-CoreMail-Virus-Scan is stripped on submission', async () => {
  const { stripSubmittedInternalHeaders } = await import('./handler.js');
  const forged = Buffer.from([
    'From: bob@corp.test',
    'X-CoreMail-Virus-Scan: infected; signature="Win.Test.EICAR_HDB-1";',
    '  host=mail.corp.test',
    'x-coremail-virus-scan: unscanned; reason=too-large; host=mail.corp.test',
    'Subject: s', '', 'X-CoreMail-Virus-Scan: in the body stays', '',
  ].join('\r\n'));
  const out = stripSubmittedInternalHeaders(forged).toString();
  const head = out.slice(0, out.indexOf('\r\n\r\n'));
  assert.doesNotMatch(head, /virus-scan|host=mail/i, 'both copies incl. the folded line are removed');
  assert.match(head, /^From: bob@corp\.test\r\nSubject: s$/);
  assert.match(out, /\r\n\r\nX-CoreMail-Virus-Scan: in the body stays/);
  const clean = Buffer.from('From: bob@corp.test\r\nSubject: s\r\n\r\nb\r\n');
  assert.equal(stripSubmittedInternalHeaders(clean), clean, 'untouched when absent');
});
