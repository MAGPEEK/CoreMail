/**
 * Mailbox quotas (v8.1).
 *
 * Three levels per mailbox (User or SharedMailbox):
 *   - IssueWarningQuota        → quotaWarningBytes      (null = ServerSettings.quotaWarningPercent of quotaBytes)
 *   - ProhibitSendQuota        → quotaProhibitSendBytes (null = ServerSettings.quotaProhibitSendPercent of quotaBytes)
 *   - ProhibitSendReceiveQuota → quotaBytes (the existing mailbox quota; 0 = unlimited)
 *
 * Usage = sum of rawSize of the live (not soft-deleted) messages of the mailbox,
 * Recoverable Items excluded (they would count against a separate quota).
 * The aggregate is cached per process for QUOTA_USAGE_CACHE_SEC (default 60 s)
 * and adjusted on every local delivery, so a delivery never scans the mailbox;
 * the computed value is written back to usedBytes (the stored counter the BCP,
 * CLI and JMAP Quota read).
 *
 * Enforcement points:
 *   - every send path (SMTP submission, REST /mail/send, JMAP EmailSubmission,
 *     EAS SendMail) → checkSendQuota() — usage ≥ prohibit-send refuses (552 5.2.2)
 *   - inbound (port 25 RCPT TO and local delivery) → checkReceiveQuota() —
 *     usage ≥ prohibit-send-receive refuses with 552 5.2.2 (or 452 4.2.2, see
 *     QUOTA_FULL_PERMANENT)
 *   - usage ≥ warning → one warning mail per 24 h into the mailbox (quotaWarnedAt,
 *     atomic claim, so several processes never send two)
 *
 * Fails open: a database error never blocks mail flow (quota is not a security
 * boundary) — it is logged instead.
 */
import { createLogger } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { notifyMailboxInbox } from './internal-notify.js';
import { getProductName } from './branding.js';

const log = createLogger('storage:quota');

export type QuotaOwner = { kind: 'user'; id: string } | { kind: 'shared'; id: string };
export type QuotaLevel = 'ok' | 'warning' | 'prohibitSend' | 'prohibitSendReceive';

/** Effective limits in bytes; 0 = no limit at that level. */
export interface QuotaLimits {
  warningBytes: number;
  prohibitSendBytes: number;
  prohibitSendReceiveBytes: number;
}

export interface QuotaDefaults {
  warningPercent: number;
  prohibitSendPercent: number;
}

/** Default ratios: 1.9 GB / 2.0 GB of 2.3 GB. */
export const QUOTA_DEFAULTS: QuotaDefaults = { warningPercent: 83, prohibitSendPercent: 87 };

export interface QuotaStatus {
  owner: QuotaOwner;
  email: string;
  mailboxId: string | null;
  usedBytes: number;
  limits: QuotaLimits;
  level: QuotaLevel;
}

type Big = bigint | number | null | undefined;
const num = (v: Big): number => (v === null || v === undefined ? 0 : Number(v));

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Pure: effective limits of a mailbox row. An explicit level wins over the server default. */
export function effectiveQuotaLimits(
  row: { quotaBytes: Big; quotaWarningBytes?: Big; quotaProhibitSendBytes?: Big },
  defaults: QuotaDefaults = QUOTA_DEFAULTS,
): QuotaLimits {
  const hard = Math.max(0, num(row.quotaBytes));
  const pct = (p: number): number => (hard > 0 && p > 0 ? Math.floor((hard * Math.min(p, 100)) / 100) : 0);
  const explicit = (v: Big): number | null => (v === null || v === undefined ? null : Math.max(0, Number(v)));
  return {
    warningBytes: explicit(row.quotaWarningBytes) ?? pct(defaults.warningPercent),
    prohibitSendBytes: explicit(row.quotaProhibitSendBytes) ?? pct(defaults.prohibitSendPercent),
    prohibitSendReceiveBytes: hard,
  };
}

