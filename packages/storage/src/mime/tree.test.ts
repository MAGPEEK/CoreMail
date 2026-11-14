/**
 * MIME tree parser (byte offsets), section helpers, address parser and the
 * deterministic legacy builder.
 * Run: node --import tsx --test src/mime/tree.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMimeTree, resolvePart, bodyBytes, headerBytes, selectHeaderFields, countLines, headerValue,
} from './tree.js';
import { parseAddressList, addressesOf } from './address.js';
import { buildRfc822FromFields, sanitizeHeaderValue, formatMailbox } from './build.js';
import { NESTED_MESSAGE, SIMPLE_MESSAGE } from './fixtures.js';

const text = (b: Buffer | null | undefined): string => (b ? b.toString('utf8') : '<null>');

test('multipart/mixed with nested alternative, attachment and message/rfc822', () => {
  const root = parseMimeTree(NESTED_MESSAGE);
  assert.equal(root.type, 'multipart');
  assert.equal(root.subtype, 'mixed');
  assert.equal(root.children.length, 3);
  const [alt, pdf, msg] = root.children;
  assert.equal(`${alt!.type}/${alt!.subtype}`, 'multipart/alternative');
  assert.deepEqual(alt!.children.map((c) => `${c.type}/${c.subtype}`), ['text/plain', 'text/html']);
  assert.equal(alt!.children[0]!.encoding, 'QUOTED-PRINTABLE');
  assert.equal(`${pdf!.type}/${pdf!.subtype}`, 'application/pdf');
  assert.deepEqual(pdf!.params, [['name', 'report.pdf']]);
  assert.equal(pdf!.disposition?.value, 'attachment');
  assert.equal(pdf!.description, 'The report');
  assert.equal(`${msg!.type}/${msg!.subtype}`, 'message/rfc822');
  assert.ok(msg!.message);
  assert.equal(msg!.message!.children.length, 2);
  assert.equal(msg!.message!.children[1]!.id, '<logo@example.test>');
});

test('part bodies are byte-exact and exclude the CRLF before the delimiter', () => {
  const root = parseMimeTree(NESTED_MESSAGE);
  assert.equal(text(bodyBytes(NESTED_MESSAGE, resolvePart(root, [1, 1])!)), 'Hello Bob,\r\nsee attached.');
  assert.equal(text(bodyBytes(NESTED_MESSAGE, resolvePart(root, [1, 2])!)), '<p>Hello Bob,<br>see attached.</p>');
  assert.equal(
    text(bodyBytes(NESTED_MESSAGE, resolvePart(root, [2])!)),
    'JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSPj4Kc3RyZWFtCg==',
  );
  assert.equal(
    text(headerBytes(NESTED_MESSAGE, resolvePart(root, [2])!)),
    'Content-Type: application/pdf; name="report.pdf"\r\nContent-Disposition: attachment; filename="report.pdf"\r\n'
      + 'Content-Transfer-Encoding: base64\r\nContent-Description: The report\r\n\r\n',
  );
  // 3 = the whole encapsulated message, 3.1 / 3.2 = its parts
  assert.match(text(bodyBytes(NESTED_MESSAGE, resolvePart(root, [3])!)), /^From: Frank <frank@example.test>\r\n[\s\S]*--inner--\r\n$/);
  assert.equal(text(bodyBytes(NESTED_MESSAGE, resolvePart(root, [3, 1])!)), 'Inner text');
  assert.equal(text(bodyBytes(NESTED_MESSAGE, resolvePart(root, [3, 2])!)), 'iVBORw0KGgo=');
  assert.equal(resolvePart(root, [4]), null);
  assert.equal(resolvePart(root, [2, 1]), null);
});

test('a single-part message: part 1 is its body; offsets cover the whole buffer', () => {
  const root = parseMimeTree(SIMPLE_MESSAGE);
  assert.equal(root.type, 'text');
  assert.deepEqual(root.params, [['charset', 'us-ascii']]);
  const one = resolvePart(root, [1])!;
  assert.equal(text(bodyBytes(SIMPLE_MESSAGE, one)), 'line one\r\n.dot line\r\nline three');
  assert.equal(headerBytes(SIMPLE_MESSAGE, root).length + bodyBytes(SIMPLE_MESSAGE, root).length, SIMPLE_MESSAGE.length);
  assert.equal(countLines(SIMPLE_MESSAGE, root.bodyStart, root.end), 3);
});

test('header fields: unfolding, HEADER.FIELDS and HEADER.FIELDS.NOT are byte-exact', () => {
  const root = parseMimeTree(NESTED_MESSAGE);
  assert.equal(headerValue(root.headers, 'subject'), 'Quarterly report');
  assert.equal(
    text(selectHeaderFields(NESTED_MESSAGE, root, ['SUBJECT', 'from'], false)),
    'From: "Alice Example" <alice@example.test>\r\nSubject: Quarterly\r\n report\r\n\r\n',
  );
  const not = text(selectHeaderFields(NESTED_MESSAGE, root, ['Return-Path', 'Subject', 'Content-Type', 'MIME-Version', 'Cc', 'To', 'Date'], true));
  assert.equal(not, 'From: "Alice Example" <alice@example.test>\r\nMessage-ID: <nested-1@example.test>\r\n\r\n');
});

test('a header without body gets its separating blank line', () => {
  const raw = Buffer.from('Subject: x\r\nFrom: a@b');
  const root = parseMimeTree(raw);
  assert.equal(root.bodyStart, raw.length);
  assert.equal(text(headerBytes(raw, root)), 'Subject: x\r\nFrom: a@b\r\n\r\n');
});

test('address lists: display names, groups, comments', () => {
  assert.deepEqual(parseAddressList('"Doe, John" <john@x.test>, jane@x.test (Jane)'), [
    { kind: 'mailbox', name: 'Doe, John', address: 'john@x.test' },
    { kind: 'mailbox', name: '', address: 'jane@x.test' },
  ]);
  assert.deepEqual(parseAddressList('Team: a@x.test, B <b@x.test>;, c@x.test'), [
    { kind: 'group', name: 'Team', members: [
      { kind: 'mailbox', name: '', address: 'a@x.test' },
      { kind: 'mailbox', name: 'B', address: 'b@x.test' },
    ] },
    { kind: 'mailbox', name: '', address: 'c@x.test' },
  ]);
  assert.deepEqual(addressesOf('Undisclosed recipients:;'), []);
  assert.deepEqual(addressesOf('=?UTF-8?B?w4RyZ2Vy?= <BOSS@Corp.test>'), ['boss@corp.test']);
});

test('legacy builder: deterministic, CRLF/control characters cannot inject headers', () => {
  const fields = {
    subject: 'Hi\r\nBcc: victim@evil.test\r\n\r\ninjected body',
    fromAddr: 'mallory@evil.test>\r\nX-Evil: 1',
    fromName: 'Mallory\r\nReply-To: x@evil.test',
    toAddrs: ['bob@example.test\r\nX-Two: 2'],
    ccAddrs: [],
    replyTo: null,
    messageId: '<m1@evil.test>\r\nX-Three: 3',
    inReplyTo: null,
    date: new Date('2026-02-03T10:20:30Z'),
    bodyText: 'body',
    bodyHtml: '',
  };
  const a = buildRfc822FromFields(fields);
  const b = buildRfc822FromFields(fields);
  assert.deepEqual(a, b);
  const root = parseMimeTree(a);
  const names = root.headers.map((h) => h.name.toLowerCase());
  assert.deepEqual(names, ['date', 'from', 'subject', 'to', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding']);
  assert.equal(text(bodyBytes(a, root)), 'body');
  assert.equal(sanitizeHeaderValue('a\r\nb\u0000c d'), 'a b c d');
  assert.equal(formatMailbox('Jürgen', 'j@x.test'), '=?UTF-8?B?SsO8cmdlbg==?= <j@x.test>');
});

test('legacy builder: text + html + attachments → mixed(alternative, attachment)', () => {
  const raw = buildRfc822FromFields({
    subject: 'S', fromAddr: 'a@x.test', fromName: '', toAddrs: ['b@x.test'], ccAddrs: ['c@x.test'],
    replyTo: 'r@x.test', messageId: 'id@x.test', inReplyTo: '<p@x.test>', date: new Date(0),
    bodyText: 'plain\nline', bodyHtml: '<p>html</p>',
  }, [{ filename: 'Bericht ü.pdf', mimeType: 'application/pdf', contentId: null, inline: false, content: Buffer.from('%PDF') }]);
  const root = parseMimeTree(raw);
  assert.equal(root.subtype, 'mixed');
  assert.equal(root.children[0]!.subtype, 'alternative');
  assert.equal(text(bodyBytes(raw, resolvePart(root, [1, 1])!)), 'plain\r\nline');
  assert.equal(text(bodyBytes(raw, resolvePart(root, [2])!)), Buffer.from('%PDF').toString('base64'));
  assert.match(text(headerBytes(raw, resolvePart(root, [2])!)), /filename\*=UTF-8''Bericht%20%C3%BC\.pdf/);
  assert.equal(headerValue(root.headers, 'message-id'), '<id@x.test>');
});
