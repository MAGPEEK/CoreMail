/**
 * Backup schedules (9.1.x BCP review): input validation for
 * POST/PUT /backup/admin/schedules, the reload signature of a registered
 * CronJob, and the expiry rule of `retentionDays`. Pure, unit-tested.
 */

export interface ScheduleData {
  name: string;
  cron: string;
  /** 9.3: 'system' = database dump + object-store manifest (system-backup.ts). */
  scope: 'full' | 'user' | 'system';
  format: 'zip' | 'mbox' | 'pgdump';
  targetUserId: string | null;
  retentionDays: number;
  enabled: boolean;
}

export type ScheduleInput = { ok: true; data: Partial<ScheduleData> } | { ok: false; error: string };

const RETENTION_MIN = 1;
const RETENTION_MAX = 3650;

/**
 * Validates a create (`partial=false`) or update body. Full backups are always
 * ZIP archives (runFullBackup ignores `format`), so `scope: 'full'` forces zip;
 * `scope: 'user'` needs a target user. `current` is the stored row for updates,
 * so the scope/target combination is checked on the merged result.
 */
export function parseScheduleInput(body: unknown, current?: ScheduleData): ScheduleInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const out: Partial<ScheduleData> = {};
  const create = current === undefined;

  if (b['name'] !== undefined || create) {
    if (typeof b['name'] !== 'string' || !b['name'].trim() || b['name'].length > 120) return { ok: false, error: 'name required (max 120 characters)' };
    out.name = b['name'].trim();
  }
  if (b['cron'] !== undefined || create) {
    if (typeof b['cron'] !== 'string' || !b['cron'].trim() || b['cron'].length > 120) return { ok: false, error: 'cron required' };
    out.cron = b['cron'].trim();
  }
  if (b['scope'] !== undefined) {
    if (b['scope'] !== 'full' && b['scope'] !== 'user' && b['scope'] !== 'system') return { ok: false, error: 'scope must be full, user or system' };
    out.scope = b['scope'];
  }
  if (b['format'] !== undefined) {
    if (b['format'] !== 'zip' && b['format'] !== 'mbox' && b['format'] !== 'pgdump') return { ok: false, error: 'format must be zip or mbox' };
    out.format = b['format'];
  }
  if (b['targetUserId'] !== undefined) {
    if (b['targetUserId'] !== null && (typeof b['targetUserId'] !== 'string' || b['targetUserId'].length > 64)) return { ok: false, error: 'invalid targetUserId' };
    out.targetUserId = (b['targetUserId'] as string | null) || null;
  }
  if (b['retentionDays'] !== undefined) {
    const n = b['retentionDays'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < RETENTION_MIN || n > RETENTION_MAX) {
      return { ok: false, error: `retentionDays must be ${RETENTION_MIN}..${RETENTION_MAX}` };
    }
    out.retentionDays = n;
  }
  if (b['enabled'] !== undefined) {
    if (typeof b['enabled'] !== 'boolean') return { ok: false, error: 'enabled must be a boolean' };
    out.enabled = b['enabled'];
  }

  const scope = out.scope ?? current?.scope ?? 'full';
  const target = out.targetUserId !== undefined ? out.targetUserId : (current?.targetUserId ?? null);
  if (scope === 'user' && !target) return { ok: false, error: 'targetUserId required for scope user' };
  if (scope === 'user' && (out.format ?? current?.format) === 'pgdump') return { ok: false, error: 'format must be zip or mbox' };
  if (scope === 'full' || scope === 'system') {
    // full backups are always ZIP, system backups always a database dump; neither has a target
    const forced = scope === 'full' ? 'zip' : 'pgdump';
    if (out.scope !== undefined || out.format !== undefined || current?.format !== forced) out.format = forced;
    if (target) out.targetUserId = null;
  }
  if (create) {
    out.scope = scope;
    out.format ??= 'zip';
    out.targetUserId ??= null;
    out.retentionDays ??= 30;
    out.enabled ??= true;
  }
  return { ok: true, data: out };
}

/** Everything a registered CronJob captured — a change re-registers it. */
export function scheduleSignature(s: Pick<ScheduleData, 'cron' | 'scope' | 'format' | 'targetUserId'>): string {
  return [s.cron, s.scope, s.format, s.targetUserId ?? ''].join('|');
}

/** Jobs of a schedule completed before this instant are expired (`retentionDays`). */
export function retentionCutoff(retentionDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - Math.max(RETENTION_MIN, retentionDays) * 86_400_000);
}

/**
 * 9.2: retention only expires backups created after it was first enforced
 * (`since`), so upgrading never deletes backups that were kept under the old,
 * never-applied setting. Returns the createdAt window to expire, or null.
 */
export function retentionWindow(since: Date, cutoff: Date): { gte: Date; lt: Date } | null {
  return since.getTime() < cutoff.getTime() ? { gte: since, lt: cutoff } : null;
}

/**
 * 9.2: ids retention must never delete — per mailbox (userId, null = schedule-level
 * job) the newest completed job that holds an archive, or the newest completed one
 * if none has an archive. `jobs` must be ordered newest first.
 */