/** Pure: the highest level the usage has reached. */
export function quotaLevel(usedBytes: number, l: QuotaLimits): QuotaLevel {
  if (l.prohibitSendReceiveBytes > 0 && usedBytes >= l.prohibitSendReceiveBytes) return 'prohibitSendReceive';
  if (l.prohibitSendBytes > 0 && usedBytes >= l.prohibitSendBytes) return 'prohibitSend';
  if (l.warningBytes > 0 && usedBytes >= l.warningBytes) return 'warning';
  return 'ok';
}

const RANK: Record<QuotaLevel, number> = { ok: 0, warning: 1, prohibitSend: 2, prohibitSendReceive: 3 };
export const levelAtLeast = (level: QuotaLevel, min: QuotaLevel): boolean => RANK[level] >= RANK[min];

/**
 * Pure: the SMTP reply for a recipient whose mailbox is at/over the
 * prohibit-send-receive level. QUOTA_FULL_PERMANENT:
 *   unset | true | yes | 1  → always 552 5.2.2 (default)
 *   false | no | off        → always 452 4.2.2 (sender retries)
 *   <N> with N ≥ 100        → 452 4.2.2 while usage < N % of the quota, 552 5.2.2 above
 */
export function receiveQuotaReply(usedBytes: number, hardBytes: number, env: Record<string, string | undefined> = process.env): string {
  const permanent = '552 5.2.2 Mailbox full: the recipient\'s mailbox is over its storage quota';
  const transient = '452 4.2.2 Mailbox full: the recipient\'s mailbox is over its storage quota, try again later';
  const raw = (env['QUOTA_FULL_PERMANENT'] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'true' || raw === 'yes' || raw === '1' || raw === 'on') return permanent;
  if (raw === 'false' || raw === 'no' || raw === 'off' || raw === '0') return transient;
  const pct = Number(raw);
  if (Number.isFinite(pct) && pct >= 100) return usedBytes >= (hardBytes * pct) / 100 ? permanent : transient;
  return permanent;
}

export const SEND_QUOTA_REPLY = '552 5.2.2 Your mailbox is over its send quota — delete items (and empty Deleted Items) before sending';
export const SEND_QUOTA_MESSAGE = 'Mailbox over its send quota: delete items and empty the Trash before sending';

// ── Caches ────────────────────────────────────────────────────────────────────

function usageTtlMs(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env['QUOTA_USAGE_CACHE_SEC']);
  return (Number.isFinite(v) && v >= 0 ? v : 60) * 1000;
}

const usageCache = new Map<string, { bytes: number; at: number }>();
let defaultsCache: { value: QuotaDefaults; at: number } | null = null;
const DEFAULTS_TTL_MS = 60_000;

const keyOf = (o: QuotaOwner): string => `${o.kind}:${o.id}`;

/** Tests / settings change: forget cached usage and defaults. */
export function resetQuotaCache(): void {
  usageCache.clear();
  defaultsCache = null;
}

/** Server-wide defaults (ServerSettings.quota*Percent), cached 60 s. */
export async function loadQuotaDefaults(now = Date.now()): Promise<QuotaDefaults> {
  if (defaultsCache && now - defaultsCache.at < DEFAULTS_TTL_MS) return defaultsCache.value;
  let value = QUOTA_DEFAULTS;
  try {
    const s = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { quotaWarningPercent: true, quotaProhibitSendPercent: true },
    });
    if (s) value = { warningPercent: s.quotaWarningPercent, prohibitSendPercent: s.quotaProhibitSendPercent };
  } catch (err) {
    log.warn({ err }, 'quota defaults unavailable — using built-in defaults');
  }
  defaultsCache = { value, at: now };
  return value;
}

const RECOVERABLE_PREFIX = 'Recoverable Items';

/** Where-clause for the live messages counted against the quota of `owner`. */
function usageWhere(owner: QuotaOwner) {
  return {
    deletedAt: null,
    folder: {
      mailbox: owner.kind === 'user' ? { userId: owner.id } : { sharedBoxId: owner.id },
      NOT: { name: { startsWith: RECOVERABLE_PREFIX } },
    },
  };
}

