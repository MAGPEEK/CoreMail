/**
 * Restore sources and request validation (9.3). Pure, unit-tested.
 *
 * Stored mailbox archives (backup bucket):
 *   mailbox/<userId>/<epochMs>.zip|mbox[.enc]          single-mailbox backup
 *   full-backup/<day>/<runId>/<email*>.zip[.enc]        one user's part of a full backup (9.2+)
 *   full-backup/<day>/<email*>.zip[.enc]                the same before 9.2
 *   system/<day>/<jobId>/…                              database dump — never restored here
 * (<email*> = address with "@" → "_at_" and unsafe characters → "_").
 */

export type ArchiveFormat = 'zip' | 'mbox';
export type ArchiveKind = 'mailbox' | 'full' | 'system' | 'other';

export interface ArchiveKeyInfo {
  /** null = not a restorable mailbox archive (system dump, unknown file type). */
  format: ArchiveFormat | null;
  encrypted: boolean;
  kind: ArchiveKind;
  /** Owner from a `mailbox/<userId>/…` key. */
  ownerUserId: string | null;
  /** Owner address guessed from a full-backup key (lossy: unsafe characters became "_"). */
  ownerEmailGuess: string | null;
  /** Backup time encoded in the key (epoch-ms file name or the day folder). */
  date: Date | null;
}

export function archiveKeyInfo(key: string): ArchiveKeyInfo {
  const encrypted = key.endsWith('.enc');
  const plain = encrypted ? key.slice(0, -4) : key;
  const parts = plain.split('/');
  const file = parts[parts.length - 1] ?? '';
  const ext = /\.(zip|mbox)$/i.exec(file)?.[1]?.toLowerCase();
  const kind: ArchiveKind = parts[0] === 'mailbox' ? 'mailbox'
    : parts[0] === 'full-backup' ? 'full'
      : parts[0] === 'system' ? 'system' : 'other';
  const format: ArchiveFormat | null = kind === 'system' ? null : ext === 'zip' || ext === 'mbox' ? ext : null;
  let ownerUserId: string | null = null;
  let ownerEmailGuess: string | null = null;
  let date: Date | null = null;
  if (kind === 'mailbox' && parts.length === 3) {
    ownerUserId = parts[1] || null;
    const ms = /^(\d{10,16})\./.exec(file)?.[1];
    if (ms) date = new Date(Number(ms));
  } else if (kind === 'full' && (parts.length === 3 || parts.length === 4)) {
    const base = file.replace(/\.(zip|mbox)$/i, '');
    ownerEmailGuess = base.includes('_at_') ? base.replace('_at_', '@') : null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(parts[1] ?? '')) date = new Date(`${parts[1]}T00:00:00Z`);
  }
  if (date && Number.isNaN(date.getTime())) date = null;
  return { format, encrypted, kind, ownerUserId, ownerEmailGuess, date };
}

/** Name of the restore folder: "Wiederhergestellt YYYY-MM-DD" (date of the backup, UTC). */
export function restoreFolderName(backupDate: Date): string {
  const d = Number.isNaN(backupDate.getTime()) ? new Date() : backupDate;
  return `Wiederhergestellt ${d.toISOString().slice(0, 10)}`;
}

export type RestoreMode = 'subfolder' | 'original' | 'folder';
export const RESTORE_MODES: readonly RestoreMode[] = ['subfolder', 'original', 'folder'];

export interface RestoreRequest {
  /** Archive by job (BackupJob.downloadUrl) or by object key — exactly one. */
  jobId: string | null;
  key: string | null;
  /** null = the archive's owner. */
  targetUserId: string | null;
  mode: RestoreMode;
  /** Target folder for mode "folder". */
  folderId: string | null;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseRestoreRequest(body: unknown): { ok: true; value: RestoreRequest } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const str = (k: string): string | null | undefined => {
    const v = b[k];
    if (v === undefined || v === null || v === '') return null;
    return typeof v === 'string' ? v : undefined;
  };
  const jobId = str('jobId');
  const key = str('key');
  const targetUserId = str('targetUserId');
  const folderId = str('folderId');
  if (jobId === undefined || key === undefined || targetUserId === undefined || folderId === undefined) {
    return { ok: false, error: 'jobId, key, targetUserId and folderId must be strings' };
  }
  if ((jobId ? 1 : 0) + (key ? 1 : 0) !== 1) return { ok: false, error: 'exactly one of jobId or key is required' };
  if (jobId && !ID_RE.test(jobId)) return { ok: false, error: 'invalid jobId' };
  if (key && key.length > 1024) return { ok: false, error: 'invalid key' };
  if (targetUserId && !ID_RE.test(targetUserId)) return { ok: false, error: 'invalid targetUserId' };
  const mode = (b['mode'] ?? 'subfolder') as RestoreMode;
  if (!RESTORE_MODES.includes(mode)) return { ok: false, error: 'mode must be subfolder, original or folder' };
  if (mode === 'folder' && !folderId) return { ok: false, error: 'folderId required for mode folder' };
  if (folderId && !ID_RE.test(folderId)) return { ok: false, error: 'invalid folderId' };
  return { ok: true, value: { jobId: jobId ?? null, key: key ?? null, targetUserId: targetUserId ?? null, mode, folderId: mode === 'folder' ? folderId ?? null : null } };
}

