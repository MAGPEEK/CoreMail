/** Test fixtures (raw RFC 5322 messages) shared by the MIME / IMAP / POP3 tests. */

const CRLF = '\r\n';
const lines = (...l: string[]): string => l.join(CRLF);

/**
 * multipart/mixed
 *  1   multipart/alternative
 *  1.1   text/plain (quoted-printable, 8-bit-free)
 *  1.2   text/html
 *  2   application/pdf attachment (base64)
 *  3   message/rfc822
 *  3.1   multipart/mixed of the encapsulated message → text/plain
 *  3.2   image/png inline
 */
export const NESTED_MESSAGE = Buffer.from(lines(
  'Return-Path: <alice@example.test>',
  'From: "Alice Example" <alice@example.test>',
  'To: Bob <bob@example.test>, carol@example.test',
  'Cc: Team: dave@example.test, erin@example.test;',
  'Subject: Quarterly',
  ' report',
  'Date: Tue, 03 Feb 2026 10:20:30 +0000',
  'Message-ID: <nested-1@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  'This is the preamble.',
  '--outer',
  'Content-Type: multipart/alternative; boundary=alt',
  '',
  '--alt',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hello Bob,',
  'see attached.',
  '--alt',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hello Bob,<br>see attached.</p>',
  '--alt--',
  '',
  '--outer',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  'Content-Description: The report',
  '',
  'JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSPj4Kc3RyZWFtCg==',
  '--outer',
  'Content-Type: message/rfc822',
  '',
  'From: Frank <frank@example.test>',
  'To: alice@example.test',
  'Subject: Original',
  'Date: Mon, 02 Feb 2026 09:00:00 +0000',
  'Message-ID: <inner-1@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain',
  '',
  'Inner text',
  '--inner',
  'Content-Type: image/png',
  'Content-ID: <logo@example.test>',
  'Content-Disposition: inline',
  'Content-Transfer-Encoding: base64',
  '',
  'iVBORw0KGgo=',
  '--inner--',
  '',
  '--outer--',
  'epilogue',
  '',
), 'utf8');

/** A single-part text/plain message (body ends without CRLF). */
export const SIMPLE_MESSAGE = Buffer.from(lines(
  'From: alice@example.test',
  'To: bob@example.test',
  'Subject: Hi',
  'Date: Tue, 03 Feb 2026 10:20:30 +0000',
  '',
  'line one',
  '.dot line',
  'line three',
), 'utf8');
