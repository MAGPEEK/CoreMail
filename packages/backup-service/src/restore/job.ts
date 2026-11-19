/**
 * Restore jobs (9.3): restore a stored backup archive (BCP "Backup-Archiv" /
 * completed jobs) or an uploaded file into a mailbox, as a BackupJob
 * (scope "restore", triggeredBy "RESTORE") with progress and result counts.
 *
 * Flow: archive → (decrypt, size-capped) temp file → ZIP/MBOX reader → restore
 * engine (message store, raw originals, dedupe) → job COMPLETED/FAILED. One
 * restore per target mailbox at a time (Redis lock, held until the job ends).
 * Errors that can be known up front (missing/wrong key, unknown format, no
 * target) are answered before a job is created.
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MAGIC } from '../crypto/backup-crypto.js';
import { looksLikeZip, openZip } from './zip-reader.js';
import { MANIFEST_NAME } from '../export/manifest.js';
import { looksLikeMbox } from './mbox-reader.js';
import {
  DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_RESTORE_FOLDERS, MAX_MANIFEST_BYTES, RestoreAbortedError, emptyCounts, mboxItems, restoreItems, zipItems,
  type RestoreCounts, type RestorePlan,
} from './engine.js';
import { restoreAddressBook } from './address-book.js';
import { archiveKeyInfo, restoreFolderName, type ArchiveFormat, type RestoreMode } from './source.js';
import { JobHeartbeat } from '../scheduler/job-progress.js';

const log = createLogger('backup:restore-job');

/** An error with an HTTP status for the route (message is shown in the BCP). */
export class RestoreHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'RestoreHttpError'; }
}

export class RestoreTooLargeError extends Error {
  constructor(readonly max: number) { super(`Archiv zu groß (max. ${max} Bytes, BACKUP_RESTORE_MAX_BYTES)`); this.name = 'RestoreTooLargeError'; }
}

function envBytes(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

export interface RestoreConfig {
  /** Max. plaintext archive size (BACKUP_RESTORE_MAX_BYTES, default 20 GiB). */
  maxArchiveBytes: number;
  /** Max. size of one message (BACKUP_RESTORE_MAX_MESSAGE_BYTES, default 150 MiB). */
  maxMessageBytes: number;
  /** Max. upload size (BACKUP_IMPORT_MAX_BYTES, default 500 MiB — same as the api-gateway cap). */
  maxUploadBytes: number;
  /** Max. folders one restore creates (BACKUP_RESTORE_MAX_FOLDERS, default 1000). */
  maxFolders: number;
}

export function restoreConfig(env: Record<string, string | undefined> = process.env): RestoreConfig {
  return {
    maxArchiveBytes: envBytes(env, 'BACKUP_RESTORE_MAX_BYTES', 20 * 1024 ** 3),
    maxMessageBytes: envBytes(env, 'BACKUP_RESTORE_MAX_MESSAGE_BYTES', DEFAULT_MAX_MESSAGE_BYTES),
    maxUploadBytes: envBytes(env, 'BACKUP_IMPORT_MAX_BYTES', 500 * 1024 * 1024),
    maxFolders: envBytes(env, 'BACKUP_RESTORE_MAX_FOLDERS', DEFAULT_MAX_RESTORE_FOLDERS),
  };
}

/** Writes `source` to `path` (0600), failing with RestoreTooLargeError above `maxBytes`. Returns the size. */
export async function writeCapped(source: Readable, path: string, maxBytes: number): Promise<number> {
  let n = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > maxBytes) { cb(new RestoreTooLargeError(maxBytes)); return; }
      cb(null, chunk);
    },
  });
  await pipeline(source, counter, createWriteStream(path, { mode: 0o600 }));
  return n;
}

/**
 * Upload variant of {@link writeCapped}: above `maxBytes` the rest of the
 * request body is read and discarded (not destroyed), so the route can still
 * answer 413 instead of resetting the connection.
 */
