import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDraftFields, draftSenderMode, formatComposeAddress, encodeDraftPending, decodeDraftPending,
  DRAFT_PENDING_HEADER, MAX_DRAFT_PENDING_BYTES,
} from './draft.js';

const crlf = (lines: string[]) => Buffer.from(lines.join('\r\n'));

test('parseDraftFields keeps display names, Bcc, threading headers and the body', async () => {
  const raw = crlf([
    'From: "Alice A." <Alice@Corp.test>',
    'To: =?UTF-8?Q?J=C3=B6rg?= <joerg@x.test>, bob@y.test',
    'Cc: Team: c1@x.test, c2@x.test;',
    'Bcc: hidden@z.test',
    'Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=',
    'Message-ID: <draft-1@corp.test>',
    'In-Reply-To: <parent@x.test>',
    'References: <root@x.test> <parent@x.test>',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Hallo</p>',
  ]);
  const f = await parseDraftFields(raw);
  assert.deepEqual(f.to, ['Jörg <joerg@x.test>', 'bob@y.test']);
  assert.deepEqual(f.cc, ['c1@x.test', 'c2@x.test']);
  assert.deepEqual(f.bcc, ['hidden@z.test']);
  assert.deepEqual(f.from, { address: 'alice@corp.test', name: 'Alice A.' });
  assert.equal(f.sender, null);
  assert.equal(f.subject, 'Grüße');
  assert.match(f.bodyHtml, /<p>Hallo<\/p>/);
  assert.equal(f.messageId, '<draft-1@corp.test>');
  assert.equal(f.inReplyTo, '<parent@x.test>');
  assert.deepEqual(f.references, ['<root@x.test>', '<parent@x.test>']);
});

test('draftSenderMode: own address, send as, send on behalf of', () => {
  assert.deepEqual(draftSenderMode({ from: { address: 'me@x.test', name: '' }, sender: null }, 'Me@X.test'), { sendAs: null, sendOnBehalfOf: null });
  assert.deepEqual(draftSenderMode({ from: { address: 'team@x.test', name: '' }, sender: null }, 'me@x.test'), { sendAs: 'team@x.test', sendOnBehalfOf: null });
  assert.deepEqual(draftSenderMode({ from: { address: 'team@x.test', name: '' }, sender: 'me@x.test' }, 'me@x.test'), { sendAs: null, sendOnBehalfOf: 'team@x.test' });
  assert.deepEqual(draftSenderMode({ from: null, sender: null }, 'me@x.test'), { sendAs: null, sendOnBehalfOf: null });
});

test('formatComposeAddress strips CR/LF and quotes from names', () => {
  assert.equal(formatComposeAddress({ name: 'A\r\nB "C"', address: 'a@b.c' }), 'A  B  C <a@b.c>');
  assert.equal(formatComposeAddress({ name: '', address: 'a@b.c' }), 'a@b.c');
  assert.equal(formatComposeAddress({ name: 'bob', address: '' }), 'bob');
  assert.equal(formatComposeAddress({ name: 'Doe, John', address: 'j@x.test' }), '"Doe, John" <j@x.test>');
});

test('pending (not yet valid) recipients survive in the draft header and are merged back', async () => {
  assert.equal(encodeDraftPending({ to: [], cc: [], bcc: [] }), null);
  assert.equal(encodeDraftPending({ to: ['x'.repeat(MAX_DRAFT_PENDING_BYTES)], cc: [], bcc: [] }), null);
  const v = encodeDraftPending({ to: ['bob'], cc: [], bcc: ['a@'] })!;
  const raw = Buffer.from(`From: me@x.test\r\nTo: ok@x.test\r\n${DRAFT_PENDING_HEADER}: ${v}\r\nSubject: s\r\n\r\nbody\r\n`);
  const f = await parseDraftFields(raw);
  assert.deepEqual(f.to, ['ok@x.test', 'bob']);
  assert.deepEqual(f.bcc, ['a@']);
  assert.deepEqual(decodeDraftPending('%%%not-base64-json'), { to: [], cc: [], bcc: [] });
});
