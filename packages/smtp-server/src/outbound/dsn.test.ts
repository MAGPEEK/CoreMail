/**
 * DSN format (RFC 3464 / 3463 / 2047, CRLF) and reply-code extraction.
 * Run: node --import tsx --test src/outbound/dsn.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { buildDsnMessage, extractSmtpCode } = await import('./dsn.js');

const BASE = {
  originalFrom: 'alice@corp.test',
  originalTo: ['ok@ext.test', 'gone@ext.test'],
  originalSubject: 'Grüße',
  originalMessageId: null,
  failureReason: 'x',
  smtpCode: 550,
  serverHostname: 'mail.corp.test',
};

function deliveryStatus(raw: string): string {
  const part = raw.split('Content-Type: message/delivery-status\r\n\r\n')[1] ?? '';
  return part.slice(0, part.indexOf('\r\n--'));
}

test('extractSmtpCode uses the reply code, never a port number of a network error', () => {
  assert.deepEqual(extractSmtpCode(new Error('connect ETIMEDOUT 10.0.0.5:587')), { code: null, isPermanent: false });
  assert.deepEqual(extractSmtpCode(Object.assign(new Error('Recipient command failed: 550 5.1.1 x'), { responseCode: 550 })), { code: 550, isPermanent: true });
  assert.deepEqual(extractSmtpCode(new Error('451 4.3.0 later')), { code: 451, isPermanent: false });
});

test('the DSN uses CRLF only, an encoded Subject and no non-standard fields', () => {
  const raw = buildDsnMessage({ ...BASE, recipients: [{ rcpt: 'gone@ext.test', status: '5.1.1', diagnostic: '550 5.1.1 No such user', remote: true }] }).toString('utf8');

  assert.doesNotMatch(raw, /(?<!\r)\n/, 'no bare LF');
  assert.match(raw, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r$/m);
  assert.doesNotMatch(raw, /Original-Message-ID/);
  assert.match(raw, /^Date: .* \+0000\r$/m);
});

test('the report lists only the failed recipients with the enhanced status; the per-message block is intact without a message-id', () => {
  const raw = buildDsnMessage({ ...BASE, recipients: [{ rcpt: 'gone@ext.test', status: '5.1.1', diagnostic: '550 5.1.1 No such user', remote: true }] }).toString('utf8');
  const blocks = deliveryStatus(raw).split('\r\n\r\n');

  assert.match(blocks[0] ?? '', /^Reporting-MTA: dns; mail\.corp\.test\r\nArrival-Date: /);
  assert.equal(blocks.length, 2);
  assert.match(blocks[1] ?? '', /^Final-Recipient: rfc822; gone@ext\.test\r\nAction: failed\r\nStatus: 5\.1\.1\r\nDiagnostic-Code: smtp; 550 5\.1\.1 No such user/);
  assert.doesNotMatch(raw, /ok@ext\.test/);
});

test('without per-recipient data the status is derived from the reply code class (550 → 5.0.0, not 5.5.0)', () => {
  const raw = buildDsnMessage({ ...BASE, originalTo: ['gone@ext.test'] }).toString('utf8');

  assert.match(deliveryStatus(raw), /Status: 5\.0\.0/);
});