export function writeUploadCapped(req: Readable, path: string, maxBytes: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const ws = createWriteStream(path, { mode: 0o600 });
    let n = 0;
    let over = false;
    let failed = false;
    const fail = (err: Error): void => {
      if (failed) return;
      failed = true;
      ws.destroy();
      req.resume();
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      n += chunk.length;
      if (over || failed) return;
      if (n > maxBytes) { over = true; ws.destroy(); return; }
      if (!ws.write(chunk)) {
        req.pause();
        ws.once('drain', () => req.resume());
      }
    });
    req.once('end', () => {
      if (failed) return;
      if (over) { failed = true; reject(new RestoreTooLargeError(maxBytes)); return; }
      ws.end();
      ws.once('close', () => resolve(n));
    });
    req.once('error', (err) => fail(err));
    ws.once('error', (err) => { if (!over) fail(err); });
  });
}

export type DetectedFormat = ArchiveFormat | 'encrypted' | null;

/** Format of a file by its first bytes: CoreMail-encrypted, ZIP, MBOX or unknown. */
export async function detectFormat(path: string): Promise<DetectedFormat> {
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(8);
    const { bytesRead } = await fh.read(head, 0, 8, 0);
    const h = head.subarray(0, bytesRead);
    if (h.length >= 4 && h.subarray(0, 4).equals(MAGIC)) return 'encrypted';
    if (looksLikeZip(h)) return 'zip';
    if (looksLikeMbox(h)) return 'mbox';
    return null;
  } finally {
    await fh.close();
  }
}

export interface PreparedRestore {
  /** Plaintext archive on disk (inside `dir`). */
  path: string;
  dir: string;
  format: ArchiveFormat;
  sizeBytes: number;
  targetUserId: string;
  mailboxId: string;
  mode: RestoreMode;
  folderId: string | null;
  rootName: string;
  source: Record<string, unknown>;
  /**
   * 9.3 review: archive restore — the archive is only on disk after the
   * download, so the restore folder date is resolved then (restoreRootDate:
   * manifest first, else this date = the backup job's creation time).
   */
  rootDateFallback?: Date | null;
}

/** Target user + mailbox of a restore (404 when either is missing). */
export async function resolveTarget(userId: string): Promise<{ userId: string; mailboxId: string; email: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) throw new RestoreHttpError(404, 'Zielbenutzer nicht gefunden');
  const mailbox = await prisma.mailbox.findFirst({ where: { userId }, select: { id: true } });
  if (!mailbox) throw new RestoreHttpError(404, 'Zielbenutzer hat kein Postfach');
  return { userId: user.id, mailboxId: mailbox.id, email: user.email };
}

export interface ArchiveRef {
  key: string;
  ownerUserId: string | null;
  date: Date;
  format: ArchiveFormat;
  jobId: string | null;
}

/**
 * Resolves the archive of a restore request: by job (its stored archive) or by
 * object key; the owner comes from the job, the key (mailbox/<userId>/…) or the
 * address in a full-backup key.
 */
