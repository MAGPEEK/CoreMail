/**
 * 9.3 review fixes of the restore path:
 *  5. dedupe: Message-ID + size only matches target rows WITHOUT a content-addressed raw object;
 *  6. ZIP reader: zip bomb (total budget), overlapping / shared local headers, huge entry
 *     count, compressed-size cap, small manifest cap;
 *  7. MBOX round trip byte-exact for a message without trailing line break and for
 *     "From " after a lone CR;
 *  8. same restore-folder date for archive and upload restores (manifest first);
 *  9. folder names from the manifest validated, folder cap, lost lock aborts the restore;
 * 10. pre-9.3 upload contract helpers (legacy query, sync wait, response shape).
 * In-memory Prisma (storage test-support) + in-memory object store; no Redis.
 * Run: node --import tsx --test src/restore/restore-review.test.ts  (in packages/backup-service)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createWriteStream, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import archiver from 'archiver';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['LOG_LEVEL'] ??= 'error';

const objects = new Map<string, Buffer>();
const notFound = (key: string) => Object.assign(new Error(`NoSuchKey: ${key}`), { code: 'NoSuchKey' });
(globalThis as Record<string, unknown>)['__objectStore'] = {
  driver: 'filesystem', location: 'memory', init: async () => ({ lifecycle: false }),
  put: async (key: string, data: Buffer) => { objects.set(key, Buffer.from(data)); },
  putStream: async (key: string, s: Readable) => { const parts: Buffer[] = []; for await (const c of s) parts.push(c as Buffer); objects.set(key, Buffer.concat(parts)); },
  get: async (key: string) => { const d = objects.get(key); if (!d) throw notFound(key); return Buffer.from(d); },
  getStream: async (key: string) => { const d = objects.get(key); if (!d) throw notFound(key); return Readable.from([d]); },
  stat: async (key: string) => (objects.has(key) ? { size: objects.get(key)!.length, lastModified: new Date() } : null),
  exists: async (key: string) => objects.has(key),
  delete: async (key: string) => { objects.delete(key); },
  list: async function* (prefix: string) { for (const [key, d] of objects) if (key.startsWith(prefix)) yield { key, size: d.length, lastModified: new Date() }; },
};

const { createFake, emptyDb } = await import('../../../storage/src/test-support/mailbox-fake.js');
const db = emptyDb();
const fake = createFake(db) as Record<string, unknown>;
(globalThis as Record<string, unknown>)['__prisma'] = fake;

const { rawContentKey } = await import('@coremail/storage');
const { restoreItems, emptyCounts, zipItems, RestoreAbortedError, isContentAddressedKey, MAX_MANIFEST_BYTES } = await import('./engine.js');
const { openZip, ZipFormatError, ZipEntryTooLargeError } = await import('./zip-reader.js');
const { readMbox } = await import('./mbox-reader.js');
const { mboxEntry } = await import('../export/mbox.js');
const { validRestoreFolder } = await import('./source.js');
const {
  restoreRootDate, zipBackupDate, executeRestoreJob, restoreConfig,
  isLegacyImportQuery, waitWithTimeout, legacyImportResult, legacyImportTimeoutMs,
} = await import('./job.js');
const { withLock, LockLostError, EXTEND_SCRIPT } = await import('../scheduler/locks.js');
const { MANIFEST_NAME, MANIFEST_FORMAT } = await import('../export/manifest.js');

const dir = mkdtempSync(join(tmpdir(), 'cm-restore-review-'));
const crlf = (...l: string[]) => Buffer.from(`${l.join('\r\n')}\r\n`, 'latin1');

let seq = 0;
function addMailbox(userId: string, folders: string[]): { id: string; folders: Record<string, string> } {
  const id = `mb-${userId}`;
  db.mailboxes.push({ id, userId, uidNext: 1, highestModSeq: 0n });
  const out: Record<string, string> = {};
  for (const name of folders) {
    const fid = `f-${userId}-${++seq}`;
    db.folders.push({ id: fid, mailboxId: id, name, displayName: name, parentId: null, totalCount: 0, unreadCount: 0 });
    out[name] = fid;
  }
  return { id, folders: out };
}
const messagesIn = (folderId: string) => db.messages.filter((m) => m['folderId'] === folderId && m['deletedAt'] == null);
const foldersOf = (mailboxId: string) => db.folders.filter((f) => f['mailboxId'] === mailboxId).map((f) => f['name'] as string);

async function* itemsOf(list: Array<{ raw: Buffer; folder?: string | null }>) {
  let i = 0;
  for (const x of list) yield { raw: x.raw, folder: x.folder ?? null, flags: null, ref: `#${++i}` };
}

async function makeZip(name: string, entries: Array<{ name: string; data: Buffer }>): Promise<string> {
  const path = join(dir, name);
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path);
    const a = archiver('zip', { zlib: { level: 6 } });
    out.on('close', () => resolve());
    a.on('error', reject);
    a.pipe(out);
    for (const e of entries) a.append(e.data, { name: e.name });
    void a.finalize();
  });
  return path;
}

// ── 5. dedupe ────────────────────────────────────────────────────────────────

test('dedupe: a different message with the same Message-ID + size does not suppress the archived original', async () => {
  const mb = addMailbox('d1', ['INBOX']);
  const inbox = mb.folders['INBOX']!;
  const original = crlf('From: a@x.test', 'To: b@x.test', 'Subject: Original', 'Message-ID: <same@x.test>', '', 'AAAA');
  const other = crlf('From: a@x.test', 'To: b@x.test', 'Subject: Original', 'Message-ID: <same@x.test>', '', 'BBBB');
  assert.equal(original.length, other.length);
  const otherKey = rawContentKey(createHash('sha256').update(other).digest('hex'));
  assert.equal(isContentAddressedKey(otherKey), true);
  objects.set(otherKey, other);
  db.messages.push({ id: 'm-other', folderId: inbox, uid: 1, modSeq: 1n, flags: [], messageId: '<same@x.test>', rawSize: other.length, storagePath: otherKey, deletedAt: null, createdAt: new Date() });

  const c = await restoreItems(itemsOf([{ raw: original }]), { mailboxId: mb.id, mode: 'folder', folderId: inbox, rootName: '' }, emptyCounts());
  assert.equal(c.imported, 1, 'archived original restored');
  assert.equal(c.duplicates, 0);
  // byte-identical re-run: content key match stays primary
  const again = await restoreItems(itemsOf([{ raw: original }]), { mailboxId: mb.id, mode: 'folder', folderId: inbox, rootName: '' }, emptyCounts());
  assert.deepEqual([again.imported, again.duplicates], [0, 1]);

  // a LEGACY row (no content-addressed object) with the same Message-ID + size still counts as duplicate
  const mb2 = addMailbox('d2', ['INBOX']);
  db.messages.push({ id: 'm-legacy', folderId: mb2.folders['INBOX'], uid: 1, modSeq: 1n, flags: [], messageId: '<same@x.test>', rawSize: original.length, storagePath: null, deletedAt: null, createdAt: new Date() });
  const legacy = await restoreItems(itemsOf([{ raw: original }]), { mailboxId: mb2.id, mode: 'folder', folderId: mb2.folders['INBOX']!, rootName: '' }, emptyCounts());
  assert.deepEqual([legacy.imported, legacy.duplicates], [0, 1]);
});

// ── 6. ZIP reader guards ─────────────────────────────────────────────────────

/** Minimal ZIP writer (stored / raw-deflate data given as-is) for crafted archives. */
function craftZip(entries: Array<{ name: string; data: Buffer; method?: number; usize?: number; csize?: number; offsetOf?: number }>, eocdCount?: number): Buffer {
  const locals: Buffer[] = [];
  const offsets: number[] = [];
  let pos = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'latin1');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(e.method ?? 0, 8);
    lh.writeUInt32LE(e.csize ?? e.data.length, 18);
    lh.writeUInt32LE(e.usize ?? e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    offsets.push(pos);
    locals.push(lh, name, e.data);
    pos += 30 + name.length + e.data.length;
  }
  const cdStart = pos;
  const central: Buffer[] = [];
  entries.forEach((e, i) => {
    const name = Buffer.from(e.name, 'latin1');
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(e.method ?? 0, 10);
    c.writeUInt32LE(0, 16);
    c.writeUInt32LE(e.csize ?? e.data.length, 20);
    c.writeUInt32LE(e.usize ?? e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(e.offsetOf !== undefined ? offsets[e.offsetOf]! : offsets[i]!, 42);
    central.push(c, name);
  });
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(eocdCount ?? entries.length, 8);
  eocd.writeUInt16LE(eocdCount ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('ZIP bomb: declared total above the budget is refused when the archive is opened', async () => {
  const path = await makeZip('bomb.zip', [{ name: 'mail/INBOX/1.eml', data: Buffer.alloc(3 * 1024 * 1024) }, { name: 'mail/INBOX/2.eml', data: Buffer.alloc(3 * 1024 * 1024) }]);
  await assert.rejects(openZip(path, { maxTotalUncompressedBytes: 4 * 1024 * 1024 }), (e: unknown) => e instanceof ZipFormatError && /expands to more than/.test((e as Error).message));
  const ok = await openZip(path, { maxTotalUncompressedBytes: 8 * 1024 * 1024 });
  try {
    // async inflate still returns the exact content
    assert.equal((await ok.read(ok.entries[0]!, 4 * 1024 * 1024)).length, 3 * 1024 * 1024);
  } finally { await ok.close(); }
});

test('ZIP: overlapping / shared local headers, huge declared count and oversized compressed data are refused', async () => {
  const p1 = join(dir, 'overlap.zip');
  writeFileSync(p1, craftZip([{ name: 'a.eml', data: Buffer.from('hello') }, { name: 'b.eml', data: Buffer.from('world') }, { name: 'c.eml', data: Buffer.alloc(0), offsetOf: 0 }]));
  await assert.rejects(openZip(p1), (e: unknown) => e instanceof ZipFormatError && /overlap/.test((e as Error).message));

  const p2 = join(dir, 'count.zip');
  writeFileSync(p2, craftZip([{ name: 'a.eml', data: Buffer.from('x') }], 60_000));
  await assert.rejects(openZip(p2), (e: unknown) => e instanceof ZipFormatError && /central directory/.test((e as Error).message));
  await assert.rejects(openZip(p2, { maxEntries: 10 }), /too many ZIP entries/);

  // deflate entry declaring 10 bytes uncompressed but 200 kB compressed: not read into memory
  const p3 = join(dir, 'csize.zip');
  writeFileSync(p3, craftZip([{ name: 'a.eml', data: Buffer.alloc(200_000, 1), method: 8, usize: 10 }]));
  const z = await openZip(p3);
  try {
    await assert.rejects(z.read(z.entries[0]!, 100), ZipEntryTooLargeError);
  } finally { await z.close(); }
});

test('ZIP manifest larger than 16 MiB is not parsed (folders from paths, no backup date)', async () => {
  const big = Buffer.alloc(MAX_MANIFEST_BYTES + 1024, 0x20); // whitespace: compresses well
  const path = await makeZip('big-manifest.zip', [
    { name: MANIFEST_NAME, data: big },
    { name: 'mail/Projekte/1.eml', data: crlf('From: a@x.test', 'Subject: x', '', 'y') },
  ]);
  assert.equal(await zipBackupDate(path), null);
  const items = [];
  for await (const it of zipItems(path, { maxMessageBytes: 1e6 }, emptyCounts())) items.push(it);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.folder, 'Projekte');
  assert.equal(items[0]!.flags, null);
});

// ── 7. MBOX round trip ───────────────────────────────────────────────────────

test('MBOX: no trailing line break and "From " after a lone CR survive the round trip byte-exactly', async () => {
  const noEol = Buffer.from('From: a@x.test\r\nSubject: no eol\r\n\r\nlast line without break', 'latin1');
  const loneCr = Buffer.from('From: a@x.test\r\nSubject: cr\r\n\r\nx\rFrom here\r\ny\r>From there\r\nFrom start\r\n', 'latin1');
  const endsWithCr = Buffer.from('From: a@x.test\r\nSubject: cr-end\r\n\r\ntext\r', 'latin1');
  const normal = crlf('From: a@x.test', 'Subject: normal', '', 'body', '');
  const msgs = [noEol, loneCr, endsWithCr, normal];
  const path = join(dir, 'rt.mbox');
  writeFileSync(path, Buffer.concat(msgs.map((m) => mboxEntry(m, 'a@x.test', new Date('2026-11-16T00:00:00Z')))));
  const out: Buffer[] = [];
  for await (const m of readMbox(path, { maxMessageBytes: 1e6 })) out.push(m.raw!);
  assert.equal(out.length, msgs.length);
  msgs.forEach((m, i) => assert.ok(out[i]!.equals(m), `message ${i} byte-exact: ${JSON.stringify(out[i]!.toString('latin1'))}`));
});

// ── 8. restore folder date ───────────────────────────────────────────────────

test('restore folder date: manifest creation time for archive AND upload restores, else the job date', async () => {
  const manifest = Buffer.from(JSON.stringify({ format: MANIFEST_FORMAT, version: 1, createdAt: '2026-03-04T23:30:00.000Z', userId: 'u', folders: [], messages: [] }));
  const zipPath = await makeZip('dated.zip', [{ name: MANIFEST_NAME, data: manifest }]);
  const jobDate = new Date('2026-03-05T02:00:00Z'); // the job row was written after midnight
  assert.equal((await restoreRootDate(zipPath, 'zip', jobDate)).toISOString(), '2026-03-04T23:30:00.000Z');
  assert.equal((await restoreRootDate(zipPath, 'zip', null)).toISOString(), '2026-03-04T23:30:00.000Z');
  const mboxPath = join(dir, 'x.mbox');
  writeFileSync(mboxPath, mboxEntry(crlf('Subject: a', '', 'b'), 'a@x.test', new Date()));
  assert.equal((await restoreRootDate(mboxPath, 'mbox', jobDate)).toISOString(), jobDate.toISOString());

  // archive restore: the provisional name (job date) is replaced after the download
  const mb = addMailbox('date1', ['INBOX']);
  const jobs: Array<Record<string, unknown>> = [];
  fake['backupJob'] = { update: async ({ data }: { data: Record<string, unknown> }) => { jobs.push(data); return {}; } };
  const work = mkdtempSync(join(tmpdir(), 'cm-date-'));
  const p = {
    path: join(work, 'archive.zip'), dir: work, format: 'zip' as const, sizeBytes: 0, targetUserId: 'date1', mailboxId: mb.id,
    mode: 'subfolder' as const, folderId: null, rootName: 'Wiederhergestellt 2026-03-05', source: {}, rootDateFallback: jobDate,
  };
  const { readFileSync } = await import('node:fs');
  await executeRestoreJob('job-date', p, restoreConfig({}), async () => { writeFileSync(p.path, readFileSync(zipPath)); return 1; });
  assert.equal(p.rootName, 'Wiederhergestellt 2026-03-04', 'same folder as an upload of this backup');
});

// ── 9. folder names, folder cap, lost lock ───────────────────────────────────

test('folder names from the manifest: invalid / reserved names refused (→ restore folder), cap on created folders', async () => {
  const reserved = (n: string) => /^(shared|other users)\//i.test(n);
  assert.equal(validRestoreFolder('Projekte.2026', reserved), 'Projekte.2026');
  assert.equal(validRestoreFolder(' INBOX . Sub ', reserved), 'INBOX.Sub');
  assert.equal(validRestoreFolder('Shared/Team', reserved), null);
  assert.equal(validRestoreFolder('a/b', reserved), null);
  assert.equal(validRestoreFolder('a\\b', reserved), null);
  assert.equal(validRestoreFolder('bad\u0001name', reserved), null);
  assert.equal(validRestoreFolder('x'.repeat(101), reserved), null);
  assert.equal(validRestoreFolder(Array.from({ length: 33 }, (_, i) => `l${i}`).join('.'), reserved), null);
  assert.equal(validRestoreFolder('...', reserved), null);
  assert.equal(validRestoreFolder(null, reserved), null);

  const mb = addMailbox('fold1', ['INBOX']);
  const ROOT = 'Wiederhergestellt 2026-11-16';
  const msg = (n: number) => crlf('From: a@x.test', `Subject: m${n}`, `Message-ID: <m${n}@x.test>`, '', `body ${n}`);
  const c = await restoreItems(itemsOf([
    { raw: msg(1), folder: 'Other Users/bob' },
    { raw: msg(2), folder: 'evil\u0000name' },
    { raw: msg(3), folder: 'A' },
    { raw: msg(4), folder: 'B' },
    { raw: msg(5), folder: 'C' }, // beyond the cap
  ]), { mailboxId: mb.id, mode: 'original', folderId: null, rootName: ROOT, maxFolders: 3 }, emptyCounts()); // restore folder + A + B
  assert.equal(c.imported, 5);
  const names = foldersOf(mb.id);
  assert.ok(names.includes(ROOT), 'refused / capped messages went to the restore folder');
  assert.ok(!names.some((n) => /Other Users|evil|^C$/.test(n)), names.join(','));
  assert.ok(names.includes('A') && names.includes('B'));
  const root = db.folders.find((f) => f['mailboxId'] === mb.id && f['name'] === ROOT)!;
  assert.equal(messagesIn(root['id'] as string).length, 3);
});

test('restore lock lost → the lock signal aborts and the engine writes nothing more', async () => {
  const redis = {
    set: async () => 'OK' as const,
    eval: async (script: string) => (script === EXTEND_SCRIPT ? 0 : 1), // renewal finds another owner
  };
  const reason = await withLock(redis, 'backup:restore:mb', (signal) => new Promise<unknown>((resolve) => {
    const t = setTimeout(() => resolve('not aborted'), 5_000);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(signal.reason); });
  }), { ttlMs: 3_000 });
  assert.ok(reason.ran && reason.value instanceof LockLostError, String(reason.ran && reason.value));

  const mb = addMailbox('lock1', ['INBOX']);
  const ac = new AbortController();
  ac.abort();
  const before = db.messages.length;
  await assert.rejects(
    restoreItems(itemsOf([{ raw: crlf('Subject: x', '', 'y') }]), { mailboxId: mb.id, mode: 'folder', folderId: mb.folders['INBOX']!, rootName: '' }, emptyCounts(), undefined, ac.signal),
    (e: unknown) => e instanceof RestoreAbortedError && /Sperre/.test((e as Error).message),
  );
  assert.equal(db.messages.length, before);
});

// ── 10. pre-9.3 upload contract ──────────────────────────────────────────────

test('legacy upload contract: detection, sync wait with fallback, previous response shape', async () => {
  assert.equal(isLegacyImportQuery({ folderId: 'f1' }), true);
  assert.equal(isLegacyImportQuery({ folderId: 'f1', mode: 'folder' }), false);
  assert.equal(isLegacyImportQuery({ mode: 'subfolder' }), false);
  assert.equal(isLegacyImportQuery({}), false);
  assert.equal(legacyImportTimeoutMs({}), 240_000);

  assert.deepEqual(await waitWithTimeout(Promise.resolve(7), 1_000), { done: true, value: 7 });
  assert.deepEqual(await waitWithTimeout(new Promise(() => undefined), 20), { done: false });

  const counts = { ...emptyCounts(), total: 3, imported: 2, duplicates: 1, failed: 0 };
  assert.deepEqual(legacyImportResult(counts, true, 'j1', null), { status: 200, body: { imported: 2, errors: 0, duplicates: 1, encrypted: true, jobId: 'j1' } });
  assert.deepEqual(legacyImportResult(null, false, 'j2', 'kaputt'), { status: 500, body: { error: 'kaputt', jobId: 'j2' } });
});