export function newestArchivePerMailbox(jobs: ReadonlyArray<{ id: string; userId: string | null; downloadUrl: string | null }>): Set<string> {
  const withArchive = new Map<string, string>();
  const any = new Map<string, string>();
  for (const j of jobs) {
    const k = j.userId ?? '';
    if (!any.has(k)) any.set(k, j.id);
    if (j.downloadUrl && !withArchive.has(k)) withArchive.set(k, j.id);
  }
  const keep = new Set<string>(withArchive.values());
  for (const [k, id] of any) if (!withArchive.has(k)) keep.add(id);
  return keep;
}

/**
 * 9.2: object key of one user's part of a full backup. The run's master job id
 * is part of the key — `full-backup/<date>/<email>.zip` was shared by every full
 * backup of the same day, so a second run overwrote the first one's archive and
 * deleting either job's archive deleted the other's as well.
 */
export function fullBackupUserKey(date: Date, runId: string, email: string): string {
  const day = date.toISOString().slice(0, 10);
  const safeRun = runId.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeUser = email.replace('@', '_at_').replace(/[^A-Za-z0-9._+-]/g, '_');
  return `full-backup/${day}/${safeRun}/${safeUser}.zip`;
}

/**
 * 9.3: "Empfohlene Sicherung einrichten" (BCP, explicit one click — never
 * created silently). Returns the schedules to create so that the installation
 * has (1) a nightly full backup of every mailbox and (2) a nightly system
 * backup (database dump + object-store manifest). Only what is missing is
 * returned (an existing enabled schedule of the same scope counts).
 * BACKUP_SCHEDULE (cron of the full backup, compose default "0 2 * * *") and
 * BACKUP_RETENTION_DAYS (compose default 30) set the defaults — before 9.3
 * these variables were documented but never read.
 */
export function recommendedSchedules(
  existing: ReadonlyArray<Pick<ScheduleData, 'scope' | 'enabled'>>,
  env: Record<string, string | undefined> = process.env,
  isValidCron: (cron: string) => boolean = (c) => /^\S+(\s+\S+){4}$/.test(c.trim()),
): ScheduleData[] {
  const envCron = (env['BACKUP_SCHEDULE'] ?? '').trim();
  const fullCron = envCron && isValidCron(envCron) ? envCron : '0 2 * * *';
  const days = Number(env['BACKUP_RETENTION_DAYS']);
  const retentionDays = Number.isInteger(days) && days >= RETENTION_MIN && days <= RETENTION_MAX ? days : 14;
  const has = (scope: ScheduleData['scope']): boolean => existing.some((s) => s.enabled && s.scope === scope);
  const out: ScheduleData[] = [];
  if (!has('system')) {
    out.push({
      name: 'Empfohlen: Tägliche System-Sicherung (Datenbank)', cron: systemCronBefore(fullCron), scope: 'system',
      format: 'pgdump', targetUserId: null, retentionDays, enabled: true,
    });
  }
  if (!has('full')) {
    out.push({
      name: 'Empfohlen: Tägliches Vollbackup aller Postfächer', cron: fullCron, scope: 'full',
      format: 'zip', targetUserId: null, retentionDays, enabled: true,
    });
  }
  return out;
}

/** System backup 30 minutes before a simple daily "M H * * *" full backup, else 01:30 UTC. */
export function systemCronBefore(fullCron: string): string {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(fullCron.trim());
  if (!m) return '30 1 * * *';
  const total = (Number(m[2]) * 60 + Number(m[1]) - 30 + 1440) % 1440;
  return `${total % 60} ${Math.floor(total / 60)} * * *`;
}

/** Text of the failure notice to the admins (internal notification into their INBOX). */
export function failureNotice(
  schedule: { name: string; scope: string },
  outcome: { jobId: string; status: string; total: number; failed: number; errorMsg: string | null },
  hostname: string,
): { subject: string; bodyText: string } {
  const what = schedule.scope === 'full' ? 'Vollbackup aller Postfächer'
    : schedule.scope === 'system' ? 'System-Sicherung (Datenbank)' : 'Postfach-Sicherung';
  const partial = outcome.status === 'COMPLETED' && outcome.failed > 0;
  const subject = partial
    ? `Backup unvollständig: ${schedule.name}`
    : `Backup fehlgeschlagen: ${schedule.name}`;
  const lines = [
    `Die automatische Sicherung „${schedule.name}“ (${what}) auf ${hostname} ist ${partial ? 'nur teilweise gelungen' : 'fehlgeschlagen'}.`,
    '',
    ...(schedule.scope === 'full' ? [`Postfächer: ${outcome.total}, davon fehlgeschlagen: ${outcome.failed}`] : []),
    ...(outcome.errorMsg ? [`Fehler: ${outcome.errorMsg.slice(0, 500)}`] : []),
    `Job: ${outcome.jobId}`,
    '',
    'Details: BCP → Backup & Restore → Jobs. Bitte prüfen Sie den Backup-Speicher (S3/MinIO) und den Schlüssel BACKUP_ENCRYPTION_KEY.',
  ];
  return { subject, bodyText: lines.join('\n') };
}
