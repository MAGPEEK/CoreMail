import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripBccHeader } from './strip-bcc.js';

function strip(input: string): string {
  return stripBccHeader(Buffer.from(input, 'latin1')).toString('latin1');
}

test('removes a Bcc header and keeps a Bcc-looking line in the body', () => {
  const input = 'From: a@x.de\r\nBcc: secret@x.de\r\nSubject: s\r\n\r\nBody\r\nBcc: stays in body\r\n';
  assert.equal(strip(input), 'From: a@x.de\r\nSubject: s\r\n\r\nBody\r\nBcc: stays in body\r\n');
});

test('removes a folded Bcc header that is the last header field', () => {
  const input = 'From: a@x.de\r\nSubject: s\r\nBCC: one@x.de,\r\n two@x.de\r\n\r\nBody';
  assert.equal(strip(input), 'From: a@x.de\r\nSubject: s\r\n\r\nBody');
});

test('handles bare LF line endings and lower-case field names', () => {
  assert.equal(strip('From: a@x.de\nbcc:x@y.de\nTo: b@x.de\n\nBody'), 'From: a@x.de\nTo: b@x.de\n\nBody');
});

test('keeps header fields that only start with "Bcc"', () => {
  const input = 'From: a@x.de\r\nX-Bcc-Note: keep\r\nBcc-Copy: keep\r\n\r\nB';
  assert.equal(strip(input), input);
});

test('keeps 8-bit body bytes unchanged', () => {
  const body = Buffer.from([0xc3, 0xa4, 0xff, 0x00]);
  const raw = Buffer.concat([Buffer.from('Bcc: x@y.de\r\nTo: b@x.de\r\n\r\n', 'latin1'), body]);
  const out = stripBccHeader(raw);
  assert.deepEqual(out, Buffer.concat([Buffer.from('To: b@x.de\r\n\r\n', 'latin1'), body]));
});
