import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capHeaderSection, parseRawMessage, MAX_PARSE_HEADER_BYTES } from './index.js';

const msg = (headers: string, body = 'Hello body\r\n') => Buffer.from(`${headers}\r\n${body}`);

test('capHeaderSection: a message whose header section fits is returned unchanged', () => {
  const raw = msg('From: a@example.com\r\nTo: b@example.com\r\nSubject: hi\r\n');
  assert.equal(capHeaderSection(raw, 64), raw);
  const big = msg('Subject: hi\r\n', 'x'.repeat(1000));
  assert.equal(capHeaderSection(big, 64), big, 'a large body alone never triggers the cap');
});

test('capHeaderSection: keeps complete fields within the limit, drops the rest, keeps the body', () => {
  const raw = msg('Subject: keep\r\nTo: a@example.com,\r\n b@example.com,\r\n c@example.com\r\nX-Late: dropped\r\n', 'BODY\r\n');
  const out = capHeaderSection(raw, 40).toString();
  assert.equal(out, 'Subject: keep\r\n\r\nBODY\r\n', 'a folded field crossing the limit is dropped as a whole');
});

test('capHeaderSection: LF-only messages and messages without a body', () => {
  const lf = Buffer.from('Subject: keep\nTo: ' + 'x'.repeat(100) + '\n\nBODY\n');
  assert.equal(capHeaderSection(lf, 30).toString(), 'Subject: keep\n\nBODY\n');
  const noBody = Buffer.from('Subject: keep\r\nTo: ' + 'x'.repeat(100));
  assert.equal(capHeaderSection(noBody, 30).toString(), 'Subject: keep\r\n\r\n');
});

test('parseRawMessage: an oversized address header is capped and the rest still parses', async () => {
  const many = Array.from({ length: 30_000 }, (_, i) => `u${i}@example.com`).join(', ');
  assert.ok(many.length > MAX_PARSE_HEADER_BYTES);
  const raw = msg(`From: Alice <alice@example.com>\r\nSubject: capped\r\nTo: ${many}\r\n`, 'Body text\r\n');
  const started = Date.now();
  const parsed = await parseRawMessage(raw);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(parsed.fromAddr, 'alice@example.com');
  assert.equal(parsed.subject, 'capped');
  assert.deepEqual(parsed.toAddrs, [], 'the oversized To field is dropped, not half-parsed');
  assert.equal(parsed.bodyText.trim(), 'Body text');
  assert.equal(parsed.size, raw.length, 'size reports the original message');
});

test('parseRawMessage: address parsing of pathological input stays fast (nodemailer >= 10.0.6)', async () => {
  // Deep comment/quote nesting and long free text exercised the quadratic and
  // recursive addressparser paths fixed in nodemailer 9.1 / 10.0.6.
  const evil = `${'('.repeat(20_000)}${'"a'.repeat(20_000)} ${'a@'.repeat(20_000)}`;
  const raw = msg(`From: ${evil}\r\nSubject: x\r\n`);
  const started = Date.now();
  await parseRawMessage(raw);
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});