export async function resolveArchive(req: { jobId: string | null; key: string | null }, isSafeKey: (k: string) => boolean): Promise<ArchiveRef> {
  let key: string;
  let ownerUserId: string | null = null;
  let date: Date | null = null;
  let jobId: string | null = null;
  if (req.jobId) {
    const job = await prisma.backupJob.findUnique({ where: { id: req.jobId } });
    if (!job) throw new RestoreHttpError(404, 'Backup-Job nicht gefunden');
    if (job.status !== 'COMPLETED' || !job.downloadUrl) throw new RestoreHttpError(409, 'Dieser Job hat kein gespeichertes Backup-Archiv');
    key = job.downloadUrl;
    ownerUserId = job.userId;
    date = job.createdAt;
    jobId = job.id;
  } else {
    key = req.key ?? '';
    if (!isSafeKey(key)) throw new RestoreHttpError(400, 'Ungültiger Archiv-Schlüssel');
    const job = await prisma.backupJob.findFirst({ where: { downloadUrl: key }, orderBy: { createdAt: 'desc' } });
    if (job) { ownerUserId = job.userId; date = job.createdAt; jobId = job.id; }
  }
  const info = archiveKeyInfo(key);
  if (!info.format) throw new RestoreHttpError(400, 'Kein wiederherstellbares Postfach-Backup (nur ZIP- oder MBOX-Archive von Postfächern)');
  if (!ownerUserId && info.ownerUserId) ownerUserId = info.ownerUserId;
  if (!ownerUserId && info.ownerEmailGuess) {
    const u = await prisma.user.findFirst({ where: { email: { equals: info.ownerEmailGuess, mode: 'insensitive' } }, select: { id: true } });
    ownerUserId = u?.id ?? null;
  }
  return { key, ownerUserId, date: date ?? info.date ?? new Date(), format: info.format, jobId };
}

/** Plan for the engine (mode "folder" needs a folder of the target mailbox). */
export function planFor(p: Pick<PreparedRestore, 'mailboxId' | 'mode' | 'folderId' | 'rootName'>): RestorePlan {
  return { mailboxId: p.mailboxId, mode: p.mode, folderId: p.folderId, rootName: p.rootName };
}

