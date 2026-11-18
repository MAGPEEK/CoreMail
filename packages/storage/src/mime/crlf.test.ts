/**
 * 9.4 review: every in-memory MIME builder uses CRLF line ends — the shared
 * nodemailer option set, MailComposer, and a repository guard against a new
 * stream transport that bypasses the shared option.
 * Run: node --import tsx --test src/mime/crlf.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Readable } from 'node:stream';
import { CRLF_STREAM_TRANSPORT, buildCrlfMime, hasOnlyCrlfLineEnds } from './crlf.js';

const MAIL = {
  from: 'a@example.test', to: 'b@example.test', subject: 'Line ends',
  text: 'one\ntwo\r\nthree\n', html: '<p>one</p>\n<p>two</p>',
  attachments: [{ filename: 'x.txt', content: Buffer.from('a\nb\n') }],
};

async function streamToBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}

test('hasOnlyCrlfLineEnds detects bare LF and bare CR', () => {
  assert.equal(hasOnlyCrlfLineEnds('a\r\nb\r\n'), true);
  assert.equal(hasOnlyCrlfLineEnds('a\nb'), false);
  assert.equal(hasOnlyCrlfLineEnds('\nb'), false);
  assert.equal(hasOnlyCrlfLineEnds('a\rb'), false);
});

test('the shared stream transport option builds CRLF-only messages (stream and buffer mode)', async () => {
  const streamed = await nodemailer.createTransport(CRLF_STREAM_TRANSPORT).sendMail(MAIL);
  assert.ok(hasOnlyCrlfLineEnds(await streamToBuffer(streamed.message as Readable)));
  const buffered = await nodemailer.createTransport({ ...CRLF_STREAM_TRANSPORT, buffer: true }).sendMail(MAIL);
  assert.ok(hasOnlyCrlfLineEnds(buffered.message as Buffer));
});

test("the former 'crlf' value is no CRLF option (it produced bare LF)", async () => {
  const info = await nodemailer.createTransport({ streamTransport: true, newline: 'crlf', buffer: true }).sendMail(MAIL);
  assert.equal(hasOnlyCrlfLineEnds(info.message as Buffer), false);
});

test('MailComposer#build alone keeps bare LF of the content — buildCrlfMime does not', async () => {
  assert.equal(hasOnlyCrlfLineEnds(await new MailComposer(MAIL).compile().build()), false);
  assert.ok(hasOnlyCrlfLineEnds(await buildCrlfMime(MAIL)));
});

/** packages/<pkg>/src/**\/*.ts without tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

test('repository guard: no stream transport or newline option outside the shared CRLF option', () => {
  const packages = fileURLToPath(new URL('../../../', import.meta.url));
  const offenders: string[] = [];
  for (const pkg of readdirSync(packages)) {
    const src = join(packages, pkg, 'src');
    try { statSync(src); } catch { continue; }
    for (const file of sourceFiles(src)) {
      if (file.endsWith(join('mime', 'crlf.ts'))) continue;
      const text = readFileSync(file, 'utf8');
      if (/streamTransport\s*:/.test(text) || /\bnewline\s*:\s*['"]/.test(text) || /mail-composer/.test(text)) {
        offenders.push(relative(packages, file));
      }
    }
  }
  assert.deepEqual(offenders, [], 'build MIME with storage CRLF_STREAM_TRANSPORT');
});
