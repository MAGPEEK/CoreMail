/**
 * Per-mailbox mail flow rules (9.4).
 * Run: node --import tsx --test src/mail-flow.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MailFlowSettings } from './mail-flow.js';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const {
  mailFlowFromRow, normalizeSenderPattern, parseSenderList, senderMatches, senderRefusal, receiveSizeRefusal,
  deliveryRefusal, rcptStageRefusal, effectiveSendLimits, checkSendLimitsPure, headerFromAddress, DEFAULT_MAIL_FLOW,
  SENDER_REFUSED_REPLY, MAX_SENDER_LIST_ENTRIES,
} = await import('./mail-flow.js');

const policy = (over: Partial<MailFlowSettings> = {}): MailFlowSettings => ({ ...mailFlowFromRow(null), ...over });

test('no row = defaults: listed, no forwarding, no restrictions, global limits', () => {
  assert.deepEqual(mailFlowFromRow(null), { ...DEFAULT_MAIL_FLOW, acceptFrom: [], rejectFrom: [] });
  assert.equal(mailFlowFromRow({ forwardTo: 'Boss@Example.TEST' }).forwardTo, 'boss@example.test');
  assert.equal(mailFlowFromRow({ forwardKeepCopy: false }).forwardKeepCopy, false);
  assert.equal(mailFlowFromRow({}).forwardKeepCopy, true);
});

test('sender patterns: addresses and domains, lower case, "@domain" accepted, junk refused', () => {
  assert.equal(normalizeSenderPattern(' Alice@Example.TEST '), 'alice@example.test');
  assert.equal(normalizeSenderPattern('example.test'), 'example.test');
  assert.equal(normalizeSenderPattern('@Partner.example'), 'partner.example');
  for (const bad of ['', 'nodot', 'a@b', 'a b@x.test', '-x.test', 'x..test', '@', 'a@@x.test']) {
    assert.equal(normalizeSenderPattern(bad), null, bad);
  }
  assert.deepEqual(parseSenderList(['a@x.test', 'A@X.test', 'y.test']), { ok: true, values: ['a@x.test', 'y.test'] });
  assert.deepEqual(parseSenderList(['ok.test', 'bad']), { ok: false, invalid: ['bad'] });
  assert.equal(parseSenderList(Array.from({ length: MAX_SENDER_LIST_ENTRIES + 1 }, (_, i) => `u${i}@x.test`)).ok, false);
});

test('matching: an address matches exactly, a domain matches itself and its subdomains', () => {
  assert.equal(senderMatches('a@x.test', '<A@X.test>'), true);
  assert.equal(senderMatches('a@x.test', 'b@x.test'), false);
  assert.equal(senderMatches('x.test', 'b@x.test'), true);
  assert.equal(senderMatches('x.test', 'b@mail.x.test'), true);
  assert.equal(senderMatches('x.test', 'b@evilx.test'), false, 'no suffix match without a dot');
  assert.equal(senderMatches('x.test', ''), false);
});

test('reject-from refuses when any known sender (envelope or From:) matches', () => {
  const p = policy({ rejectFrom: ['spam.test', 'bad@x.test'] });
  assert.equal(senderRefusal(p, ['a@spam.test', null]), SENDER_REFUSED_REPLY);
  assert.equal(senderRefusal(p, ['ok@x.test', 'bad@x.test']), SENDER_REFUSED_REPLY, 'header From counts');
  assert.equal(senderRefusal(p, ['ok@x.test', 'ok@x.test']), null);
  assert.equal(senderRefusal(p, [null, '']), null, 'null sender passes a reject list');
  assert.match(SENDER_REFUSED_REPLY, /^550 5\.7\.1 /);
});

test('accept-only-from: every known sender must match; a message without any sender is refused', () => {
  const p = policy({ acceptFrom: ['partner.test'] });
  assert.equal(senderRefusal(p, ['a@partner.test', 'b@partner.test']), null);
  assert.equal(senderRefusal(p, ['a@partner.test', 'spoof@other.test']), SENDER_REFUSED_REPLY, 'a foreign From: is refused');
  assert.equal(senderRefusal(p, [null, null]), SENDER_REFUSED_REPLY, 'null reverse-path without From:');
  assert.equal(senderRefusal(p, ['', 'a@partner.test']), null, 'null reverse-path with an allowed From:');
  assert.equal(senderRefusal(policy({ acceptFrom: ['x.test'], rejectFrom: ['bad@x.test'] }), ['bad@x.test']), SENDER_REFUSED_REPLY, 'reject wins');
});

test('receive size: per-mailbox limit refuses with 552 5.2.3; no limit passes', () => {
  assert.equal(receiveSizeRefusal(policy(), 10 ** 9), null);
  assert.equal(receiveSizeRefusal(policy({ maxReceiveSizeMb: 1 }), 1024 * 1024), null);
  assert.match(receiveSizeRefusal(policy({ maxReceiveSizeMb: 1 }), 1024 * 1024 + 1) ?? '', /^552 5\.2\.3 .*\(1 MB\)/);
  assert.equal(
    deliveryRefusal(policy({ maxReceiveSizeMb: 1, rejectFrom: ['x.test'] }), { envelopeFrom: 'a@x.test', headerFrom: null, sizeBytes: 5 * 1024 * 1024 }),
    SENDER_REFUSED_REPLY, 'sender check first',
  );
  assert.equal(deliveryRefusal(policy(), { envelopeFrom: null, headerFrom: null, sizeBytes: 1 }), null);
});

test('RCPT stage: envelope sender only; a null reverse-path is left to DATA, where From: is known', () => {
  const p = policy({ acceptFrom: ['partner.test'], rejectFrom: ['spam.test'] });
  assert.equal(rcptStageRefusal(p, 'x@other.test'), SENDER_REFUSED_REPLY);
  assert.equal(rcptStageRefusal(p, 'x@spam.test'), SENDER_REFUSED_REPLY);
  assert.equal(rcptStageRefusal(p, 'a@partner.test'), null);
  assert.equal(rcptStageRefusal(p, null), null, 'judged with the header From: later');
  assert.equal(rcptStageRefusal(p, ''), null);
});

test('the server own notices (NDRs, dead-letter notices) pass every sender list and the size limit', () => {
  const p = policy({ acceptFrom: ['partner.test'], maxReceiveSizeMb: 1 });
  const ndr = { envelopeFrom: null, headerFrom: 'mailer-daemon@mail.corp.test', sizeBytes: 5 * 1024 * 1024 };
  assert.equal(deliveryRefusal(p, ndr), SENDER_REFUSED_REPLY, 'an outside bounce is judged by its From:');
  assert.equal(deliveryRefusal(p, { ...ndr, systemNotice: true }), null);
});

test('send limits: a per-mailbox value replaces the global one (larger or smaller)', () => {
  const global = { maxBytes: 25 * 1024 * 1024, maxRecipients: 500 };
  assert.deepEqual(effectiveSendLimits(policy(), global), global);
  assert.deepEqual(effectiveSendLimits(policy({ maxSendSizeMb: 5, maxRecipients: 10 }), global), { maxBytes: 5 * 1024 * 1024, maxRecipients: 10 });
  assert.deepEqual(effectiveSendLimits(policy({ maxRecipients: 1000 }), global), { maxBytes: global.maxBytes, maxRecipients: 1000 });
  const limits = { maxBytes: 100, maxRecipients: 2 };
  assert.deepEqual(checkSendLimitsPure(limits, 100, 2), { ok: true });
  assert.deepEqual(checkSendLimitsPure(limits, 101, 2), { ok: false, kind: 'size', limit: 100 });
  assert.deepEqual(checkSendLimitsPure(limits, 1, 3), { ok: false, kind: 'recipients', limit: 2 });
});

test('headerFromAddress: first From: address, folded headers, none in the body', () => {
  assert.equal(headerFromAddress(Buffer.from('Subject: x\r\nFrom: "A" <Alice@Example.test>,\r\n b@x.test\r\n\r\nbody')), 'alice@example.test');
  assert.equal(headerFromAddress(Buffer.from('Subject: x\r\n\r\nFrom: fake@x.test')), null);
});
