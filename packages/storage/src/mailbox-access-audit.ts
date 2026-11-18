/**
 * Mailbox access audit (9.4): what delegates and Shared Mailbox users do in a
 * mailbox that is not their own — from every client (webmail, IMAP, JMAP,
 * ActiveSync, SMTP submission, MAPI).
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
 * once per actor, mailbox and client type per hour — claimed with SET NX EX on
 * the shared Redis client across all processes, with a bounded per-process
 * store as the fallback while Redis is unavailable ({@link claimShared}).
 * Writes and sends are written every time (one row per command, with counts).
 *
 * On/off: ServerSettings.auditLogEnabled AND mailboxAccessAuditEnabled.
 * Retention: ServerSettings.mailboxAccessAuditRetentionDays (0 = keep), purged
 * hourly by {@link startMailboxAccessAuditPurger} — only `mailbox.foreign.*`
 * rows; other audit entries are never purged.
 *
 * Recording never throws: an audit failure must not break mail access.
 */
import { randomUUID } from 'node:crypto';
import { createLogger, peekRedisClient } from '@coremail/core';
import { prisma } from './prisma/index.js';

const log = createLogger('storage:mailbox-access-audit');

export const MAILBOX_ACCESS_ACTION_PREFIX = 'mailbox.foreign.';

export type MailboxAccessSource = 'webmail' | 'imap' | 'jmap' | 'activesync' | 'smtp' | 'mapi';

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

function isClaimedLocally(key: string, now: number): boolean {
  const until = localClaims.get(key);
  return until !== undefined && until > now;
}

function markLocally(key: string, ttlMs: number, now: number): void {
  if (localClaims.size >= MAX_LOCAL_CLAIMS) {
    for (const [k, v] of localClaims) if (v <= now) localClaims.delete(k);
    if (localClaims.size >= MAX_LOCAL_CLAIMS) localClaims.clear();
  }
  localClaims.set(key, now + ttlMs);
}

/** First claim of a key per window in this process (true = write the event). */
export function claimLocally(key: string, ttlSec: number, now = Date.now()): boolean {
  if (isClaimedLocally(key, now)) return false;
  markLocally(key, ttlSec * 1000, now);
  return true;
}

/** The Redis surface of the shared claim (SET key value EX ttl NX). */
export interface AccessClaimRedis {
  /** ioredis connection state; anything but 'ready' → the per-process fallback. */
  readonly status?: string;
  set(key: string, value: string, ex: 'EX', ttlSec: number, nx: 'NX'): Promise<'OK' | null>;
}

declare global {
  // Test seam: an in-memory fake, or null for "no Redis" (per-process claims only).
  // eslint-disable-next-line no-var
  var __accessAuditRedis: AccessClaimRedis | null | undefined;
}

/** A Redis claim answer later than this falls back to the per-process store. */
export const SHARED_CLAIM_TIMEOUT_MS = 500;
/** A key another process holds is not asked again for this long (bounded Redis traffic). */
const FOREIGN_CLAIM_RECHECK_MS = 5 * 60_000;

/**
 * The services that audit (api-gateway, IMAP, JMAP, SMTP, ActiveSync) create
 * the shared client at start; the claim never opens a connection itself.
 */
function claimRedis(): AccessClaimRedis | null {
  if (globalThis.__accessAuditRedis !== undefined) return globalThis.__accessAuditRedis;
  return peekRedisClient() as unknown as AccessClaimRedis | null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Redis claim timed out after ${ms} ms`)), ms);
    timer.unref?.();
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * First claim of an aggregation key across all processes (true = write the
 * event): SET NX EX on the shared Redis client, so several api-gateway / IMAP /
 * JMAP processes write one `open` per window together. A key this process
 * already holds (or saw held elsewhere) is answered locally without Redis.
 * Redis not ready, slow or failing → the per-process store (at most one row per
 * process and window instead of none — the audit never stops).
 */
export async function claimShared(
  key: string,
  ttlSec: number,
  redis: AccessClaimRedis | null = claimRedis(),
  now = Date.now(),
): Promise<boolean> {
  if (isClaimedLocally(key, now)) return false;
  if (redis && (redis.status === undefined || redis.status === 'ready')) {
    try {
      const got = await withTimeout(redis.set(key, '1', 'EX', ttlSec, 'NX'), SHARED_CLAIM_TIMEOUT_MS);
      markLocally(key, got === 'OK' ? ttlSec * 1000 : Math.min(ttlSec * 1000, FOREIGN_CLAIM_RECHECK_MS), now);
      return got === 'OK';
    } catch (err) {
      log.warn({ err }, 'Mailbox access audit: shared claim unavailable — aggregating in this process');
    }
  }
  return claimLocally(key, ttlSec, now);
}

/** Tests: forget the per-process claims. */
export function resetLocalAccessClaims(): void {
  localClaims.clear();
}

const defaultDeps: AccessAuditDeps = {
  enabled: async () => (await mailboxAccessAuditSettings()).enabled,
  claim: (key, ttlSec) => claimShared(key, ttlSec),
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
