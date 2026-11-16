/**
 * X-CoreMail-Virus-Scan (9.2): the security-filter note is validated, written as
 * one safe header line, and a copy sent by an outside sender is stripped
 * before filtering (internal header).
 * Run: node --import tsx --test src/inbound/virus-scan-header.test.ts  (in packages/smtp-server)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  systemLog: { create: async () => ({}) },
};

const { parseVirusScanNote, virusScanHeaderLine, VIRUS_SCAN_HEADER } = await import('./virus-scan-header.js');
const { interpretContentFilterResponse } = await import('./connection-filter.js');
const storage = await import('@coremail/storage');
const { inboundHandlers } = await import('./handler.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('header name equals the storage constant and is an internal header', () => {
  assert.equal(VIRUS_SCAN_HEADER, storage.VIRUS_SCAN_HEADER);
  assert.ok(storage.INTERNAL_MAIL_HEADERS.includes(VIRUS_SCAN_HEADER));
});

test('note validation: known statuses/reasons only, signature reduced to a safe charset', () => {
  assert.equal(parseVirusScanNote(undefined), undefined);
  assert.equal(parseVirusScanNote({ status: 'clean' }), undefined);
  assert.deepEqual(parseVirusScanNote({ status: 'unscanned', reason: 'too-large' }), { status: 'unscanned', reason: 'too-large' });
  assert.deepEqual(parseVirusScanNote({ status: 'unscanned', reason: 'bogus' }), { status: 'unscanned' });
  assert.deepEqual(
    parseVirusScanNote({ status: 'infected', signature: 'Win.Test"\r\nBcc: x@evil.example EICAR_HDB-1' }),
    { status: 'infected', signature: 'Win.TestBcc:xevil.exampleEICAR_HDB-1' },
  );
  assert.equal(parseVirusScanNote({ status: 'suspicious', signature: 'A'.repeat(500) })?.signature?.length, 120);
});

test('header line format', () => {
  assert.equal(
    virusScanHeaderLine({ status: 'infected', signature: 'Win.Test.EICAR_HDB-1' }, 'mx.corp.test'),
    'X-CoreMail-Virus-Scan: infected; signature="Win.Test.EICAR_HDB-1"; host=mx.corp.test\r\n',
  );
  assert.equal(
    virusScanHeaderLine({ status: 'unscanned', reason: 'scanner-error' }, 'mx\r\nX: y'),
    'X-CoreMail-Virus-Scan: unscanned; reason=scanner-error; host=mxXy\r\n',
  );
});

test('content-filter answer carries the validated note', () => {
  const r = interpretContentFilterResponse(200, { action: 'accept', virusScan: { status: 'suspicious', signature: 'PUA.Win.Packer.Upx-1' } });
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.deepEqual(r.result.virusScan, { status: 'suspicious', signature: 'PUA.Win.Packer.Upx-1' });
  const bad = interpretContentFilterResponse(200, { action: 'accept', virusScan: { status: 'nope' } });
  if (bad.kind === 'ok') assert.equal(bad.result.virusScan, undefined);
});

test('a forged X-CoreMail-Virus-Scan from outside never reaches the filter', async () => {
  let scanned = '';
  globalThis.fetch = (async (_url: string, init: { body: Buffer }) => {
    scanned = Buffer.from(init.body).toString();
    return { status: 200, json: async () => ({ action: 'reject', reason: 'stop' }) };
  }) as unknown as typeof fetch;
  const raw = Buffer.from('X-CoreMail-Virus-Scan: clean; host=mx.corp.test\r\nSubject: s\r\n\r\nx\r\n');
  await assert.rejects(
    inboundHandlers.onMessage(raw, 'a@ext.test', ['bob@corp.test'], null, '192.0.2.1',
      { helo: 'mx.ext.test', protocol: 'ESMTP', hostname: 'mx.corp.test', sessionId: 'S1' }),
    /550 5\.7\.1 stop/,
  );
  assert.doesNotMatch(scanned, /X-CoreMail-Virus-Scan/i);
  assert.match(scanned, /Subject: s/);
});
