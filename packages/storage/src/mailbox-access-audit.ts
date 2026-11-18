/**
 * Mailbox access audit (9.4): what delegates and Shared Mailbox users do in a
 * mailbox that is not their own — from every client (webmail, IMAP, JMAP,
 * ActiveSync, SMTP submission).
 *
 * Every entry is an AuditLog row with an action under `mailbox.foreign.`:
 *
 *   mailbox.foreign.open                 mailbox opened / read (aggregated, see below)
 *   mailbox.foreign.send_as              mail sent as the mailbox
 *   mailbox.foreign.send_on_behalf       mail sent on behalf of the mailbox
 *   mailbox.foreign.folder.create|update|delete|empty
 *   mailbox.foreign.message.move|delete
 *
 * targetType `sharedMailbox` (targetId = SharedMailbox id) or `mailbox`
 * (targetId = Mailbox id of the delegating user — what the owner's own
 * "who accessed my mailbox" view queries); `changes.mailboxId` and
 * `changes.source` are always set.
 *
 * Reading is aggregated so it cannot flood the log: `open` is written at most
 * once per actor, mailbox and client type per hour (a bounded in-process claim
 * store — each client type is served by one process). Writes and sends are
 * written every time (one row per command, with counts).
 *
 * On/off: ServerSettings.auditLogEnabled AND mailboxAccessAuditEnabled.
 * Retention: ServerSettings.mailboxAccessAuditRetentionDays (0 = keep), purged
 * hourly by {@link startMailboxAccessAuditPurger} — only `mailbox.foreign.*`
 * rows; other audit entries are never purged.
 *
 * Recording never throws: an audit failure must not break mail access.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@coremail/core';
import { prisma } from './prisma/index.js';

const log = createLogger('storage:mailbox-access-audit');

export const MAILBOX_ACCESS_ACTION_PREFIX = 'mailbox.foreign.';

export type MailboxAccessSource = 'webmail' | 'imap' | 'jmap' | 'activesync' | 'smtp';

export type MailboxAccessAction =
  | 'mailbox.foreign.open'
  | 'mailbox.foreign.send_as'
  | 'mailbox.foreign.send_on_behalf'
  | 'mailbox.foreign.folder.create'
  | 'mailbox.foreign.folder.update'
  | 'mailbox.foreign.folder.delete'
  | 'mailbox.foreign.folder.empty'
  | 'mailbox.foreign.message.move'
  | 'mailbox.foreign.message.delete';

/** The foreign mailbox an event happened in. */
export interface MailboxAccessTarget {
  kind: 'shared' | 'delegated';
  /** SharedMailbox id (kind shared), otherwise null. */
  sharedMailboxId: string | null;
  mailboxId: string;
  email?: string;
}

export interface MailboxAccessEvent {
  actorId: string;
  actorEmail?: string;
  target: MailboxAccessTarget;
  action: MailboxAccessAction;
  source: MailboxAccessSource;
  changes?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/** Window in which repeated `open` events of one actor/mailbox/client are written once. */
export const OPEN_AGGREGATION_SECONDS = 3600;

/** Pure: is the action aggregated (read access) rather than written every time? */
export function isAggregatedAccess(action: MailboxAccessAction): boolean {
  return action === 'mailbox.foreign.open';
}

/** Pure: the aggregation key of an event (one row per key and window). */
export function accessAggregationKey(e: Pick<MailboxAccessEvent, 'actorId' | 'target' | 'action' | 'source'>): string {
  return `audit:mbx-access:${e.action}:${e.actorId}:${e.target.mailboxId}:${e.source}`;
}

/** Pure: the AuditLog row of an event. */
export function accessAuditRow(e: MailboxAccessEvent) {
  const shared = e.target.kind === 'shared' && e.target.sharedMailboxId;
  return {
    actorId: e.actorId,
    ...(e.actorEmail ? { actorEmail: e.actorEmail } : {}),
    action: e.action,
    targetType: shared ? 'sharedMailbox' : 'mailbox',
    targetId: shared ? (e.target.sharedMailboxId as string) : e.target.mailboxId,
    ...(e.target.email ? { targetName: e.target.email } : {}),
    ...(e.ipAddress ? { ipAddress: e.ipAddress } : {}),
    ...(e.userAgent ? { userAgent: e.userAgent } : {}),
    changes: { mailboxId: e.target.mailboxId, source: e.source, ...(e.changes ?? {}) },
    success: true,
  };
}

// ─── Dependencies (injectable for tests) ─────────────────────────────────────

export interface AccessAuditDeps {
  /** Is the mailbox access audit on? */
  enabled(): Promise<boolean>;
  /** true = first claim of `key` within `ttlSec` (the event is written). */
  claim(key: string, ttlSec: number): Promise<boolean>;
  write(row: ReturnType<typeof accessAuditRow>): Promise<unknown>;
}

const SETTINGS_TTL_MS = 60_000;
let settingsCache: { enabled: boolean; retentionDays: number; at: number } | null = null;

/** Drops the cached settings (after a settings save, tests). */
export function invalidateMailboxAccessAuditSettings(): void {
  settingsCache = null;
}

export interface MailboxAccessAuditSettings { enabled: boolean; retentionDays: number }

/** Current settings (60 s cache). A failed read keeps auditing on (fail-safe). */
export async function mailboxAccessAuditSettings(): Promise<MailboxAccessAuditSettings> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache;
  try {
    const s = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { auditLogEnabled: true, mailboxAccessAuditEnabled: true, mailboxAccessAuditRetentionDays: true },
    });
    settingsCache = {
      enabled: (s?.auditLogEnabled ?? true) && (s?.mailboxAccessAuditEnabled ?? true),
      retentionDays: s?.mailboxAccessAuditRetentionDays ?? 180,
      at: now,
    };
    return settingsCache;
  } catch (err) {
    log.warn({ err }, 'Mailbox access audit settings unavailable — auditing stays on');
    return { enabled: true, retentionDays: 0 };
  }
}