/** Usage of a mailbox in bytes (cached aggregate, see module doc). */
export async function mailboxUsageBytes(owner: QuotaOwner, opts: { now?: number; fresh?: boolean; stored?: Big } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const hit = usageCache.get(keyOf(owner));
  if (!opts.fresh && hit && now - hit.at < usageTtlMs()) return hit.bytes;
  const agg = await prisma.message.aggregate({ where: usageWhere(owner), _sum: { rawSize: true } });
  const bytes = agg._sum.rawSize ?? 0;
  usageCache.set(keyOf(owner), { bytes, at: now });
  if (opts.stored === undefined || num(opts.stored) !== bytes) {
    // Keep the stored counter in step (BCP, CLI, JMAP Quota read it).
    const data = { usedBytes: BigInt(bytes) };
    const write = owner.kind === 'user'
      ? prisma.user.update({ where: { id: owner.id }, data })
      : prisma.sharedMailbox.update({ where: { id: owner.id }, data });
    void Promise.resolve(write).catch(() => undefined);
  }
  return bytes;
}

/** Adjusts the cached usage after a write that changes it (delivery, restore, purge). */
export function noteUsageDelta(owner: QuotaOwner, deltaBytes: number): void {
  const hit = usageCache.get(keyOf(owner));
  if (hit) hit.bytes = Math.max(0, hit.bytes + deltaBytes);
}

/** Forget the cached usage of one mailbox (next read aggregates again). */
export function invalidateUsage(owner: QuotaOwner): void {
  usageCache.delete(keyOf(owner));
}

// ── Lookups ───────────────────────────────────────────────────────────────────

interface OwnerRow {
  email: string;
  displayName: string;
  quotaBytes: bigint;
  usedBytes: bigint;
  quotaWarningBytes: bigint | null;
  quotaProhibitSendBytes: bigint | null;
  mailbox: { id: string } | null;
}

const OWNER_SELECT = {
  email: true, displayName: true, quotaBytes: true, usedBytes: true,
  quotaWarningBytes: true, quotaProhibitSendBytes: true, mailbox: { select: { id: true } },
} as const;

async function loadOwner(owner: QuotaOwner): Promise<OwnerRow | null> {
  return owner.kind === 'user'
    ? prisma.user.findUnique({ where: { id: owner.id }, select: OWNER_SELECT })
    : prisma.sharedMailbox.findUnique({ where: { id: owner.id }, select: OWNER_SELECT });
}

/** Quota status of a mailbox; null when the owner does not exist. */
export async function getQuotaStatus(owner: QuotaOwner, opts: { now?: number; fresh?: boolean } = {}): Promise<QuotaStatus | null> {
  const row = await loadOwner(owner);
  if (!row) return null;
  const [defaults, usedBytes] = await Promise.all([
    loadQuotaDefaults(opts.now),
    mailboxUsageBytes(owner, { ...opts, stored: row.usedBytes }),
  ]);
  const limits = effectiveQuotaLimits(row, defaults);
  return { owner, email: row.email, mailboxId: row.mailbox?.id ?? null, usedBytes, limits, level: quotaLevel(usedBytes, limits) };
}

/**
 * The mailbox that receives mail for `address`: a user, a shared mailbox or the
 * target of an active alias. null for anything else (resource mailboxes,
 * postmaster, unknown).
 */
export async function resolveQuotaOwner(address: string): Promise<QuotaOwner | null> {
  const email = address.trim().toLowerCase();
  const [user, shared, alias] = await Promise.all([
    prisma.user.findFirst({ where: { email, active: true }, select: { id: true } }),
    prisma.sharedMailbox.findFirst({ where: { email, active: true }, select: { id: true } }),
    prisma.emailAlias.findFirst({ where: { address: email, active: true }, select: { targetUserId: true, targetSharedId: true } }),
  ]);
  if (user) return { kind: 'user', id: user.id };
  if (shared) return { kind: 'shared', id: shared.id };
  if (alias?.targetUserId) return { kind: 'user', id: alias.targetUserId };
  if (alias?.targetSharedId) return { kind: 'shared', id: alias.targetSharedId };
  return null;
}

