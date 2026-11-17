/**
 * 9.3: ZIP reader (central directory, deflate/stored, ZIP64, CRC, size caps) and
 * the byte-exact mboxrd reader. Temp files only.
 * Run: node --import tsx --test src/restore/readers.test.ts  (in packages/backup-service)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';
import archiver from 'archiver';
import { openZip, crc32, looksLikeZip, ZipFormatError, ZipEntryTooLargeError } from './zip-reader.js';
import { readMbox, looksLikeMbox } from './mbox-reader.js';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as Record<string, unknown>)['__prisma'] ??= { $on: () => undefined };
const { mboxEntry } = await import('../export/mbox.js');

const dir = mkdtempSync(join(tmpdir(), 'cm-readers-'));

async function makeZip(name: string, entries: Array<{ name: string; data: Buffer; store?: boolean }>, opts: { forceZip64?: boolean } = {}): Promise<string> {
  const path = join(dir, name);
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path);
    const a = archiver('zip', { zlib: { level: 6 }, ...(opts.forceZip64 ? { forceZip64: true } : {}) });
    out.on('close', () => resolve());
    a.on('error', reject);
    a.pipe(out);
    for (const e of entries) a.append(e.data, { name: e.name, ...(e.store ? { store: true } : {}) });
    void a.finalize();
  });
  return path;
}

const random = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7919 + (i >> 3)) % 256));
const text = Buffer.from('Grüße aus München\r\n'.repeat(5000), 'utf8');

test('crc32 matches zlib', () => {
  if (typeof zlibCrc32 === 'function') assert.equal(crc32(random), zlibCrc32(random));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('ZIP: deflate + stored + empty + UTF-8 names round trip through the central directory', async () => {
  const path = await makeZip('a.zip', [
    { name: 'mail/INBOX/1.eml', data: text },
    { name: 'mail/Entwürfe/2.eml', data: random, store: true },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ]);
  assert.ok(looksLikeZip(readFileSync(path).subarray(0, 4)));
  const zip = await openZip(path);
  try {
    assert.deepEqual(zip.entries.map((e) => e.name), ['mail/INBOX/1.eml', 'mail/Entwürfe/2.eml', 'empty.txt']);
    assert.ok((await zip.read(zip.entries[0]!, 1e9)).equals(text));
    assert.ok((await zip.read(zip.entries[1]!, 1e9)).equals(random));
    assert.equal((await zip.read(zip.entries[2]!, 1e9)).length, 0);
    await assert.rejects(zip.read(zip.entries[0]!, 1000), ZipEntryTooLargeError, 'size cap before inflating');
  } finally {
    await zip.close();
  }
});

test('ZIP64 archives are read', async () => {
  const path = await makeZip('z64.zip', [{ name: 'mail/INBOX/1.eml', data: text }, { name: 'x.bin', data: random }], { forceZip64: true });
  const zip = await openZip(path);
  try {
    assert.equal(zip.entries.length, 2);
    assert.ok((await zip.read(zip.entries[1]!, 1e9)).equals(random));
  } finally {
    await zip.close();
  }
});

test('ZIP: a modified byte fails the CRC / inflate check; non-ZIP and limits rejected', async () => {
  const path = await makeZip('c.zip', [{ name: 'x.bin', data: random, store: true }]);
  const buf = readFileSync(path);
  buf[100] = buf[100]! ^ 0xff; // inside the stored data
  writeFileSync(join(dir, 'c-bad.zip'), buf);
  const zip = await openZip(join(dir, 'c-bad.zip'));
  try {
    await assert.rejects(zip.read(zip.entries[0]!, 1e9), /CRC mismatch/);
  } finally {
    await zip.close();
  }
  writeFileSync(join(dir, 'no.zip'), Buffer.from('From someone\r\nnot a zip at all, just text that is long enough'));
  await assert.rejects(openZip(join(dir, 'no.zip')), ZipFormatError);
  await assert.rejects(openZip(path, { maxEntries: 0 }), /too many ZIP entries/);
});

const MSGS = [
  Buffer.from('From: a@x\r\nSubject: one\r\n\r\nFrom the start\r\n>From quoted\r\n>>From double\r\n'),
  Buffer.from('From: b@x\r\nSubject: two\r\n\r\nlone\rCR and trailing blank\r\n\r\n'),
  Buffer.from('From: c@x\nSubject: lf only\n\nbody\n'),
];

async function collect(path: string, max = 1e9) {
  const out = [];
  for await (const m of readMbox(path, { maxMessageBytes: max })) out.push(m);
  return out;
}

test('MBOX: export entries read back byte-exact (quoting, lone CR, trailing empty line, LF-only)', async () => {
  const file = Buffer.concat(MSGS.map((m, i) => mboxEntry(m, `s${i}@x`, new Date('2026-01-02T03:04:05Z'))));
  const path = join(dir, 'a.mbox');
  writeFileSync(path, file);
  assert.ok(looksLikeMbox(file.subarray(0, 8)));
  const got = await collect(path);
  assert.equal(got.length, 3);
  got.forEach((m, i) => assert.ok(m.raw!.equals(MSGS[i]!), `message ${i + 1} byte-exact`));
});

test('MBOX: Thunderbird-style file; an unquoted "From " body line without a preceding empty line stays in the message', async () => {
  const file = Buffer.from([
    'From - Tue Jan  2 03:04:05 2026', 'Subject: tb', '', 'text', 'From me, with love', 'end', '',
    'From - Wed Jan  3 03:04:05 2026', 'Subject: tb2', '', 'second', '',
  ].join('\n'));
  writeFileSync(join(dir, 'tb.mbox'), file);
  const got = await collect(join(dir, 'tb.mbox'));
  assert.equal(got.length, 2);
  assert.equal(got[0]!.raw!.toString(), 'Subject: tb\n\ntext\nFrom me, with love\nend\n');
  assert.equal(got[1]!.raw!.toString(), 'Subject: tb2\n\nsecond\n');
});

test('MBOX: oversized messages are reported without content, the rest is read', async () => {
  const big = Buffer.from(`Subject: big\r\n\r\n${'x'.repeat(5000)}\r\n`);
  const file = Buffer.concat([mboxEntry(big, 'a@x', new Date()), mboxEntry(MSGS[0]!, 'b@x', new Date())]);
  writeFileSync(join(dir, 'big.mbox'), file);
  const got = await collect(join(dir, 'big.mbox'), 1000);
  assert.equal(got.length, 2);
  assert.equal(got[0]!.raw, null);
  assert.ok(got[0]!.size > 1000);
  assert.ok(got[1]!.raw!.equals(MSGS[0]!));
  // a single overlong line (no line break) is capped too
  writeFileSync(join(dir, 'line.mbox'), Buffer.concat([Buffer.from('From x\r\n'), Buffer.alloc(300_000, 0x61)]));
  const one = await collect(join(dir, 'line.mbox'), 1000);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.raw, null);
});

test('MBOX: bytes before the first separator are not a message; no separator → nothing', async () => {
  writeFileSync(join(dir, 'none.mbox'), Buffer.from('PK\u0003\u0004 binary junk\r\nmore\r\n'));
  assert.equal((await collect(join(dir, 'none.mbox'))).length, 0);
  assert.equal(looksLikeMbox(Buffer.from('PK\u0003\u0004')), false);
});