/** Upload restore: `?mode=` / `?folderId=` (a folderId alone keeps the pre-9.3 behaviour: mode "folder"). */
export function parseUploadQuery(q: Record<string, unknown>): { ok: true; mode: RestoreMode; folderId: string | null } | { ok: false; error: string } {
  const folderId = typeof q['folderId'] === 'string' && q['folderId'] ? q['folderId'] : null;
  const rawMode = typeof q['mode'] === 'string' && q['mode'] ? q['mode'] : (folderId ? 'folder' : null);
  if (!rawMode) return { ok: false, error: 'mode (subfolder | original | folder) or folderId required' };
  if (!RESTORE_MODES.includes(rawMode as RestoreMode)) return { ok: false, error: 'mode must be subfolder, original or folder' };
  const mode = rawMode as RestoreMode;
  if (mode === 'folder' && !folderId) return { ok: false, error: 'folderId required for mode folder' };
  if (folderId && !ID_RE.test(folderId)) return { ok: false, error: 'invalid folderId' };
  return { ok: true, mode, folderId: mode === 'folder' ? folderId : null };
}

const SYSTEM_FLAGS = new Set(['\\seen', '\\answered', '\\flagged', '\\draft']);

/**
 * Flags a restored message gets: system flags (except \Recent and \Deleted — a
 * restored message must not be expunged by the next EXPUNGE) and keywords.
 * `null` (archive without flag information) → \Seen, so a restore does not
 * flood the unread count.
 */
export function sanitizeFlags(flags: readonly string[] | null): string[] {
  if (flags === null) return ['\\Seen'];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of flags) {
    if (typeof f !== 'string' || f.length > 64) continue;
    const lower = f.toLowerCase();
    if (f.startsWith('\\')) {
      if (!SYSTEM_FLAGS.has(lower)) continue;
    } else if (!/^[A-Za-z0-9$_.+-]+$/.test(f)) {
      continue;
    }
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(f.startsWith('\\') ? `\\${f.charAt(1).toUpperCase()}${f.slice(2).toLowerCase()}` : f);
    if (out.length >= 32) break;
  }
  return out;
}

/** Max. hierarchy depth / segment length of a folder taken from an archive. */
export const MAX_FOLDER_DEPTH = 32;
export const MAX_FOLDER_SEGMENT = 100;

/**
 * 9.3 review: a folder name from an archive manifest is used only when it
 * passes the same rules as a folder created in the web client (REST
 * `POST /mail/folders`: 1–100 characters per name, no "/" or "\") plus no
 * control characters, at most MAX_FOLDER_DEPTH levels, and no reserved IMAP
 * namespace prefix ("Shared/", "Other Users/"). Returns the normalized name, or
 * null when the name is refused (the message then goes to the restore folder).
 */
export function validRestoreFolder(
  name: string | null,
  isReserved: (name: string) => boolean = () => false,
): string | null {
  if (name === null) return null;
  if (name.length > MAX_FOLDER_DEPTH * (MAX_FOLDER_SEGMENT + 1)) return null;
  const segs = folderSegments(name);
  if (!segs.length || segs.length > MAX_FOLDER_DEPTH) return null;
  for (const s of segs) {
    if (s.length > MAX_FOLDER_SEGMENT || /[/\\\u0000-\u001f\u007f]/.test(s)) return null;
  }
  const joined = segs.join('.');
  return isReserved(joined) ? null : joined;
}

/** Folder name segments ("." is the hierarchy delimiter); empty segments dropped. */
export function folderSegments(name: string): string[] {
  return name.split('.').map((s) => s.trim()).filter(Boolean);
}

/**
 * Target folder name for a message from `sourceFolder` (null = the archive has
 * no folder information, e.g. MBOX).
 *  - subfolder: "<root>.<source>", or "<root>" for MBOX
 *  - original:  the source folder itself ("INBOX" for MBOX); names in a reserved
 *               namespace ("Shared/…") go below the restore root instead
 */
export function targetFolderName(
  mode: Exclude<RestoreMode, 'folder'>,
  sourceFolder: string | null,
  root: string,
  isReserved: (name: string) => boolean = () => false,
): string {
  const segs = sourceFolder ? folderSegments(sourceFolder) : [];
  if (segs.length && segs[0]!.toUpperCase() === 'INBOX') segs[0] = 'INBOX';
  const source = segs.join('.');
  if (mode === 'original') {
    if (!source) return 'INBOX';
    return isReserved(source) ? `${root}.${source}` : source;
  }
  return source ? `${root}.${source}` : root;
}