// ── Warning mail ──────────────────────────────────────────────────────────────

export const QUOTA_WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000;

type WarningSender = (status: QuotaStatus) => Promise<void>;
let warningSender: WarningSender | null = null;

/** Tests: capture warning mails instead of writing them (null restores the default). */
export function setQuotaWarningSender(fn: WarningSender | null): void {
  warningSender = fn;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** Pure: subject + text of the warning mail. */
export function quotaWarningText(s: QuotaStatus): { subject: string; bodyText: string } {
  const l = s.limits;
  const lines = [
    `Your mailbox ${s.email} is almost full / Ihr Postfach ${s.email} ist fast voll.`,
    '',
    `Used / Belegt: ${formatBytes(s.usedBytes)}`,
    ...(l.prohibitSendBytes > 0 ? [`Sending stops at / Senden gesperrt ab: ${formatBytes(l.prohibitSendBytes)}`] : []),
    ...(l.prohibitSendReceiveBytes > 0 ? [`Receiving stops at / Empfang gesperrt ab: ${formatBytes(l.prohibitSendReceiveBytes)}`] : []),
    '',
    s.level === 'ok' || s.level === 'warning'
      ? 'Please delete items you no longer need and empty the Trash.'
      : s.level === 'prohibitSend'
        ? 'You can no longer send mail until you free up space.'
        : 'You can no longer send or receive mail until you free up space.',
    'Bitte löschen Sie nicht mehr benötigte Elemente und leeren Sie den Papierkorb.',
  ];
  return { subject: 'Your mailbox is almost full / Ihr Postfach ist fast voll', bodyText: lines.join('\n') };
}

async function defaultWarningSender(s: QuotaStatus): Promise<void> {
  if (!s.mailboxId) return;
  const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } })
    .catch(() => null);
  const { subject, bodyText } = quotaWarningText(s);
  await notifyMailboxInbox(s.mailboxId, {
    fromName: `${await getProductName()} System`, // 9.3: branded product name
    fromAddr: `system@${settings?.publicHostname || 'localhost'}`,
    subject,
    bodyText,
  });
}

/**
 * Sends the quota warning when the usage is at/over the warning level and no
 * warning was sent in the last 24 h. The claim (quotaWarnedAt) is one
 * conditional UPDATE, so concurrent deliveries/processes send at most one.
 * Returns true when this call sent the warning. Never throws.
 */
export async function maybeSendQuotaWarning(s: QuotaStatus, now = new Date()): Promise<boolean> {
  try {
    if (!levelAtLeast(s.level, 'warning')) return false;
    const cutoff = new Date(now.getTime() - QUOTA_WARNING_INTERVAL_MS);
    const where = { id: s.owner.id, OR: [{ quotaWarnedAt: null }, { quotaWarnedAt: { lt: cutoff } }] };
    const data = { quotaWarnedAt: now };
    const claimed = s.owner.kind === 'user'
      ? await prisma.user.updateMany({ where, data })
      : await prisma.sharedMailbox.updateMany({ where, data });
    if (claimed.count === 0) return false;
    await (warningSender ?? defaultWarningSender)(s);
    log.info({ owner: s.owner, usedBytes: s.usedBytes, level: s.level }, 'Quota warning sent');
    return true;
  } catch (err) {
    log.warn({ err, owner: s.owner }, 'Quota warning failed');
    return false;
  }
}

// ── Enforcement ───────────────────────────────────────────────────────────────

export type SendQuotaVerdict =
  | { allowed: true; status: QuotaStatus | null }
  | { allowed: false; status: QuotaStatus; reply: string; message: string };

/**
 * Send check for an authenticated user (their own mailbox). usage ≥ prohibit-send
 * refuses. Over the warning level the (throttled) warning mail goes out.
 */