/** Bounded in-process claim store of the aggregation windows. */
const MAX_LOCAL_CLAIMS = 50_000;
const localClaims = new Map<string, number>();

/** First claim of a key per window (true = write the event). */
export function claimLocally(key: string, ttlSec: number, now = Date.now()): boolean {
  const until = localClaims.get(key);
  if (until !== undefined && until > now) return false;
  if (localClaims.size >= MAX_LOCAL_CLAIMS) {
    for (const [k, v] of localClaims) if (v <= now) localClaims.delete(k);
    if (localClaims.size >= MAX_LOCAL_CLAIMS) localClaims.clear();
  }
  localClaims.set(key, now + ttlSec * 1000);
  return true;
}

const defaultDeps: AccessAuditDeps = {
  enabled: async () => (await mailboxAccessAuditSettings()).enabled,
  // Per process: every client type is served by one process (IMAP, JMAP,
  // api-gateway for webmail), and the key contains the client type.
  claim: async (key, ttlSec) => claimLocally(key, ttlSec),
  write: (row) => prisma.auditLog.create({ data: { ...row, changes: row.changes as never } }),
};

/**
 * Records one access event. Resolves to true when a row was written, false when
 * the audit is off or the event was aggregated into an earlier row. Never throws.
 */
export async function recordMailboxAccess(event: MailboxAccessEvent, deps: AccessAuditDeps = defaultDeps): Promise<boolean> {
  try {
    if (!(await deps.enabled())) return false;
    if (isAggregatedAccess(event.action) && !(await deps.claim(accessAggregationKey(event), OPEN_AGGREGATION_SECONDS))) {
      return false;
    }
    await deps.write(accessAuditRow(event));
    return true;
  } catch (err) {
    log.error({ err, action: event.action }, 'Mailbox access audit write failed');
    return false;
  }
}

// ─── Retention ───────────────────────────────────────────────────────────────

export const MAILBOX_ACCESS_PURGE_LOCK_KEY = 'storage:mailbox-access-audit-purge:lock';
export const MAILBOX_ACCESS_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Pure: the purge cutoff, or null when entries are kept forever (days ≤ 0). */
export function accessPurgeCutoff(now: Date, retentionDays: number): Date | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

export interface AccessPurgeDb {
  auditLog: { deleteMany(args: { where: { action: { startsWith: string }; timestamp: { lt: Date } } }): Promise<{ count: number }> };
}

/** Deletes `mailbox.foreign.*` audit rows older than the retention. Returns the count. */
export async function purgeMailboxAccessAudit(
  opts: { now?: Date; retentionDays?: number; db?: AccessPurgeDb } = {},
): Promise<number> {
  const days = opts.retentionDays ?? (await mailboxAccessAuditSettings()).retentionDays;
  const cutoff = accessPurgeCutoff(opts.now ?? new Date(), days);
  if (!cutoff) return 0;
  const db = opts.db ?? (prisma as unknown as AccessPurgeDb);
  const r = await db.auditLog.deleteMany({
    where: { action: { startsWith: MAILBOX_ACCESS_ACTION_PREFIX }, timestamp: { lt: cutoff } },
  });
  if (r.count > 0) log.info({ purged: r.count, retentionDays: days }, 'Expired mailbox access audit entries purged');
  return r.count;
}

export interface AccessPurgeRedis {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
}

/** Starts the hourly purge (one process per interval via a Redis lock). */
export function startMailboxAccessAuditPurger(redis: AccessPurgeRedis, opts: { intervalMs?: number; initialDelayMs?: number } = {}): { stop(): void } {
  const interval = opts.intervalMs ?? MAILBOX_ACCESS_PURGE_INTERVAL_MS;
  const tick = async (): Promise<void> => {
    try {
      const got = await redis.set(MAILBOX_ACCESS_PURGE_LOCK_KEY, randomUUID(), 'PX', Math.max(60_000, interval - 60_000), 'NX');
      if (got === 'OK') await purgeMailboxAccessAudit();
    } catch (err) {
      log.warn({ err }, 'Mailbox access audit purge failed');
    }
  };
  const first = setTimeout(() => void tick(), opts.initialDelayMs ?? 7 * 60_000);
  const timer = setInterval(() => void tick(), interval);
  first.unref?.();
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
