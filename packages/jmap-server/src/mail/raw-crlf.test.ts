/**
 * 9.4 review: Email/set builds messages with CRLF line ends (the former
 * `newline: 'crlf'` was no valid nodemailer value and produced bare LF).
 * Run: node --import tsx --import ./src/test-env.ts --test src/mail/raw-crlf.test.ts  (in packages/jmap-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };
const { buildRfc822 } = await import('./raw.js');

test('buildRfc822: multi-line text, HTML and an attachment → CRLF only', async () => {
  const raw = await buildRfc822({
    from: { name: 'Ann', email: 'ann@corp.test' }, to: [{ name: null, email: 'bob@corp.test' }], cc: [], bcc: [], replyTo: [],
    subject: 'Lines', date: new Date('2026-01-02T03:04:05Z'), messageId: 'id1@corp.test', inReplyTo: [], references: [],
    text: 'one\ntwo\n', html: '<p>one</p>\n<p>two</p>',
    attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('x\ny\n') }],
    extraHeaders: [],
  } as Parameters<typeof buildRfc822>[0]);
  assert.ok(!/(^|[^\r])\n/.test(raw.toString('latin1')), 'no bare LF');
  assert.ok(raw.includes('\r\n\r\n'), 'header/body separator is CRLF CRLF');
});
