/**
 * Port 25 handlers: postmaster acceptance (RFC 5321 §4.5.1), hop limit (§6.3),
 * Received: trace (§4.4) and content-filter answer validation.
 * Run: node --import tsx --test src/inbound/handler.test.ts  (in packages/smtp-server)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

const none = async () => null;
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  smtpSettings: { findUnique: async () => ({ localDeliveryEnabled: true }) },
  domain: { findFirst: async ({ where }: { where: { name: string } }) => (where.name === 'corp.test' ? { id: 'd1' } : null) },
  user: { findFirst: none },
  sharedMailbox: { findFirst: none },
  emailAlias: { findFirst: none },
  systemLog: { create: async () => ({}) },
};

const { inboundHandlers } = await import('./handler.js');
const { interpretContentFilterResponse } = await import('./connection-filter.js');

const META = { helo: 'mx.ext.test', protocol: 'ESMTP' as const, hostname: 'mx.corp.test', sessionId: 'S1' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('<Postmaster> and postmaster@<local domain> are accepted at RCPT even without a mailbox', async () => {
  assert.equal(await inboundHandlers.onRcptTo('postmaster', 'a@ext.test', null), null);
  assert.equal(await inboundHandlers.onRcptTo('PostMaster@corp.test', 'a@ext.test', null), null);
  assert.equal(await inboundHandlers.onRcptTo('postmaster@other.test', 'a@ext.test', null), '5.1.1 User unknown');
  assert.equal(await inboundHandlers.onRcptTo('nobody@corp.test', 'a@ext.test', null), '5.1.1 User unknown');
});

test('a message with more than 100 Received: fields is rejected as a loop (554 5.4.6)', async () => {
  globalThis.fetch = (async () => { throw new Error('content filter must not be called'); }) as typeof fetch;
  const raw = Buffer.from(`${'Received: from a by b; d\r\n'.repeat(101)}Subject: loop\r\n\r\nx\r\n`);

  await assert.rejects(inboundHandlers.onMessage(raw, 'a@ext.test', ['bob@corp.test'], null, '192.0.2.1', META), /^Error: 554 5\.4\.6 /);
});

test('the scanned message carries our Received: trace header first', async () => {
  let scanned = '';
  globalThis.fetch = (async (_url: string, init: { body: Buffer }) => {
    scanned = Buffer.from(init.body).toString();
    return { status: 200, json: async () => ({ action: 'reject', reason: 'test stop' }) };
  }) as unknown as typeof fetch;

  await assert.rejects(inboundHandlers.onMessage(Buffer.from('Subject: s\r\n\r\nx\r\n'), 'a@ext.test', ['bob@corp.test'], null, '192.0.2.1', META), /550 5\.7\.1 test stop/);

  assert.match(scanned, /^Received: from mx\.ext\.test \(\[192\.0\.2\.1\]\)\r\n\tby mx\.corp\.test \(CoreMail\) with ESMTP id S1\r\n\tfor <bob@corp\.test>; /);
});

test('an invalid content-filter answer defers the message (451) instead of delivering it unscanned', async () => {
  globalThis.fetch = (async () => ({ status: 400, json: async () => ({ error: 'empty body' }) })) as unknown as typeof fetch;

  await assert.rejects(inboundHandlers.onMessage(Buffer.from('Subject: s\r\n\r\nx\r\n'), 'a@ext.test', ['bob@corp.test'], null, '192.0.2.1', META), /^Error: 451 4\.7\.1 /);
  assert.equal(interpretContentFilterResponse(200, { action: 'bogus' }).kind, 'unavailable');
  assert.deepEqual(interpretContentFilterResponse(200, { action: 'accept', spamScore: 1.5, junkFolder: false }),
    { kind: 'ok', result: { action: 'accept', junkFolder: false, spamScore: 1.5 } });
});
