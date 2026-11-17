/**
 * BCP → Backup & Restore (9.3): pure helpers for restoring stored archives and
 * for the backup automation overview. No imports — unit-tested with `node --test`.
 *
 * Archive keys in the backup store (see backup-service restore/source.ts):
 *   mailbox/<userId>/<epochMs>.zip|mbox[.enc]       single-mailbox backup
 *   full-backup/<day>/<runId>/<email*>.zip[.enc]     one user's part of a full backup
 *   full-backup/<day>/<email*>.zip[.enc]             the same before 9.2
 *   system/<day>/<jobId>/…                           database dump (not restorable here)
 */

export interface ArchiveObjectLite { key: string; size: number; lastModified: string }
export interface JobLite {
  id: string;
  userId: string | null;
  scope: string;
  format: string;
  status: string;
  downloadUrl: string | null;
  createdAt: string;
  sizeBytes?: string | number | null;
  progressMeta?: unknown;
}
export interface UserLite { id: string; email: string; displayName?: string | null }
export interface ScheduleLite {
  scope: string;
  enabled: boolean;
  cron: string;
  retentionDays: number;
  targetUserId?: string | null;
}

export type ArchiveKind = 'mailbox' | 'full' | 'system' | 'other';

export interface KeyInfo {
  format: 'zip' | 'mbox' | null;
  encrypted: boolean;
  kind: ArchiveKind;
  ownerUserId: string | null;
  ownerEmailGuess: string | null;
  date: string | null;
}

/** Same rules as the backup-service (restore/source.ts archiveKeyInfo). */
export function archiveKeyInfo(key: string): KeyInfo {
  const encrypted = key.endsWith('.enc');
  const plain = encrypted ? key.slice(0, -4) : key;
  const parts = plain.split('/');
  const file = parts[parts.length - 1] ?? '';
  const ext = /\.(zip|mbox)$/i.exec(file)?.[1]?.toLowerCase();
  const kind: ArchiveKind = parts[0] === 'mailbox' ? 'mailbox'
    : parts[0] === 'full-backup' ? 'full'
      : parts[0] === 'system' ? 'system' : 'other';
  const format = kind === 'system' ? null : ext === 'zip' || ext === 'mbox' ? ext : null;
  let ownerUserId: string | null = null;
  let ownerEmailGuess: string | null = null;
  let date: string | null = null;
  if (kind === 'mailbox' && parts.length === 3) {
    ownerUserId = parts[1] || null;
    const ms = /^(\d{10,16})\./.exec(file)?.[1];
    if (ms) date = new Date(Number(ms)).toISOString();
  } else if (kind === 'full' && (parts.length === 3 || parts.length === 4)) {
    const base = file.replace(/\.(zip|mbox)$/i, '');
    ownerEmailGuess = base.includes('_at_') ? base.replace('_at_', '@') : null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(parts[1] ?? '')) date = `${parts[1]}T00:00:00.000Z`;
  }
  return { format, encrypted, kind, ownerUserId, ownerEmailGuess, date };
}

export interface RestoreSource {
  key: string;
  jobId: string | null;
  kind: Exclude<ArchiveKind, 'system'>;
  format: 'zip' | 'mbox';
  encrypted: boolean;
  ownerUserId: string | null;
  ownerEmail: string | null;
  /** Backup time (ISO). */
  date: string;
  size: number | null;
}

/**
 * Restorable mailbox archives: the objects of the backup store plus the stored
 * archives of completed jobs (union by key), newest first. System dumps and
 * other files are left out. The owner comes from the job, the key or the
 * address in a full-backup key.
 */
