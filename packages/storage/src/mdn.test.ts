/**
 * 9.4 read receipts: Disposition-Notification-To parsing and the receipt MIME.
 * Run: node --import tsx --test src/mdn.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadReceipt, receiptAddressOf, receiptAddressOfRaw } from './mdn.js';
import { parseRawMessage } from './mime/index.js';

test('receiptAddressOf takes the first valid mailbox, lower-cased', () => {
  assert.equal(receiptAddressOf('"Ann Example" <Ann@Example.com>'), 'ann@example.com');
  assert.equal(receiptAddressOf('ann@example.com, bob@example.com'), 'ann@example.com');
  assert.equal(receiptAddressOf('Team: carl@example.org;'), 'carl@example.org');
  assert.equal(receiptAddressOf('not an address'), null);
  assert.equal(receiptAddressOf(''), null);
  assert.equal(receiptAddressOf(null), null);
});

test('receiptAddressOfRaw reads the top-level header only (folded value)', () => {
  const raw = Buffer.from(
    'From: a@example.com\r\nDisposition-Notification-To:\r\n "A" <a@example.com>\r\nSubject: x\r\n\r\n'
    + 'Disposition-Notification-To: evil@example.net\r\n',
  );
  assert.equal(receiptAddressOfRaw(raw), 'a@example.com');
  const bodyOnly = Buffer.from('From: a@example.com\r\n\r\nDisposition-Notification-To: evil@example.net\r\n');
  assert.equal(receiptAddressOfRaw(bodyOnly), null);
});

test('parseRawMessage exposes the receipt request', async () => {
  const raw = Buffer.from('From: a@example.com\r\nTo: b@example.com\r\nDisposition-Notification-To: a@example.com\r\nSubject: hi\r\n\r\nbody\r\n');
  assert.equal((await parseRawMessage(raw)).dispositionNotificationTo, 'a@example.com');
  const plain = Buffer.from('From: a@example.com\r\nTo: b@example.com\r\nSubject: hi\r\n\r\nbody\r\n');
  assert.equal((await parseRawMessage(plain)).dispositionNotificationTo, null);
});

test('buildReadReceipt: multipart/report with a disposition-notification part', () => {
  const { raw, messageId } = buildReadReceipt({
    fromAddr: 'b@example.com', fromName: 'Bea Beispiel', to: 'a@example.com',
    originalMessageId: 'orig@example.com', originalSubject: 'Angebot Ü',
    finalRecipient: 'b@example.com', reportingHost: 'mail.example.com', mode: 'manual',
    date: new Date('2026-01-02T03:04:05Z'),
  });
  const s = raw.toString('utf8');
  assert.match(s, /^From: "Bea Beispiel" <b@example\.com>\r\n/);
  assert.match(s, /\r\nTo: a@example\.com\r\n/);
  assert.match(s, /\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(s, /Content-Type: multipart\/report; report-type=disposition-notification; boundary="=_cm_mdn_[0-9a-f]+"/);
  assert.match(s, /\r\nContent-Type: message\/disposition-notification\r\n\r\nReporting-UA: mail\.example\.com; CoreMail\r\n/);
  assert.match(s, /\r\nFinal-Recipient: rfc822;b@example\.com\r\n/);
  assert.match(s, /\r\nOriginal-Message-ID: <orig@example\.com>\r\n/);
  assert.match(s, /\r\nDisposition: manual-action\/MDN-sent-manually; displayed\r\n/);
  assert.match(s, /\r\nIn-Reply-To: <orig@example\.com>\r\n/);
  assert.doesNotMatch(s, /Auto-Submitted/);
  assert.match(messageId, /^<mdn\.[0-9a-f]+@mail\.example\.com>$/);
});

test('buildReadReceipt: automatic mode, no header injection, unsafe host replaced', () => {
  const { raw } = buildReadReceipt({
    fromAddr: 'b@example.com', fromName: 'x\r\nBcc: evil@example.net', to: 'a@example.com\r\nX: y',
    originalMessageId: null, originalSubject: 'S\r\nBcc: evil@example.net',
    finalRecipient: 'b@example.com', reportingHost: 'bad host\r\n', mode: 'automatic',
  });
  const s = raw.toString('utf8');
  assert.doesNotMatch(s, /\r\nBcc:/);
  assert.doesNotMatch(s, /\r\nX: y/);
  assert.match(s, /\r\nAuto-Submitted: auto-replied\r\n/);
  assert.match(s, /Disposition: automatic-action\/MDN-sent-automatically; displayed/);
  assert.match(s, /Reporting-UA: localhost; CoreMail/);
  assert.doesNotMatch(s, /Original-Message-ID/);
});

test('no receipt for mailing lists, bulk, automatic mail and reports', () => {
  const head = (extra: string) => Buffer.from(`From: a@example.com\r\nDisposition-Notification-To: a@example.com\r\n${extra}Subject: x\r\n\r\nbody\r\n`);
  assert.equal(receiptAddressOfRaw(head('')), 'a@example.com');
  assert.equal(receiptAddressOfRaw(head('Auto-Submitted: no\r\n')), 'a@example.com');
  assert.equal(receiptAddressOfRaw(head('List-Id: <news.example.com>\r\n')), null);
  assert.equal(receiptAddressOfRaw(head('List-Post: <mailto:list@example.com>\r\n')), null);
  assert.equal(receiptAddressOfRaw(head('Precedence: bulk\r\n')), null);
  assert.equal(receiptAddressOfRaw(head('Precedence: List\r\n')), null);
  assert.equal(receiptAddressOfRaw(head('Auto-Submitted: auto-replied\r\n')), null);
  assert.equal(receiptAddressOfRaw(head('Content-Type: multipart/report; report-type=disposition-notification; boundary=b\r\n')), null);
});