/** Restores a prepared archive (no job bookkeeping). */
export async function restorePrepared(
  p: Pick<PreparedRestore, 'path' | 'format' | 'mailboxId' | 'mode' | 'folderId' | 'rootName'>,
  cfg: Pick<RestoreConfig, 'maxMessageBytes'> & Partial<Pick<RestoreConfig, 'maxFolders'>>,
  onProgress?: (c: RestoreCounts) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<RestoreCounts> {
  const counts = emptyCounts();
  const limits = { maxMessageBytes: cfg.maxMessageBytes };
  const items = p.format === 'zip' ? zipItems(p.path, limits, counts) : mboxItems(p.path, limits);
  await restoreItems(items, { ...planFor(p), ...(cfg.maxFolders ? { maxFolders: cfg.maxFolders } : {}) }, counts, onProgress, signal);
  if (p.format === 'zip') {
    // 9.5: contacts, then contact groups, into the address book of the mailbox owner
    // (a shared mailbox has no address book).
    const owner = await prisma.mailbox.findUnique({ where: { id: p.mailboxId }, select: { userId: true } });
    if (owner?.userId) await restoreAddressBook(p.path, owner.userId, counts, () => signal?.aborted === true);
    if (signal?.aborted) throw new RestoreAbortedError();
  }
  return counts;
}

/**
 * Date of the restore folder ("Wiederhergestellt YYYY-MM-DD") — the SAME
 * source for an archive restore and an upload (9.3 review; they used to differ,
 * so restoring one backup both ways created two folders): the creation time in
 * the ZIP manifest, else `fallback` (the backup job's creation time), else now.
 */
export async function restoreRootDate(path: string, format: ArchiveFormat, fallback: Date | null): Promise<Date> {
  const fromManifest = format === 'zip' ? await zipBackupDate(path) : null;
  return fromManifest ?? fallback ?? new Date();
}

/** Final job status from the counts: nothing restored although messages failed → FAILED. */
export function restoreOutcome(c: RestoreCounts): { status: 'COMPLETED' | 'FAILED'; errorMsg: string | null } {
  if (c.failed > 0 && c.imported === 0 && c.duplicates === 0) {
    return { status: 'FAILED', errorMsg: `Keine Nachricht wiederhergestellt (${c.failed} fehlgeschlagen)` };
  }
  const notes: string[] = [];
  if (c.failed > 0) notes.push(`${c.failed} von ${c.total} Nachrichten konnten nicht wiederhergestellt werden`);
  if (c.addressBookFailed > 0) notes.push(`${c.addressBookFailed} Kontakte/Kontaktlisten konnten nicht wiederhergestellt werden`);
  return { status: 'COMPLETED', errorMsg: notes.length ? notes.join('; ') : null };
}

/** Creates the job row (RUNNING) for a prepared restore. */
export async function createRestoreJob(p: PreparedRestore, actorId: string): Promise<string> {
  const job = await prisma.backupJob.create({
    data: {
      userId: p.targetUserId,
      scope: 'restore',
      format: p.format,
      status: 'RUNNING',
      triggeredBy: 'RESTORE',
      startedAt: new Date(),
      sizeBytes: BigInt(p.sizeBytes),
      progressMeta: { phase: 'restore', mode: p.mode, targetFolder: p.mode === 'folder' ? null : p.rootName, source: p.source, actorId } as never,
    },
  });
  return job.id;
}

/**
 * Runs a prepared restore as job `jobId`; never rejects; removes the temp dir.
 * `materialize` (archive restore) first writes the archive to `p.path` and
 * returns its size — under the job's heartbeat, so a long download is never
 * mistaken for a stuck job.
 */
export async function executeRestoreJob(
  jobId: string,
  p: PreparedRestore,
  cfg: RestoreConfig,
  materialize?: () => Promise<number>,
  /** Aborted when the per-mailbox restore lock is lost (job → FAILED, nothing more written). */
  signal?: AbortSignal,
): Promise<RestoreCounts | null> {
  const startedAt = Date.now();
  const hb = new JobHeartbeat(async (meta) => {
    await prisma.backupJob.update({ where: { id: jobId }, data: { progressMeta: meta as never } });
  }, { phase: materialize ? 'download' : 'restore', mode: p.mode, targetFolder: p.mode === 'folder' ? null : p.rootName, source: p.source }).start();
  try {
    if (materialize) {
      p.sizeBytes = await materialize();
      await prisma.backupJob.update({ where: { id: jobId }, data: { sizeBytes: BigInt(p.sizeBytes) } }).catch(() => undefined);
      await hb.update({ phase: 'restore' });
    }
    if (p.rootDateFallback !== undefined && p.mode !== 'folder') {
      p.rootName = rootNameFor(await restoreRootDate(p.path, p.format, p.rootDateFallback));
      await hb.update({ targetFolder: p.rootName });
    }
    const counts = await restorePrepared(p, cfg, (c) => hb.update({ ...c }), signal);
    const outcome = restoreOutcome(counts);
    const meta = hb.stop();
    await prisma.backupJob.update({
      where: { id: jobId },
      data: {
        status: outcome.status,
        progress: 100,
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
        messageCount: counts.imported,
        errorMsg: outcome.errorMsg,
        ...(outcome.status === 'FAILED' ? { errorClass: 'CORRUPT' } : {}),
        progressMeta: { ...meta, phase: 'done', ...counts } as never,
      },
    });
    log.info({ jobId, targetUserId: p.targetUserId, ...counts }, 'Restore finished');
    return counts;
  } catch (err) {
    const meta = hb.stop();
    log.error({ err, jobId }, 'Restore failed');
    await prisma.backupJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
        errorMsg: restoreErrorMessage(err),
        errorClass: 'CORRUPT',
        progressMeta: { ...meta, phase: 'failed' } as never,
      },
    }).catch(() => undefined);
    return null;
  } finally {
    await rm(p.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * BCP message for a decryption problem (missing key, key of another
 * installation, damaged file) — never the key itself.
 */
export function decryptErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (name === 'BackupKeyConfigError') {
    return `Kein gültiger Backup-Schlüssel konfiguriert — BACKUP_ENCRYPTION_KEY setzen (${msg})`;
  }
  const keyId = /key id ([0-9a-f]{16})/.exec(msg)?.[1];
  if (keyId) {
    return `Das Backup wurde mit einem anderen Schlüssel verschlüsselt (Schlüssel-ID ${keyId}). `
      + 'BACKUP_ENCRYPTION_KEY muss der Schlüssel sein, der beim Erstellen des Backups aktiv war.';
  }
  if (/bad magic|not an encrypted/i.test(msg)) return 'Die Datei ist kein verschlüsseltes CoreMail-Backup';
  if (/unsupported backup encryption format/i.test(msg)) return 'Unbekanntes Verschlüsselungsformat des Backups';
  return 'Das verschlüsselte Backup ist beschädigt, unvollständig oder wurde verändert';
}

/** Job error text (BCP) for a failed restore. */
export function restoreErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (name === 'BackupDecryptError' || name === 'BackupKeyConfigError') return decryptErrorMessage(err);
  if (name === 'ZipFormatError') return `Archiv ist beschädigt oder kein gültiges ZIP-Backup (${msg})`;
  if (name === 'RestoreTooLargeError') return msg;
  if (/ENOSPC/.test(msg)) return 'Zu wenig freier Speicher im temporären Verzeichnis des Containers';
  if (/NoSuchKey|not found/i.test(msg) && /key|object/i.test(msg)) return 'Archiv nicht im Backup-Speicher gefunden';
  return msg;
}