export function restoreSources(objects: readonly ArchiveObjectLite[], jobs: readonly JobLite[], users: readonly UserLite[]): RestoreSource[] {
  const byKey = new Map<string, RestoreSource>();
  const jobByKey = new Map<string, JobLite>();
  for (const j of jobs) if (j.status === 'COMPLETED' && j.downloadUrl && !jobByKey.has(j.downloadUrl)) jobByKey.set(j.downloadUrl, j);
  const emailOf = (id: string | null): string | null => (id ? users.find((u) => u.id === id)?.email ?? null : null);
  const idOfEmail = (email: string | null): string | null =>
    (email ? users.find((u) => u.email.toLowerCase() === email.toLowerCase())?.id ?? null : null);

  const add = (key: string, size: number | null, fallbackDate: string | null): void => {
    if (byKey.has(key)) return;
    const info = archiveKeyInfo(key);
    if (!info.format || info.kind === 'system') return;
    const job = jobByKey.get(key) ?? null;
    const ownerUserId = job?.userId ?? info.ownerUserId ?? idOfEmail(info.ownerEmailGuess);
    const jobSize = job?.sizeBytes === null || job?.sizeBytes === undefined ? null : Number(job.sizeBytes);
    byKey.set(key, {
      key,
      jobId: job?.id ?? null,
      kind: info.kind as Exclude<ArchiveKind, 'system'>,
      format: info.format,
      encrypted: info.encrypted,
      ownerUserId,
      ownerEmail: emailOf(ownerUserId) ?? info.ownerEmailGuess,
      date: job?.createdAt ?? info.date ?? fallbackDate ?? new Date(0).toISOString(),
      size: size ?? (Number.isFinite(jobSize) ? jobSize : null),
    });
  };
  for (const o of objects) add(o.key, o.size, o.lastModified);
  for (const [key, j] of jobByKey) add(key, null, j.createdAt);
  return [...byKey.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** One line for the archive picker. */
export function sourceLabel(s: RestoreSource, fmtDate: (iso: string) => string): string {
  const what = s.kind === 'full' ? 'Vollbackup' : s.kind === 'mailbox' ? 'Postfach-Backup' : 'Archiv';
  const fmt = `${s.format.toUpperCase()}${s.encrypted ? ', verschlüsselt' : ''}`;
  return `${s.ownerEmail ?? 'unbekanntes Postfach'} — ${what} (${fmt}) — ${fmtDate(s.date)}`;
}

/** "Wiederhergestellt YYYY-MM-DD" for a backup date (same rule as the backup-service). */
export function restoreFolderPreview(iso: string): string {
  const d = new Date(iso);
  return `Wiederhergestellt ${(Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10)}`;
}

export type RestoreMode = 'subfolder' | 'original' | 'folder';

export interface RestoreForm {
  source: RestoreSource | null;
  /** '' = the archive's owner. */
  targetUserId: string;
  mode: RestoreMode;
  folderId: string;
}

/** Validation of the restore form; the error text is shown in the BCP. */
export function restoreFormError(f: RestoreForm): string | null {
  if (!f.source) return 'Bitte ein Backup-Archiv wählen';
  if (!f.targetUserId && !f.source.ownerUserId) return 'Das ursprüngliche Postfach ist unbekannt — bitte ein Zielpostfach wählen';
  if (f.mode === 'folder' && !f.folderId) return 'Bitte einen Zielordner wählen';
  return null;
}

/** Body of POST /admin/backups/restore. */
export function restoreRequestBody(f: RestoreForm): Record<string, string> {
  const body: Record<string, string> = {};
  if (f.source?.jobId) body['jobId'] = f.source.jobId;
  else if (f.source) body['key'] = f.source.key;
  if (f.targetUserId) body['targetUserId'] = f.targetUserId;
  body['mode'] = f.mode;
  if (f.mode === 'folder' && f.folderId) body['folderId'] = f.folderId;
  return body;
}

/** Query of the upload restore (POST /admin/backups/import/:userId?…). */
export function uploadQuery(mode: RestoreMode, folderId: string): string {
  return mode === 'folder' ? `mode=folder&folderId=${encodeURIComponent(folderId)}` : `mode=${mode}`;
}

/** Result line of a restore job (progressMeta counts), or null for other jobs. */
export function restoreSummary(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  const n = (k: string): number => (typeof m[k] === 'number' ? m[k] as number : 0);
  if (typeof m['imported'] !== 'number' && typeof m['duplicates'] !== 'number') return null;
  const parts = [`${n('imported')} wiederhergestellt`];
  if (n('duplicates')) parts.push(`${n('duplicates')} bereits vorhanden`);
  if (n('failed')) parts.push(`${n('failed')} fehlgeschlagen`);
  if (n('otherEntries')) parts.push(`${n('otherEntries')} Kontakt-/Kalenderdateien nicht übernommen`);
  const folder = typeof m['targetFolder'] === 'string' && m['targetFolder'] ? ` → „${m['targetFolder']}“` : '';
  return parts.join(' · ') + folder;
}

/** Scope column of the jobs list. */
export function jobScopeLabel(scope: string): string {
  switch (scope) {
    case 'full': return 'Alle Postfächer';
    case 'user': return 'Postfach';
    case 'system': return 'System (Datenbank)';
    case 'restore': return 'Wiederherstellung';
    default: return scope;
  }
}

/** Mailbox archives of completed jobs can be restored (system dumps / restores cannot). */
export function canRestoreJob(j: Pick<JobLite, 'status' | 'downloadUrl' | 'scope'>): boolean {
  return j.status === 'COMPLETED' && !!j.downloadUrl && j.scope === 'user' && archiveKeyInfo(j.downloadUrl).format !== null;
}

/** System dumps: download for ORGANIZATION_MANAGEMENT only (role unknown → let the server decide). */
export function canDownloadJob(role: string | null, j: Pick<JobLite, 'scope' | 'downloadUrl'>): boolean {
  const system = j.scope === 'system' || (j.downloadUrl ?? '').startsWith('system/');
  return !system || role === null || role === 'ORGANIZATION_MANAGEMENT';
}

/** lastStatus of a schedule. */
export function scheduleStatusLabel(status: string | null): { label: string; tone: 'ok' | 'warn' | 'error' | 'muted' } {
  switch (status) {
    case 'COMPLETED': return { label: 'Erfolgreich', tone: 'ok' };
    case 'PARTIAL': return { label: 'Teilweise fehlgeschlagen', tone: 'warn' };
    case 'FAILED': return { label: 'Fehlgeschlagen', tone: 'error' };
    case 'RUNNING': return { label: 'Läuft', tone: 'muted' };
    case 'INVALID_CRON': return { label: 'Ungültige Cron-Angabe', tone: 'error' };
    case 'INVALID': return { label: 'Ungültiger Zeitplan', tone: 'error' };
    case null: case '': return { label: 'Noch nicht gelaufen', tone: 'muted' };
    default: return { label: status, tone: 'muted' };
  }
}

const WEEKDAYS = ['sonntags', 'montags', 'dienstags', 'mittwochs', 'donnerstags', 'freitags', 'samstags'];

/** Short German description of a 5-field cron expression (UTC), or the expression itself. */
export function describeCron(cron: string): string {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [m, h, dom, mon, dow] = p as [string, string, string, string, string];
  const num = (s: string): number | null => (/^\d+$/.test(s) ? Number(s) : null);
  const mm = num(m);
  const hh = num(h);
  const at = mm !== null && hh !== null ? `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} UTC` : null;
  if (mon !== '*') return cron;
  if (at && dom === '*' && dow === '*') return `täglich ${at}`;
  if (at && dom === '*' && num(dow) !== null && num(dow)! <= 7) return `${WEEKDAYS[num(dow)! % 7]} ${at}`;
  if (at && num(dom) !== null && dow === '*') return `monatlich am ${num(dom)}. ${at}`;
  if (mm !== null && h === '*' && dom === '*' && dow === '*') return `stündlich zur Minute ${mm}`;
  return cron;
}

/** True when no enabled schedule backs up all mailboxes or the system (database). */
export function needsRecommendedSetup(schedules: readonly ScheduleLite[]): boolean {
  const has = (scope: string): boolean => schedules.some((s) => s.enabled && s.scope === scope);
  return !has('full') || !has('system');
}

export type CoverageState = 'covered' | 'partial' | 'missing' | 'manual';

export interface CoverageItem {
  what: string;
  state: CoverageState;
  detail: string;
}

/**
 * What the configured automation covers — and what it does NOT (shown in the
 * BCP so nobody mistakes the mailbox backups for a complete server backup).
 */
export function backupCoverage(schedules: readonly ScheduleLite[]): CoverageItem[] {
  const enabled = schedules.filter((s) => s.enabled);
  const first = (scope: string): ScheduleLite | undefined => enabled.find((s) => s.scope === scope);
  const when = (s: ScheduleLite): string => `${describeCron(s.cron)}, ${s.retentionDays} Tage aufbewahrt`;
  const full = first('full');
  const system = first('system');
  const single = enabled.filter((s) => s.scope === 'user').length;
  return [
    full
      ? { what: 'Postfächer (E-Mails mit Anhängen, Ordnern und Markierungen)', state: 'covered', detail: `Vollbackup ${when(full)}` }
      : single
        ? { what: 'Postfächer (E-Mails mit Anhängen, Ordnern und Markierungen)', state: 'partial', detail: `nur ${single} einzelne(s) Postfach/Postfächer per Zeitplan` }
        : { what: 'Postfächer (E-Mails mit Anhängen, Ordnern und Markierungen)', state: 'missing', detail: 'kein Zeitplan — nur manuelle Sicherungen' },
    {
      what: 'Kontakte und Kalender',
      state: full ? 'partial' : 'missing',
      detail: full
        ? 'als .vcf/.ics im ZIP-Vollbackup enthalten; Wiederherstellung per Import im Client'
        : 'nur in ZIP-Postfach-Sicherungen enthalten',
    },
    system
      ? { what: 'Datenbank (Benutzer, Einstellungen, Zertifikate, DKIM-Schlüssel, Regeln)', state: 'covered', detail: `System-Sicherung ${when(system)}` }
      : { what: 'Datenbank (Benutzer, Einstellungen, Zertifikate, DKIM-Schlüssel, Regeln)', state: 'missing', detail: 'kein Zeitplan mit „System (Datenbank)“' },
    {
      what: 'Objektspeicher als Ganzes (für eine komplette Server-Wiederherstellung)',
      state: 'manual',
      detail: 'Volume coremail-data bzw. S3-Bucket separat sichern; die System-Sicherung enthält nur eine Liste aller Objekte',
    },
    {
      what: 'Schlüssel und Zugangsdaten (.env: BACKUP_ENCRYPTION_KEY, JWT_SECRET, PEPPER …)',
      state: 'manual',
      detail: 'nie in den Backups — getrennt vom Server aufbewahren; ohne BACKUP_ENCRYPTION_KEY sind Backups nicht lesbar',
    },
    {
      what: 'Kopie außerhalb des Servers',
      state: 'manual',
      detail: 'Backups liegen im Bucket coremail-backups — beim mitgelieferten MinIO auf demselben Server; extern kopieren oder ein externes S3-Ziel verwenden',
    },
  ];
}
