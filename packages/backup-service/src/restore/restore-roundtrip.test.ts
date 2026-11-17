/**
 * 9.3 end-to-end-ish restore test: a mailbox (two folder levels, attachment,
 * flags, a legacy row without raw object) is exported through the REAL export
 * code (ZIP with manifest / MBOX), optionally encrypted, and restored through
 * the REAL restore code into an empty mailbox. Checks: byte-exact raw messages,
 * folders + flags, attachment rows, UIDs/modSeqs from the message store, and
 * that a second restore adds nothing (idempotent).
 * In-memory Prisma (storage test-support) + in-memory object store.
 * Run: node --import tsx --test src/restore/restore-roundtrip.test.ts  (in packages/backup-service)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

// ── in-memory object store (getObjectStore() seam) ──────────────────────────
const objects = new Map<string, Buffer>();
const notFound = (key: string) => Object.assign(new Error(`NoSuchKey: ${key}`), { code: 'NoSuchKey' });
(globalThis as Record<string, unknown>)['__objectStore'] = {
  driver: 'filesystem',
  location: 'memory',
  init: async () => ({ lifecycle: false }),
  put: async (key: string, data: Buffer) => { objects.set(key, Buffer.from(data)); },
  putStream: async (key: string, s: Readable) => { const parts: Buffer[] = []; for await (const c of s) parts.push(c as Buffer); objects.set(key, Buffer.concat(parts)); },
  get: async (key: string) => { const d = objects.get(key); if (!d) throw notFound(key); return Buffer.from(d); },
  getStream: async (key: string) => { const d = objects.get(key); if (!d) throw notFound(key); return Readable.from([d]); },
  stat: async (key: string) => (objects.has(key) ? { size: objects.get(key)!.length, lastModified: new Date() } : null),
  exists: async (key: string) => objects.has(key),
  delete: async (key: string) => { objects.delete(key); },
  list: async function* (prefix: string) { for (const [key, d] of objects) if (key.startsWith(prefix)) yield { key, size: d.length, lastModified: new Date() }; },
};

// ── in-memory Prisma ────────────────────────────────────────────────────────
const { createFake, emptyDb } = await import('../../../storage/src/test-support/mailbox-fake.js');
const db = emptyDb();
const fake = createFake(db) as Record<string, unknown>;
const jobs: Array<Record<string, unknown>> = [];
fake['contact'] = { findMany: async () => [] };
fake['calendar'] = { findMany: async () => [] };
fake['backupJob'] = {
  create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `job${jobs.length + 1}`, createdAt: new Date(), ...data }; jobs.push(row); return row; },
  update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = jobs.find((j) => j['id'] === where.id);
    if (!row) throw new Error('job not found');
    Object.assign(row, data);
    return row;
  },
};
(globalThis as Record<string, unknown>)['__prisma'] = fake;

const { storeRawMessage, reconstructRawMessage, resetMessageStoreCache } = await import('@coremail/storage');
const { exportZip } = await import('../export/zip.js');
const { exportMbox } = await import('../export/mbox.js');
const { importMbox } = await import('./index.js');
const { restorePrepared, detectFormat, executeRestoreJob, writeCapped, restoreConfig, zipBackupDate, decryptErrorMessage, RestoreTooLargeError } = await import('./job.js');
const { prepareUploadedFile } = await import('./import-file.js');
const { encryptFile, loadKeyring, BackupDecryptError } = await import('../crypto/backup-crypto.js');

const ROOT = 'Wiederhergestellt 2026-11-16';
const crlf = (...l: string[]) => Buffer.from(`${l.join('\r\n')}\r\n`, 'latin1');

// Attachment with every byte value (base64), a quoted-printable body with a lone CR
const binary = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 131 + 7) % 256));
const WITH_ATTACHMENT = crlf(
  'From: "Alice" <alice@x.test>', 'To: bob@x.test', 'Subject: Quarterly figures', 'Date: Mon, 02 Nov 2026 10:00:00 +0000',
  'Message-ID: <att-1@x.test>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
  '--b1', 'Content-Type: text/plain; charset=utf-8', '', 'see attachment', '',
  '--b1', 'Content-Type: application/octet-stream; name="data.bin"', 'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="data.bin"', '', binary.toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd(), '--b1--',
);
const WITH_FROM_LINES = Buffer.concat([crlf(
  'From: carol@x.test', 'To: bob@x.test', 'Subject: quoting', 'Date: Tue, 03 Nov 2026 10:00:00 +0000', 'Message-ID: <q-2@x.test>', '',
  'From here on', '>From quoted', 'lone CR follows:'), Buffer.from('a\rb\r\n'), crlf('', '')]); // ends with an empty line
const IN_SUBFOLDER = crlf('From: dave@x.test', 'To: bob@x.test', 'Subject: Projekt 2026', 'Date: Wed, 04 Nov 2026 10:00:00 +0000', 'Message-ID: <p-3@x.test>', '', 'Plan');

let seq = 0;
function addMailbox(userId: string, folders: Array<{ name: string; parent?: string }>): { id: string; folders: Record<string, string> } {
  const id = `mb-${userId}`;
  db.mailboxes.push({ id, userId, uidNext: 1, highestModSeq: 0n });
  const out: Record<string, string> = {};
  for (const f of folders) {
    const fid = `f-${userId}-${++seq}`;
    db.folders.push({ id: fid, mailboxId: id, name: f.name, displayName: f.name.split('.').pop(), parentId: f.parent ? out[f.parent] ?? null : null, totalCount: 0, unreadCount: 0 });
    out[f.name] = fid;
  }
  return { id, folders: out };
}

const SOURCE_MESSAGES: Array<{ folder: string; raw: Buffer | null; flags: string[]; legacy?: boolean }> = [
  { folder: 'INBOX', raw: WITH_ATTACHMENT, flags: ['\\Seen', '\\Flagged'] },
  { folder: 'INBOX', raw: WITH_FROM_LINES, flags: ['$Forwarded'] },
  { folder: 'Projekte.2026', raw: IN_SUBFOLDER, flags: ['\\Answered', '\\Deleted', '\\Seen'] },
  { folder: 'Projekte', raw: null, flags: ['\\Seen'], legacy: true },
];

const src = addMailbox('alice', [{ name: 'INBOX' }, { name: 'Projekte' }, { name: 'Projekte.2026', parent: 'Projekte' }]);
const expectedRaw = new Map<string, Buffer>(); // message subject → raw octets
let uid = 0;
for (const m of SOURCE_MESSAGES) {
  const row: Record<string, unknown> = {
    id: `src-${++uid}`, folderId: src.folders[m.folder], uid, modSeq: BigInt(uid), flags: m.flags,
    toAddrs: ['bob@x.test'], ccAddrs: [], bccAddrs: [], replyTo: null, inReplyTo: null,
    bodyText: '', bodyHtml: '', deletedAt: null, createdAt: new Date(),
  };
  if (m.legacy) {
    Object.assign(row, { storagePath: null, subject: 'Legacy row', fromAddr: 'old@x.test', fromName: 'Old', messageId: '<legacy-4@x.test>', date: new Date('2025-01-01T00:00:00Z'), bodyText: 'legacy text', rawSize: 0 });
    db.messages.push(row);
    expectedRaw.set('Legacy row', await reconstructRawMessage({ ...row, attachments: [] } as never));
  } else {
    const stored = await storeRawMessage(m.raw!);
    const subject = /Subject: (.*)\r\n/.exec(m.raw!.toString('latin1'))![1]!;
    Object.assign(row, { storagePath: stored.storagePath, subject, fromAddr: 'x@x.test', fromName: '', messageId: null, date: new Date('2026-11-02T10:00:00Z'), rawSize: m.raw!.length });
    db.messages.push(row);
    expectedRaw.set(subject, m.raw!);
  }
}
db.mailboxes[0]!['uidNext'] = uid + 1;
db.mailboxes[0]!['highestModSeq'] = BigInt(uid);

const dir = mkdtempSync(join(tmpdir(), 'cm-restore-rt-'));
const keyring = loadKeyring({ BACKUP_ENCRYPTION_KEY: 'c'.repeat(64) });
const cfg = { maxMessageBytes: 10 * 1024 * 1024 };

const foldersOf = (mailboxId: string) => db.folders.filter((f) => f['mailboxId'] === mailboxId);
const messagesOf = (mailboxId: string) => {
  const ids = new Set(foldersOf(mailboxId).map((f) => f['id']));
  return db.messages.filter((m) => ids.has(m['folderId']));
};
const folderName = (id: unknown) => db.folders.find((f) => f['id'] === id)?.['name'];

test('ZIP: export → encrypt → restore into an empty mailbox (original folders): byte-exact, folders, flags, attachments; re-run adds nothing', async () => {
  resetMessageStoreCache();
  const zipPath = join(dir, 'alice.zip');
  const { messageCount } = await exportZip('alice', null, zipPath);
  assert.equal(messageCount, 4);
  assert.equal(await detectFormat(zipPath), 'zip');
  assert.ok(await zipBackupDate(zipPath), 'manifest carries the backup date');

  // stored backups are encrypted: decrypt like an upload of a .zip.enc
  const encPath = join(dir, 'alice.zip.enc');
  await encryptFile(zipPath, encPath, keyring.current);
  assert.equal(await detectFormat(encPath), 'encrypted');
  const plain = await prepareUploadedFile(encPath, dir, () => keyring);
  assert.equal(plain.encrypted, true);
  assert.equal(await detectFormat(plain.path), 'zip');

  const dst = addMailbox('bob', [{ name: 'INBOX' }]);
  const counts = await restorePrepared({ path: plain.path, format: 'zip', mailboxId: dst.id, mode: 'original', folderId: null, rootName: ROOT }, cfg);
  assert.deepEqual(counts, { total: 4, imported: 4, duplicates: 0, failed: 0, otherEntries: 0, foldersCreated: 2 });

  // folders: hierarchy with parentId + displayName of the last segment
  const names = foldersOf(dst.id).map((f) => f['name']).sort();
  assert.deepEqual(names, ['INBOX', 'Projekte', 'Projekte.2026']);
  const sub = foldersOf(dst.id).find((f) => f['name'] === 'Projekte.2026')!;
  assert.equal(sub['displayName'], '2026');
  assert.equal(folderName(sub['parentId']), 'Projekte');

  const restored = messagesOf(dst.id);
  assert.equal(restored.length, 4);
  for (const m of restored) {
    const want = expectedRaw.get(m['subject'] as string);
    assert.ok(want, `unexpected message ${m['subject']}`);
    assert.ok(objects.get(m['storagePath'] as string)!.equals(want), `raw of "${m['subject']}" byte-exact`);
    assert.equal(m['rawSize'], want.length);
  }
  const bySubject = (s: string) => restored.find((m) => m['subject'] === s)!;
  assert.equal(folderName(bySubject('Quarterly figures')['folderId']), 'INBOX');
  assert.deepEqual(bySubject('Quarterly figures')['flags'], ['\\Seen', '\\Flagged']);
  assert.deepEqual(bySubject('quoting')['flags'], ['$Forwarded'], 'keyword kept, unread');
  assert.equal(folderName(bySubject('Projekt 2026')['folderId']), 'Projekte.2026');
  assert.deepEqual(bySubject('Projekt 2026')['flags'], ['\\Answered', '\\Seen'], '\\Deleted dropped');
  assert.equal(folderName(bySubject('Legacy row')['folderId']), 'Projekte');

  // attachment row + object of the restored message
  const att = db.attachments.filter((a) => a['messageId'] === bySubject('Quarterly figures')['id']);
  assert.equal(att.length, 1);
  assert.equal(att[0]!['filename'], 'data.bin');
  assert.ok(objects.get(att[0]!['storagePath'] as string)!.equals(binary), 'attachment content byte-exact');

  // message store: unique consecutive UIDs, modSeqs from the mailbox counter
  const uids = restored.map((m) => m['uid'] as number).sort((a, b) => a - b);
  assert.deepEqual(uids, [1, 2, 3, 4]);
  const mbx = db.mailboxes.find((m) => m['id'] === dst.id)!;
  assert.equal(mbx['uidNext'], 5);
  assert.ok(restored.every((m) => typeof m['modSeq'] === 'bigint' && (m['modSeq'] as bigint) <= (mbx['highestModSeq'] as bigint)));
  // unread counter: only "quoting" is unread
  assert.equal(foldersOf(dst.id).find((f) => f['name'] === 'INBOX')!['unreadCount'], 1);

  // idempotent: the same archive again restores nothing
  const again = await restorePrepared({ path: plain.path, format: 'zip', mailboxId: dst.id, mode: 'original', folderId: null, rootName: ROOT }, cfg);
  assert.deepEqual(again, { total: 4, imported: 0, duplicates: 4, failed: 0, otherEntries: 0, foldersCreated: 0 });
  assert.equal(messagesOf(dst.id).length, 4);
});

test('ZIP restore into a restore folder keeps the structure below "Wiederhergestellt <date>"', async () => {
  const zipPath = join(dir, 'alice-sub.zip');
  await exportZip('alice', null, zipPath);
  const dst = addMailbox('carol', [{ name: 'INBOX' }]);
  const counts = await restorePrepared({ path: zipPath, format: 'zip', mailboxId: dst.id, mode: 'subfolder', folderId: null, rootName: ROOT }, cfg);
  assert.equal(counts.imported, 4);
  const names = foldersOf(dst.id).map((f) => f['name']).sort();
  assert.deepEqual(names, ['INBOX', ROOT, `${ROOT}.INBOX`, `${ROOT}.Projekte`, `${ROOT}.Projekte.2026`]);
  assert.equal(messagesOf(dst.id).filter((m) => folderName(m['folderId']) === 'INBOX').length, 0, 'the live INBOX is untouched');
  const again = await restorePrepared({ path: zipPath, format: 'zip', mailboxId: dst.id, mode: 'subfolder', folderId: null, rootName: ROOT }, cfg);
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 4);
});

test('MBOX: export → restore (restore folder, \\Seen) byte-exact; second run deduplicated', async () => {
  const mboxPath = join(dir, 'alice.mbox');
  const { messageCount } = await exportMbox('alice', null, mboxPath);
  assert.equal(messageCount, 4);
  assert.equal(await detectFormat(mboxPath), 'mbox');
  const dst = addMailbox('dave', [{ name: 'INBOX' }]);
  const counts = await restorePrepared({ path: mboxPath, format: 'mbox', mailboxId: dst.id, mode: 'subfolder', folderId: null, rootName: ROOT }, cfg);
  assert.deepEqual({ ...counts, foldersCreated: 0 }, { total: 4, imported: 4, duplicates: 0, failed: 0, otherEntries: 0, foldersCreated: 0 });
  const restored = messagesOf(dst.id);
  assert.ok(restored.every((m) => folderName(m['folderId']) === ROOT), 'MBOX has no folders: everything in the restore folder');
  assert.ok(restored.every((m) => (m['flags'] as string[]).join() === '\\Seen'));
  for (const m of restored) {
    // 9.3 review: also a message without a final line break (here: the legacy
    // reconstruction) comes back byte-exact (separator marker cm-noeol).
    const want = expectedRaw.get(m['subject'] as string)!;
    assert.ok(objects.get(m['storagePath'] as string)!.equals(want), `mbox raw of "${m['subject']}" byte-exact`);
  }
  assert.equal(restored.filter((m) => m['subject'] !== 'Legacy row').length, 3);
  const again = await restorePrepared({ path: mboxPath, format: 'mbox', mailboxId: dst.id, mode: 'subfolder', folderId: null, rootName: ROOT }, cfg);
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 4);
  // legacy entry point (pre-9.3 MBOX import route) shares the engine: idempotent too
  const inbox = foldersOf(dst.id).find((f) => f['name'] === ROOT)!;
  assert.deepEqual(await importMbox('dave', inbox['id'] as string, mboxPath), { imported: 0, errors: 0, duplicates: 4 });
});

test('regression: a CoreMail ZIP backup is never imported as one garbage MBOX message', async () => {
  const zipPath = join(dir, 'alice-regress.zip');
  await exportZip('alice', null, zipPath);
  const dst = addMailbox('erin', [{ name: 'INBOX' }]);
  const inbox = foldersOf(dst.id)[0]!;
  // Before 9.3 the upload restore parsed every file as MBOX: a ZIP became ONE message
  // (empty subject, binary body) and the BCP reported "1 importiert".
  const res = await importMbox('erin', inbox['id'] as string, zipPath);
  assert.equal(res.imported, 0);
  assert.equal(messagesOf(dst.id).length, 0);
  // the upload route detects the format first and restores the ZIP properly
  assert.equal(await detectFormat(zipPath), 'zip');
  writeFileSync(join(dir, 'random.bin'), Buffer.from('PK? no zip, no mbox'));
  assert.equal(await detectFormat(join(dir, 'random.bin')), null);
});

test('pre-9.3 ZIP without manifest: folders from the paths, flags \\Seen, contacts/calendar counted', async () => {
  const zipPath = join(dir, 'old.zip');
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const a = archiver('zip', { zlib: { level: 6 } });
    out.on('close', () => resolve());
    a.on('error', reject);
    a.pipe(out);
    a.append(IN_SUBFOLDER, { name: 'mail/Projekte.2026/7.eml' });
    a.append(WITH_ATTACHMENT, { name: 'mail/INBOX/8.eml' });
    a.append('BEGIN:VCARD\r\nEND:VCARD\r\n', { name: 'contacts/c1.vcf' });
    a.append('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { name: 'calendar/Kalender/e1.ics' });
    void a.finalize();
  });
  assert.equal(await zipBackupDate(zipPath), null);
  const dst = addMailbox('frank', [{ name: 'INBOX' }]);
  const counts = await restorePrepared({ path: zipPath, format: 'zip', mailboxId: dst.id, mode: 'original', folderId: null, rootName: ROOT }, cfg);
  assert.equal(counts.imported, 2);
  assert.equal(counts.otherEntries, 2);
  const restored = messagesOf(dst.id);
  assert.equal(folderName(restored.find((m) => m['subject'] === 'Projekt 2026')!['folderId']), 'Projekte.2026');
  assert.ok(restored.every((m) => (m['flags'] as string[]).join() === '\\Seen'));
});

test('mode folder: the folder must belong to the target mailbox', async () => {
  const dst = addMailbox('gina', [{ name: 'INBOX' }]);
  const other = addMailbox('hank', [{ name: 'INBOX' }]);
  const zipPath = join(dir, 'alice.zip');
  await assert.rejects(
    restorePrepared({ path: zipPath, format: 'zip', mailboxId: dst.id, mode: 'folder', folderId: other.folders['INBOX']!, rootName: ROOT }, cfg),
    /Target folder not found/,
  );
  const counts = await restorePrepared({ path: zipPath, format: 'zip', mailboxId: dst.id, mode: 'folder', folderId: dst.folders['INBOX']!, rootName: ROOT }, cfg);
  assert.equal(counts.imported, 4);
  assert.ok(messagesOf(dst.id).every((m) => m['folderId'] === dst.folders['INBOX']));
});

test('restore job: download phase + counts in progressMeta, COMPLETED, temp dir removed; size cap → FAILED', async () => {
  const zip = readFileSync(join(dir, 'alice.zip'));
  const dst = addMailbox('ivan', [{ name: 'INBOX' }]);
  const jobDir = mkdtempSync(join(tmpdir(), 'cm-restore-job-'));
  jobs.push({ id: 'rj1', status: 'RUNNING' });
  const prepared = {
    path: join(jobDir, 'archive.zip'), dir: jobDir, format: 'zip' as const, sizeBytes: 0, targetUserId: 'ivan',
    mailboxId: dst.id, mode: 'subfolder' as const, folderId: null, rootName: ROOT, source: { kind: 'archive', key: 'mailbox/alice/1.zip.enc' },
  };
  const counts = await executeRestoreJob('rj1', prepared, restoreConfig({}), () => writeCapped(Readable.from([zip]), prepared.path, 1024 * 1024));
  assert.equal(counts?.imported, 4);
  const job = jobs.find((j) => j['id'] === 'rj1')!;
  assert.equal(job['status'], 'COMPLETED');
  assert.equal(job['messageCount'], 4);
  assert.equal(job['sizeBytes'], BigInt(zip.length));
  const meta = job['progressMeta'] as Record<string, unknown>;
  assert.equal(meta['phase'], 'done');
  assert.equal(meta['imported'], 4);
  assert.equal(meta['targetFolder'], ROOT);
  assert.equal(existsSync(jobDir), false, 'temp dir removed');

  const dir2 = mkdtempSync(join(tmpdir(), 'cm-restore-job-'));
  jobs.push({ id: 'rj2', status: 'RUNNING' });
  const p2 = { ...prepared, dir: dir2, path: join(dir2, 'archive.zip') };
  assert.equal(await executeRestoreJob('rj2', p2, restoreConfig({}), () => writeCapped(Readable.from([zip]), p2.path, 100)), null);
  const j2 = jobs.find((j) => j['id'] === 'rj2')!;
  assert.equal(j2['status'], 'FAILED');
  assert.match(String(j2['errorMsg']), /zu groß/);
  assert.equal(existsSync(dir2), false);
  assert.ok(new RestoreTooLargeError(1) instanceof Error);
});

test('wrong / missing key: decryption fails before anything is restored, with a clear German message', async () => {
  const other = loadKeyring({ BACKUP_ENCRYPTION_KEY: 'd'.repeat(64) });
  const encPath = join(dir, 'foreign.zip.enc');
  await encryptFile(join(dir, 'alice.zip'), encPath, other.current);
  const err = await prepareUploadedFile(encPath, dir, () => keyring).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof BackupDecryptError);
  assert.match(decryptErrorMessage(err), /anderen Schlüssel verschlüsselt \(Schlüssel-ID [0-9a-f]{16}\)/);
  assert.match(decryptErrorMessage(Object.assign(new Error('No backup encryption key'), { name: 'BackupKeyConfigError' })), /BACKUP_ENCRYPTION_KEY setzen/);
  assert.match(decryptErrorMessage(new BackupDecryptError('backup is corrupted, truncated or was modified')), /beschädigt/);

  // a damaged ZIP fails the job with a readable message, nothing is restored
  const dst = addMailbox('judy', [{ name: 'INBOX' }]);
  const jobDir = mkdtempSync(join(tmpdir(), 'cm-restore-job-'));
  writeFileSync(join(jobDir, 'archive.zip'), Buffer.from('PK\u0003\u0004 truncated'));
  jobs.push({ id: 'rj3', status: 'RUNNING' });
  const res = await executeRestoreJob('rj3', {
    path: join(jobDir, 'archive.zip'), dir: jobDir, format: 'zip', sizeBytes: 0, targetUserId: 'judy',
    mailboxId: dst.id, mode: 'original', folderId: null, rootName: ROOT, source: { kind: 'upload' },
  }, restoreConfig({}));
  assert.equal(res, null);
  const j = jobs.find((x) => x['id'] === 'rj3')!;
  assert.equal(j['status'], 'FAILED');
  assert.match(String(j['errorMsg']), /beschädigt oder kein gültiges ZIP/);
  assert.equal(messagesOf(dst.id).length, 0);
});