/** Creation time of a CoreMail ZIP backup (manifest), or null (no / unreadable manifest). */
export async function zipBackupDate(path: string): Promise<Date | null> {
  try {
    const zip = await openZip(path);
    try {
      const e = zip.entries.find((x) => x.name === MANIFEST_NAME);
      if (!e) return null;
      const m = JSON.parse((await zip.read(e, MAX_MANIFEST_BYTES)).toString('utf8')) as { createdAt?: unknown };
      const d = typeof m.createdAt === 'string' ? new Date(m.createdAt) : null;
      return d && !Number.isNaN(d.getTime()) ? d : null;
    } finally {
      await zip.close();
    }
  } catch {
    return null;
  }
}

/** Temp directory for one restore. */
export function restoreTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'coremail-restore-'));
}

/** Restore root name for a backup date (re-running the same restore hits the same folder → no duplicates). */
export function rootNameFor(date: Date): string {
  return restoreFolderName(date);
}

// ── Pre-9.3 upload contract (9.3 review, SemVer MINOR) ───────────────────────

/** `?folderId=` without `?mode=`: the pre-9.3 MBOX import call (synchronous contract). */
export function isLegacyImportQuery(q: Record<string, unknown>): boolean {
  const mode = q['mode'];
  return (mode === undefined || mode === '') && typeof q['folderId'] === 'string' && q['folderId'] !== '';
}

/** How long a legacy import is awaited before the 202 { jobId } fallback (BACKUP_IMPORT_SYNC_TIMEOUT_MS, default 240 s). */
export function legacyImportTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  // Below the default 300 s header timeout of the api-gateway's upstream fetch.
  return envBytes(env, 'BACKUP_IMPORT_SYNC_TIMEOUT_MS', 240_000);
}

/** Resolves `{ done: true, value }` when `p` settles within `ms`, else `{ done: false }` (p keeps running). */
export async function waitWithTimeout<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => { timer = setTimeout(() => resolve({ done: false }), ms); });
  try {
    return await Promise.race([p.then((value) => ({ done: true as const, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Response of a finished legacy import: the pre-9.3 shape `{ imported, errors,
 * encrypted }` (200) plus the additive `duplicates` / `jobId`; a job that
 * failed as a whole → 500 with its message.
 */
export function legacyImportResult(
  counts: RestoreCounts | null,
  encrypted: boolean,
  jobId: string,
  errorMsg: string | null,
): { status: number; body: Record<string, unknown> } {
  if (!counts) return { status: 500, body: { error: errorMsg ?? 'Import fehlgeschlagen', jobId } };
  return { status: 200, body: { imported: counts.imported, errors: counts.failed, duplicates: counts.duplicates, encrypted, jobId } };
}
