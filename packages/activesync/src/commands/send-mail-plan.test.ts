/**
 * EAS SendMail planning: sender identity enforcement, envelope, Bcc handling.
 * Run: node --import tsx --test src/commands/send-mail-plan.test.ts  (in packages/activesync)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EAS_SEND_STATUS, hasHeader, planEasSubmission, prependHeaders, stripHeader } from './send-mail-plan.js';

const ALLOWED = ['alice@firma.de', 'info@firma.de'];
const opts = { userEmail: 'Alice@Firma.de', allowedSenders: ALLOWED, now: new Date('2026-11-14T10:00:00Z') };

const mime = (headers: string[], body = 'Hello'): Buffer =>
  Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8');

test('own From: envelope = From, To+Cc+Bcc recipients, Bcc header removed', async () => {
  const r = await planEasSubmission(mime([
    'From: Alice <alice@firma.de>',
    'To: Bob <bob@example.com>, carol@firma.de',
    'Cc: dave@example.org',
    'Bcc: secret@example.net',
    'Subject: Hi',
    'Date: Fri, 13 Nov 2026 10:00:00 +0000',
    'Message-ID: <x@firma.de>',
  ]), opts);
  assert.ok(r.ok);
  assert.equal(r.plan.envelopeFrom, 'alice@firma.de');
  assert.deepEqual(r.plan.recipients, ['bob@example.com', 'carol@firma.de', 'dave@example.org', 'secret@example.net']);
  assert.deepEqual(r.plan.bcc, ['secret@example.net']);
  assert.equal(r.plan.subject, 'Hi');
  const raw = r.plan.raw.toString('utf8');
  assert.doesNotMatch(raw, /^Bcc:/im);
  assert.doesNotMatch(raw, /secret@example\.net/);
  assert.match(raw, /\r\n\r\nHello$/);
  assert.equal(r.plan.text.trim(), 'Hello');
});

test('Shared Mailbox with SEND_AS is accepted as From/envelope', async () => {
  const r = await planEasSubmission(mime(['From: "Info" <INFO@firma.de>', 'To: x@example.com']), opts);
  assert.ok(r.ok);
  assert.equal(r.plan.envelopeFrom, 'info@firma.de');
});

test('spoofed From is rejected with AccessDenied (130)', async () => {
  const r = await planEasSubmission(mime(['From: CEO <ceo@firma.de>', 'To: x@example.com']), opts);
  assert.deepEqual(r.ok ? null : r.status, EAS_SEND_STATUS.ACCESS_DENIED);
});

test('multiple From addresses are rejected', async () => {
  const r = await planEasSubmission(mime(['From: alice@firma.de, info@firma.de', 'To: x@example.com']), opts);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, EAS_SEND_STATUS.ACCESS_DENIED);
});

test('missing From → authenticated user, header added; Date/Message-ID ensured', async () => {
  const r = await planEasSubmission(mime(['To: x@example.com', 'Subject: s']), opts);
  assert.ok(r.ok);
  assert.equal(r.plan.envelopeFrom, 'alice@firma.de');
  const raw = r.plan.raw.toString('utf8');
  assert.match(raw, /^From: <alice@firma\.de>\r\n/);
  assert.match(raw, /^Date: Sat, 14 Nov 2026 10:00:00 \+0000$/m);
  assert.match(raw, /^Message-ID: <[0-9a-f-]+@firma\.de>$/m);
});

test('no recipients → 119, empty MIME → 107', async () => {
  const r1 = await planEasSubmission(mime(['From: alice@firma.de', 'Subject: s']), opts);
  assert.equal(!r1.ok && r1.status, EAS_SEND_STATUS.NO_RECIPIENTS);
  const r2 = await planEasSubmission(Buffer.alloc(0), opts);
  assert.equal(!r2.ok && r2.status, EAS_SEND_STATUS.INVALID_MIME);
});

test('group syntax recipients are flattened', async () => {
  const r = await planEasSubmission(mime(['From: alice@firma.de', 'To: Team: a@example.com, b@example.com;']), opts);
  assert.ok(r.ok);
  assert.deepEqual(r.plan.recipients, ['a@example.com', 'b@example.com']);
});

test('stripHeader removes folded headers and keeps the rest byte-exact', () => {
  const raw = Buffer.from('From: a@b.c\r\nBcc: x@y.z,\r\n  w@v.u\r\nSubject: S\r\n\r\nBody\r\nBcc: not-a-header', 'latin1');
  assert.equal(stripHeader(raw, 'Bcc').toString('latin1'), 'From: a@b.c\r\nSubject: S\r\n\r\nBody\r\nBcc: not-a-header');
  // last header line removed
  const raw2 = Buffer.from('From: a@b.c\r\nBcc: x@y.z\r\n\r\nB', 'latin1');
  assert.equal(stripHeader(raw2, 'bcc').toString('latin1'), 'From: a@b.c\r\n\r\nB');
  // only header removed → empty header block, body intact
  const raw3 = Buffer.from('Bcc: x@y.z\r\n\r\nB', 'latin1');
  assert.equal(prependHeaders(stripHeader(raw3, 'Bcc'), ['From: a@b.c']).toString('latin1'), 'From: a@b.c\r\n\r\nB');
  // LF-only messages
  assert.equal(stripHeader(Buffer.from('Bcc: x\nTo: y\n\nB'), 'Bcc').toString(), 'To: y\n\nB');
});

test('hasHeader only looks at the header block', () => {
  const raw = Buffer.from('To: a@b.c\r\n\r\nFrom: fake', 'latin1');
  assert.equal(hasHeader(raw, 'To'), true);
  assert.equal(hasHeader(raw, 'From'), false);
});