export async function checkSendQuota(userId: string, opts: { now?: Date } = {}): Promise<SendQuotaVerdict> {
  let status: QuotaStatus | null;
  try {
    status = await getQuotaStatus({ kind: 'user', id: userId });
  } catch (err) {
    log.warn({ err, userId }, 'send quota check failed — allowing');
    return { allowed: true, status: null };
  }
  if (!status) return { allowed: true, status: null };
  if (levelAtLeast(status.level, 'warning')) void maybeSendQuotaWarning(status, opts.now);
  if (levelAtLeast(status.level, 'prohibitSend')) {
    return { allowed: false, status, reply: SEND_QUOTA_REPLY, message: SEND_QUOTA_MESSAGE };
  }
  return { allowed: true, status };
}

/**
 * Receive check for a mailbox. null = accept; otherwise the SMTP reply
 * (452 4.2.2 / 552 5.2.2, see receiveQuotaReply).
 */
export async function checkReceiveQuota(owner: QuotaOwner, opts: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<string | null> {
  let status: QuotaStatus | null;
  try {
    status = await getQuotaStatus(owner);
  } catch (err) {
    log.warn({ err, owner }, 'receive quota check failed — accepting');
    return null;
  }
  if (!status || status.level !== 'prohibitSendReceive') return null;
  void maybeSendQuotaWarning(status, opts.now);
  return receiveQuotaReply(status.usedBytes, status.limits.prohibitSendReceiveBytes, opts.env);
}

/** Client-visible text when a write is refused by the hard quota (IMAP/JMAP/EAS). */
export const OVER_QUOTA_MESSAGE = 'Mailbox is full (over its storage quota): delete items and empty the Trash';

/**
 * Hard quota (ProhibitSendReceiveQuota) for client writes that ADD content to a
 * mailbox — IMAP APPEND / COPY, JMAP Email/import and Email/set create, items
 * moved out of Recoverable Items. Uses a FRESH usage aggregate (no cache), so a
 * client cannot outrun the cached value with a burst of APPENDs. Moves within
 * the mailbox do not change the usage and must not be checked. Fail-open on a
 * database error (logged), like every other quota check.
 */
export async function isMailboxWriteBlocked(mailboxId: string, opts: { now?: number } = {}): Promise<boolean> {
  try {
    const m = await prisma.mailbox.findUnique({ where: { id: mailboxId }, select: { userId: true, sharedBoxId: true } });
    const owner: QuotaOwner | null = m?.userId ? { kind: 'user', id: m.userId } : m?.sharedBoxId ? { kind: 'shared', id: m.sharedBoxId } : null;
    if (!owner) return false;
    const status = await getQuotaStatus(owner, { fresh: true, ...(opts.now !== undefined ? { now: opts.now } : {}) });
    if (!status || status.level !== 'prohibitSendReceive') return false;
    void maybeSendQuotaWarning(status);
    return true;
  } catch (err) {
    log.warn({ err, mailboxId }, 'write quota check failed — allowing');
    return false;
  }
}

/** Receive check by recipient address (port 25 RCPT TO). */
export async function checkReceiveQuotaForAddress(address: string, opts: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<string | null> {
  let owner: QuotaOwner | null;
  try {
    owner = await resolveQuotaOwner(address);
  } catch (err) {
    log.warn({ err, address }, 'quota owner lookup failed — accepting');
    return null;
  }
  return owner ? checkReceiveQuota(owner, opts) : null;
}

/**
 * After a local delivery: account the bytes in the cached usage and send the
 * (throttled) warning when the warning level is reached. Never throws.
 */
export async function recordDelivery(owner: QuotaOwner, bytes: number, now = new Date()): Promise<void> {
  try {
    noteUsageDelta(owner, bytes);
    const status = await getQuotaStatus(owner);
    if (status && levelAtLeast(status.level, 'warning')) await maybeSendQuotaWarning(status, now);
  } catch (err) {
    log.warn({ err, owner }, 'quota accounting after delivery failed');
  }
}
