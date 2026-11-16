/**
 * Backup schedules (9.1.x BCP review): input validation for
 * POST/PUT /backup/admin/schedules, the reload signature of a registered
 * CronJob, and the expiry rule of `retentionDays`. Pure, unit-tested.
 */

export interface ScheduleData {
  name: string;
  cron: string;
  scope: 'full' | 'user';
  format: 'zip' | 'mbox';
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
    if (b['scope'] !== 'full' && b['scope'] !== 'user') return { ok: false, error: 'scope must be full or user' };
    out.scope = b['scope'];
  }
  if (b['format'] !== undefined) {
    if (b['format'] !== 'zip' && b['format'] !== 'mbox') return { ok: false, error: 'format must be zip or mbox' };
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
  if (scope === 'full') {
    out.format = 'zip';
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
