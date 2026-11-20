/**
 * 10.5 attack protection (BCP → Schutz → Angriffsschutz) — docs/attack-protection.md.
 *
 *  - Settings (table attack_protection_settings, singleton): notifications on/off
 *    + recipient + failure threshold, repeat-offender escalation on/off +
 *    threshold + lifetime. Cached 60 s per process, dropped on
 *    CHANNEL_SETTINGS_RELOAD {type:'attack-protection'}.
 *  - handleLockoutEvent(): the shared lockout's hook (mail-auth.ts) — records
 *    security events (security-events.ts), queues admin notifications and
 *    escalates repeat offenders (an IP locked N times within 7 days → automatic
 *    block list entry, audit `security.ip.autoblock`). 10.5 review: never for a
 *    shared / legitimately used address (autoBlockExemption), never for an IP
 *    from an unverified forwarding header, IPv6 per /64, escalating lifetime
 *    1 d → 7 d → autoBlockDays, and never applied to inbound port 25.
 *  - Notifications: items are queued in Redis (`attackprot:notify:pending`, any
 *    process); the api-gateway flushes them into ONE aggregated mail at most
 *    every 15 minutes (flushAttackNotifications, Redis-locked).
 *  - Lock admin: listActiveLocks() / releaseLock() over the lockout's Redis keys
 *    (mail-auth-core.ts LOCKOUT_KEYS).
 *  - purgeAttackProtectionData(): expired block list entries, attack events older
 *    than ATTACK_EVENT_RETENTION_DAYS (90; 0 = keep).
 *
 * Every hook path never throws — attack protection must not break a login.
 */
import { createLogger, getRedisClient, peekRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { prisma } from './prisma/index.js';
import {
  LOCKOUT_KEYS, accountLockId, createExemptIpMatcher, ipLockIdOf, isPrivateOrLoopbackIp,
  type LockInfo, type LockoutEvent,
} from './mail-auth-core.js';
import { ipAccessVerdict, parseCidr, publishIpAccessReload } from './ip-access.js';
import { recordSecurityEvent, type SecurityEventInput } from './security-events.js';

const log = createLogger('attack-protection');

// ─── Settings ────────────────────────────────────────────────────────────────

export interface AttackProtectionSettings {
  notifyEnabled: boolean;
  /** '' = ServerSettings.adminEmail, else the Organization Management admins. */
  notifyRecipient: string;
  /** Failed logins (all protocols) per 15 minutes that trigger a notice; 0 = off. */
  failureAlertThreshold: number;
  autoBlockEnabled: boolean;
  /** IP locks within 7 days that put the IP on the block list. */
  autoBlockThreshold: number;
  /**
   * Lifetime of an automatic entry in days; 0 = permanent. 10.5 review: the
   * last step of the escalation (1 d → 7 d → this value) and the cap of every step.
   */
  autoBlockDays: number;
}

export const DEFAULT_ATTACK_PROTECTION_SETTINGS: Readonly<AttackProtectionSettings> = Object.freeze({
  notifyEnabled: true,
  notifyRecipient: '',
  failureAlertThreshold: 200,
  autoBlockEnabled: true,
  autoBlockThreshold: 3,
  autoBlockDays: 30,
});

/** Accepted ranges of the admin API (also used to clamp stored values). */
export const ATTACK_PROTECTION_LIMITS = {
  failureAlertThreshold: { min: 0, max: 100_000 },
  autoBlockThreshold: { min: 2, max: 50 },
  autoBlockDays: { min: 0, max: 3650 },
} as const;

/** Maximum number of entries per list (block list / exceptions). */
export const MAX_IP_RULES_PER_KIND = 1000;

/** Note of automatic block list entries (shown in the BCP). */
export const AUTO_BLOCK_NOTE = 'automatisch: wiederholte Sperre';

const SETTINGS_TTL_MS = 60_000;
let settingsCache: { value: AttackProtectionSettings; expires: number } | null = null;

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
  return Math.min(max, Math.max(min, n));
};

/** Pure: a database row (or null) → settings with defaults and clamped numbers. */
export function settingsFromRow(row: Partial<AttackProtectionSettings> | null | undefined): AttackProtectionSettings {
  const d = DEFAULT_ATTACK_PROTECTION_SETTINGS;
  const L = ATTACK_PROTECTION_LIMITS;
  return {
    notifyEnabled: typeof row?.notifyEnabled === 'boolean' ? row.notifyEnabled : d.notifyEnabled,
    notifyRecipient: typeof row?.notifyRecipient === 'string' ? row.notifyRecipient.trim() : d.notifyRecipient,
    failureAlertThreshold: clampInt(row?.failureAlertThreshold, L.failureAlertThreshold.min, L.failureAlertThreshold.max, d.failureAlertThreshold),
    autoBlockEnabled: typeof row?.autoBlockEnabled === 'boolean' ? row.autoBlockEnabled : d.autoBlockEnabled,
    autoBlockThreshold: clampInt(row?.autoBlockThreshold, L.autoBlockThreshold.min, L.autoBlockThreshold.max, d.autoBlockThreshold),
    autoBlockDays: clampInt(row?.autoBlockDays, L.autoBlockDays.min, L.autoBlockDays.max, d.autoBlockDays),
  };
}

/** Current settings (60 s cache; a database error keeps the last value / the defaults). */
export async function loadAttackProtectionSettings(): Promise<AttackProtectionSettings> {
  const now = Date.now();
  if (settingsCache && settingsCache.expires > now) return settingsCache.value;
  try {
    const row = await prisma.attackProtectionSettings.findUnique({ where: { id: 'singleton' } });
    settingsCache = { value: settingsFromRow(row), expires: now + SETTINGS_TTL_MS };
  } catch (err) {
    log.warn({ err }, 'attack protection settings could not be loaded — using the last values / defaults');
    settingsCache = { value: settingsCache?.value ?? { ...DEFAULT_ATTACK_PROTECTION_SETTINGS }, expires: now + 10_000 };
  }
  return settingsCache.value;
}

export function invalidateAttackProtectionSettings(): void {
  settingsCache = null;
}

export const ATTACK_PROTECTION_RELOAD = 'attack-protection';

export function isAttackProtectionReload(message: string): boolean {
  try {
    return (JSON.parse(message) as { type?: unknown } | null)?.type === ATTACK_PROTECTION_RELOAD;
  } catch {
    return false;
  }
}

/** Stores a (validated) patch and tells every service. Returns the new settings. */
export async function saveAttackProtectionSettings(patch: Partial<AttackProtectionSettings>): Promise<AttackProtectionSettings> {
  const data: Partial<AttackProtectionSettings> = {};
  for (const k of Object.keys(DEFAULT_ATTACK_PROTECTION_SETTINGS) as Array<keyof AttackProtectionSettings>) {
    if (patch[k] !== undefined) (data as Record<string, unknown>)[k] = patch[k];
  }
  const row = await prisma.attackProtectionSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...data },
    update: data,
  });
  invalidateAttackProtectionSettings();
  try {
    // services always have a client; tests never open a connection; not awaited (Redis outage)
    const r = peekRedisClient();
    if (r) void r.publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: ATTACK_PROTECTION_RELOAD }))
      .catch((err: unknown) => log.warn({ err }, 'Could not publish the attack protection reload signal'));
  } catch (err) {
    log.warn({ err }, 'Could not publish the attack protection reload signal — caches expire within 60 s');
  }
  return settingsFromRow(row);
}

let settingsSubscribed = false;

/** Drops the settings cache on every change of any instance. Idempotent. */
export function startAttackProtectionSubscriber(): void {
  if (settingsSubscribed) return;
  settingsSubscribed = true;
  try {
    const sub = getRedisClient().duplicate();
    sub.on('error', (err) => log.warn({ err }, 'attack protection subscriber error'));
    sub.on('message', (_channel: string, message: string) => {
      if (isAttackProtectionReload(message)) invalidateAttackProtectionSettings();
    });
    void sub.subscribe(CHANNEL_SETTINGS_RELOAD).catch((err: unknown) => log.warn({ err }, 'attack protection subscribe failed'));
  } catch (err) {
    log.warn({ err }, 'attack protection subscriber not started — the 60 s cache TTL applies');
  }
}

// ─── Notification queue ──────────────────────────────────────────────────────

export type AttackNoticeItem =
  | { kind: 'lock'; scope: 'ip' | 'account'; ip: string | null; account: string | null; protocol: string; strikes: number; lockSec: number; at: string }
  | { kind: 'autoblock'; ip: string; locks: number; days: number; at: string }
  | { kind: 'failures'; count: number; windowMin: number; at: string };

export const NOTIFY_KEYS = {
  pending: 'attackprot:notify:pending',
  gate: 'attackprot:notify:gate',
  lock: 'attackprot:notify:lock',
  failures: (bucket: number) => `attackprot:failures:${bucket}`,
} as const;

/** At most one notice per this many seconds. */
export const NOTIFY_INTERVAL_SEC = 15 * 60;
/** Window of the failure threshold. */
export const FAILURE_WINDOW_SEC = 15 * 60;
/** Bound of the pending list (oldest items are dropped). */
export const MAX_PENDING_NOTICES = 500;

/** The Redis surface of the notification queue (ioredis compatible). */
export interface NotifyRedis {
  rpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  set(key: string, value: string, mode: 'EX', seconds: number, flag: 'NX'): Promise<'OK' | null>;
  ttl(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

export async function queueAttackNotice(redis: NotifyRedis, item: AttackNoticeItem): Promise<void> {
  await redis.rpush(NOTIFY_KEYS.pending, JSON.stringify(item));
  await redis.ltrim(NOTIFY_KEYS.pending, -MAX_PENDING_NOTICES, -1);
}

const PROTOCOL_LABEL: Record<string, string> = {
  smtp: 'SMTP', imap: 'IMAP', pop3: 'POP3', web: 'Webmail/API', jmap: 'JMAP', caldav: 'CalDAV/CardDAV',
  activesync: 'ActiveSync', mapi: 'MAPI', autodiscover: 'Autodiscover', mcp: 'MCP', http: 'HTTP',
};
export const protocolLabel = (p: string): string => PROTOCOL_LABEL[p] ?? p.toUpperCase();

const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};
const fmtDuration = (sec: number): string => (sec >= 3600 ? `${Math.round(sec / 360) / 10} h` : `${Math.max(1, Math.round(sec / 60))} min`);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Agg { key: string; count: number; protocols: Set<string>; last: string; strikes: number; lockSec: number }

function aggregate(items: AttackNoticeItem[], scope: 'ip' | 'account'): Agg[] {
  const map = new Map<string, Agg>();
  for (const it of items) {
    if (it.kind !== 'lock' || it.scope !== scope) continue;
    const key = (scope === 'ip' ? it.ip : it.account) ?? '?';
    const a = map.get(key) ?? { key, count: 0, protocols: new Set<string>(), last: it.at, strikes: 0, lockSec: 0 };
    a.count++;
    a.protocols.add(protocolLabel(it.protocol));
    if (it.at >= a.last) { a.last = it.at; a.strikes = it.strikes; a.lockSec = it.lockSec; }
    map.set(key, a);
  }
  return [...map.values()].sort((x, y) => y.count - x.count || (y.last > x.last ? 1 : -1));
}

/**
 * Pure: one aggregated notice (German, like the BCP) for the queued items —
 * locked IPs and accounts (with protocols and counts), automatic block list
 * entries and failure-threshold alerts. Lists are capped at 50 lines each.
 */
export function buildAttackNotice(items: AttackNoticeItem[], opts: { host: string; product: string }): { subject: string; text: string; html: string } {
  const ips = aggregate(items, 'ip');
  const accounts = aggregate(items, 'account');
  const autos = items.filter((i): i is Extract<AttackNoticeItem, { kind: 'autoblock' }> => i.kind === 'autoblock');
  const alerts = items.filter((i): i is Extract<AttackNoticeItem, { kind: 'failures' }> => i.kind === 'failures');
  const parts: string[] = [];
  if (ips.length) parts.push(`${ips.length} IP-Sperre${ips.length === 1 ? '' : 'n'}`);
  if (accounts.length) parts.push(`${accounts.length} Konto-Sperre${accounts.length === 1 ? '' : 'n'}`);
  if (autos.length) parts.push(`${autos.length} dauerhaft gesperrt`);
  if (alerts.length) parts.push('viele Fehlanmeldungen');
  const subject = `[${opts.product}] Angriffsschutz: ${parts.join(', ') || 'Hinweis'}`;

  const LIMIT = 50;
  const lockLine = (a: Agg) =>
    `${a.key} — ${a.count}× gesperrt (${[...a.protocols].join(', ')}), zuletzt ${fmtTime(a.last)}, Stufe ${a.strikes}, ${fmtDuration(a.lockSec)}`;
  const sections: Array<{ title: string; lines: string[] }> = [];
  if (ips.length) sections.push({ title: `Gesperrte IP-Adressen (${ips.length})`, lines: ips.slice(0, LIMIT).map(lockLine) });
  if (accounts.length) sections.push({ title: `Gesperrte Konten (${accounts.length})`, lines: accounts.slice(0, LIMIT).map(lockLine) });
  if (autos.length) {
    sections.push({
      title: `Automatisch in die Sperrliste aufgenommen (${autos.length})`,
      lines: autos.slice(0, LIMIT).map((a) => `${a.ip} — ${a.locks} Sperren in 7 Tagen, ${a.days > 0 ? `${a.days} ${a.days === 1 ? 'Tag' : 'Tage'}` : 'dauerhaft'} (${fmtTime(a.at)})`),
    });
  }
  if (alerts.length) {
    sections.push({
      title: 'Viele Fehlanmeldungen',
      lines: alerts.slice(0, LIMIT).map((a) => `${a.count} fehlgeschlagene Anmeldungen innerhalb von ${a.windowMin} Minuten (${fmtTime(a.at)})`),
    });
  }
  const more = (n: number) => (n > LIMIT ? [`… und ${n - LIMIT} weitere`] : []);
  for (const s of sections) {
    const total = s.title.match(/\((\d+)\)$/);
    if (total) s.lines.push(...more(Number(total[1])));
  }
  const link = `https://${opts.host}/bcp/attack-protection`;
  const intro = `Angriffsschutz auf ${opts.host} — Zusammenfassung seit der letzten Benachrichtigung.`;
  const outro = [
    `Verwalten (Entsperren, Sperrliste, Ausnahmen): BCP → Schutz → Angriffsschutz — ${link}`,
    'Diese Benachrichtigung wird höchstens alle 15 Minuten versendet; sie lässt sich dort abschalten.',
  ];
  const text = [intro, '', ...sections.flatMap((s) => [`${s.title}:`, ...s.lines.map((l) => `  ${l}`), '']), ...outro, ''].join('\n');
  const html = [
    `<p>${esc(intro)}</p>`,
    ...sections.map((s) => `<h3 style="font-size:14px;margin:16px 0 4px">${esc(s.title)}</h3><ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`),
    `<p style="font-size:12px">${outro.map(esc).join('<br>')}</p>`,
  ].join('\n');
  return { subject, text, html };
}

export interface FlushDeps {
  redis: NotifyRedis;
  settings(): Promise<AttackProtectionSettings>;
  recipients(settings: AttackProtectionSettings): Promise<string[]>;
  deliver(recipient: string, notice: { subject: string; text: string; html: string }): Promise<void>;
  host(): Promise<string>;
  product(): Promise<string>;
}

export type FlushResult =
  | { status: 'busy' | 'idle' | 'throttled' }
  | { status: 'disabled' | 'no-recipient'; dropped: number }
  | { status: 'sent'; items: number; recipients: string[] };

/**
 * Sends the queued items as one notice unless one was sent within the last
 * 15 minutes (then they keep aggregating). Redis-locked: one instance sends.
 */
export async function flushAttackNotifications(deps: FlushDeps): Promise<FlushResult> {
  const { redis } = deps;
  if ((await redis.set(NOTIFY_KEYS.lock, '1', 'EX', 60, 'NX')) !== 'OK') return { status: 'busy' };
  try {
    const raw = await redis.lrange(NOTIFY_KEYS.pending, 0, MAX_PENDING_NOTICES - 1);
    if (raw.length === 0) return { status: 'idle' };
    const drop = () => redis.ltrim(NOTIFY_KEYS.pending, raw.length, -1);
    const settings = await deps.settings();
    if (!settings.notifyEnabled) { await drop(); return { status: 'disabled', dropped: raw.length }; }
    if ((await redis.ttl(NOTIFY_KEYS.gate)) > 0) return { status: 'throttled' };
    const recipients = [...new Set((await deps.recipients(settings)).map((r) => r.trim().toLowerCase()).filter(Boolean))];
    if (recipients.length === 0) {
      log.warn({ items: raw.length }, 'attack notice dropped — no recipient (set one in BCP → Angriffsschutz or ServerSettings.adminEmail)');
      await drop();
      return { status: 'no-recipient', dropped: raw.length };
    }
    const items: AttackNoticeItem[] = [];
    for (const r of raw) { try { items.push(JSON.parse(r) as AttackNoticeItem); } catch { /* skip */ } }
    const notice = buildAttackNotice(items, { host: await deps.host(), product: await deps.product() });
    // The gate first: a crash after delivery must not send the same notice in a loop.
    await redis.del(NOTIFY_KEYS.gate);
    await redis.set(NOTIFY_KEYS.gate, '1', 'EX', NOTIFY_INTERVAL_SEC, 'NX');
    await drop();
    for (const rcpt of recipients) {
      await deps.deliver(rcpt, notice).catch((err: unknown) => log.warn({ err, rcpt }, 'attack notice could not be delivered'));
    }
    log.info({ items: items.length, recipients }, 'attack notice sent');
    return { status: 'sent', items: items.length, recipients };
  } finally {
    await redis.del(NOTIFY_KEYS.lock).catch(() => 0);
  }
}

/** Default recipients: the configured address, else ServerSettings.adminEmail, else the Organization Management admins. */
export async function attackNoticeRecipients(settings: AttackProtectionSettings): Promise<string[]> {
  if (settings.notifyRecipient.trim()) return [settings.notifyRecipient.trim()];
  const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { adminEmail: true } });
  if (s?.adminEmail?.trim()) return [s.adminEmail.trim()];
  const admins = await prisma.user.findMany({
    where: { active: true, role: 'ORGANIZATION_MANAGEMENT' },
    select: { email: true },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  return admins.map((a) => a.email);
}

/** Mailbox id of a local, active user address (notice delivered internally), else null. */
export async function localMailboxIdOf(email: string): Promise<string | null> {
  const u = await prisma.user.findFirst({
    where: { email: email.trim().toLowerCase(), active: true },
    select: { mailbox: { select: { id: true } } },
  });
  return u?.mailbox?.id ?? null;
}

// ─── Lockout events (mail-auth.ts hook) ─────────────────────────────────────

export interface LockoutHandlerDeps {
  record(e: SecurityEventInput): void;
  settings(): Promise<AttackProtectionSettings>;
  /** The notification queue's Redis; null = no notifications (no Redis). */
  notifyRedis(): NotifyRedis | null;
  /** `ip` = the IP lock id (IPv4 address, IPv6 /64). */
  autoBlock(ip: string, locks: number, settings: AttackProtectionSettings, protocol: string): Promise<void>;
  now?: () => number;
}

/** Builds the lockout event handler (injectable for tests). */
export function createLockoutEventHandler(deps: LockoutHandlerDeps): (e: LockoutEvent) => Promise<void> {
  const now = deps.now ?? Date.now;
  const queue = async (item: AttackNoticeItem, s: AttackProtectionSettings): Promise<void> => {
    if (!s.notifyEnabled) return;
    const r = deps.notifyRedis();
    if (r) await queueAttackNotice(r, item);
  };
  return async (e) => {
    try {
      const at = new Date(now()).toISOString();
      switch (e.kind) {
        case 'failure': {
          deps.record({ type: 'AUTH_BRUTE_FORCE', ip: e.ip, protocol: e.protocol, target: e.account, detail: { status: e.status } });
          const s = await deps.settings();
          const r = deps.notifyRedis();
          if (s.failureAlertThreshold > 0 && r) {
            const bucket = Math.floor(now() / (FAILURE_WINDOW_SEC * 1000));
            const key = NOTIFY_KEYS.failures(bucket);
            const n = await r.incr(key);
            if (n === 1) await r.expire(key, FAILURE_WINDOW_SEC * 2);
            if (n === s.failureAlertThreshold) await queue({ kind: 'failures', count: n, windowMin: FAILURE_WINDOW_SEC / 60, at }, s);
          }
          return;
        }
        case 'lock': {
          deps.record({
            type: 'AUTH_LOCKOUT', ip: e.ip, protocol: e.protocol, target: e.scope === 'account' ? e.account : null, important: true,
            detail: { scope: e.scope, strikes: e.strikes, lockSec: e.lockSec, failures: e.failures, ...(e.scope === 'ip' ? { locksInWindow: e.locksInWindow } : {}) },
          });
          const s = await deps.settings();
          // 10.5 review: IP locks are reported (and escalated) under their lock id — IPv6 per /64
          const lockIp = e.scope === 'ip' ? (e.ipLockId ?? e.ip) : e.ip;
          await queue({ kind: 'lock', scope: e.scope, ip: lockIp, account: e.account, protocol: e.protocol, strikes: e.strikes, lockSec: e.lockSec, at }, s);
          // 10.5 review: only an address from the socket or a verified proxy is escalated
          // (an unverified X-Forwarded-For value could name any victim address)
          if (e.scope === 'ip' && lockIp && e.ipTrusted !== false && s.autoBlockEnabled && e.locksInWindow >= s.autoBlockThreshold) {
            await deps.autoBlock(lockIp, e.locksInWindow, s, e.protocol);
          }
          return;
        }
        case 'refused':
          deps.record({ type: 'AUTH_LOCKED', ip: e.ip, protocol: e.protocol, target: e.scope === 'account' ? e.account : null, detail: { scope: e.scope, retryAfterSec: e.retryAfterSec } });
          return;
        case 'known_client':
          return; // a legitimate client of a locked account — no attack
      }
    } catch (err) {
      log.warn({ err, kind: e.kind }, 'lockout event not handled');
    }
  };
}

/**
 * 10.5 review: lifetime of an automatic entry by the number of earlier
 * automatic entries of the same range within AUTO_BLOCK_HISTORY_DAYS — 1 day,
 * then 7 days, then the configured lifetime (autoBlockDays; 0 = permanent).
 * Every step is capped by a shorter configured lifetime. Returns days, 0 = permanent.
 */
export const AUTO_BLOCK_STEPS_DAYS: readonly number[] = Object.freeze([1, 7]);
export const AUTO_BLOCK_HISTORY_DAYS = 90;

export function autoBlockLifetimeDays(prior: number, configuredDays: number): number {
  const step = AUTO_BLOCK_STEPS_DAYS[Math.max(0, Math.floor(prior))];
  if (step === undefined) return configuredDays;
  return configuredDays > 0 ? Math.min(step, configuredDays) : step;
}

/** Why a repeat offender is not put on the block list (10.5 review). */
export type AutoBlockExemption = 'private' | 'exception' | 'trusted-proxy' | 'legitimate-logins';

/** The Redis surface of the legitimate-login lookup (ioredis compatible). */
export interface AutoBlockRedis {
  scan(cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', n: number): Promise<[string, string[]]>;
  get(key: string): Promise<string | null>;
}

/**
 * 10.5 review: the proxies TRUST_PROXY names explicitly (IPs / CIDRs; the
 * named ranges loopback / linklocal / uniquelocal are private anyway). A hop
 * count or `true` names no address. Invalid values → nothing.
 */
export function trustProxyPeerMatcher(raw: string | undefined): (ip: string) => boolean {
  const v = (raw ?? '').trim();
  if (!v || /^(false|no|off|0|true|yes|on|\d+)$/i.test(v)) return () => false;
  const entries = v.split(',').map((s) => s.trim()).filter((s) => s && !/^(loopback|linklocal|uniquelocal)$/i.test(s));
  if (entries.length === 0) return () => false;
  const m = createExemptIpMatcher(entries.join(','));
  // createExemptIpMatcher always exempts loopback — loopback is private here anyway
  return (ip) => m.isExempt(ip);
}

/**
 * 10.5 review: never auto-block an address many clients share or legitimate
 * users log in from — private / CGNAT / ULA / link-local / loopback ranges
 * (Docker userland proxy and bridge gateways, office NAT, a reverse proxy
 * without TRUST_PROXY), the configured exceptions, the proxies TRUST_PROXY
 * names, and an IP lock id with successful logins of ≥ 2 accounts or of an
 * admin within LOGIN_SUCCESS_IP_TTL_SEC. Manual entries are not affected.
 * `lockId` = IPv4 address or IPv6 /64 (ipLockIdOf). Redis errors → not exempt
 * for that reason (the other checks still apply).
 */
export async function autoBlockExemption(
  lockId: string,
  opts: { redis?: AutoBlockRedis | null; trustProxy?: string | undefined } = {},
): Promise<AutoBlockExemption | null> {
  const id = ipLockIdOf(lockId);
  if (!id) return null;
  const address = id.endsWith('/64') ? id.slice(0, -3) : id;
  // '::/64' holds ::1 (loopback) — like every private range never auto-blocked
  if (isPrivateOrLoopbackIp(address) || address === '::') return 'private';
  if (ipAccessVerdict(address) === 'allow') return 'exception';
  if (trustProxyPeerMatcher(opts.trustProxy ?? process.env['TRUST_PROXY'])(address)) return 'trusted-proxy';
  const redis = opts.redis === undefined ? (peekRedisClient() as unknown as AutoBlockRedis | null) : opts.redis;
  if (redis) {
    try {
      const accounts = new Set<string>();
      const prefix = LOCKOUT_KEYS.ipOk(id, '');
      let cursor = '0';
      let rounds = 0;
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 1000);
        cursor = next;
        for (const k of keys) {
          if (!k.startsWith(prefix)) continue;
          accounts.add(k.slice(prefix.length));
          if (accounts.size >= 2) return 'legitimate-logins';
          if ((await redis.get(k)) === 'a') return 'legitimate-logins';
        }
      } while (cursor !== '0' && ++rounds < 10_000);
    } catch (err) {
      log.warn({ err }, 'legitimate-login lookup of a repeat offender failed — not exempt for that reason');
    }
  }
  return null;
}

export interface AddAutoBlockOptions {
  /** Redis of the legitimate-login lookup (default: the process client; null = none). */
  redis?: AutoBlockRedis | null;
  /** TRUST_PROXY value (default: the environment). */
  trustProxy?: string | undefined;
}

/**
 * G — repeat offender: puts the IP lock id (IPv4 address, IPv6 /64) on the
 * block list as an automatic entry (note AUTO_BLOCK_NOTE). 10.5 review: never
 * for a shared / legitimately used address (autoBlockExemption); escalating
 * lifetime 1 d → 7 d → autoBlockDays (autoBlockLifetimeDays); automatic entries
 * apply to client surfaces only, never to inbound port 25 (ip-access.ts). A
 * manual or permanent entry is left alone; the list cap applies. Audit
 * `security.ip.autoblock`, security event IP_AUTO_BLOCKED and a notice.
 * Returns true when an entry was written.
 */
export async function addAutoBlock(
  rawIp: string, locks: number, settings: AttackProtectionSettings, protocol = 'http', opts: AddAutoBlockOptions = {},
): Promise<boolean> {
  const ip = ipLockIdOf(rawIp);
  const c = parseCidr(ip);
  if (!c) return false;
  try {
    const exempt = await autoBlockExemption(ip, opts);
    if (exempt) {
      log.info({ ip: c.cidr, locks, reason: exempt }, 'repeat offender NOT added to the block list — shared or legitimately used address');
      return false;
    }
    const existing = await prisma.ipAccessRule.findUnique({ where: { kind_cidr: { kind: 'BLOCK', cidr: c.cidr } } });
    if (existing) return false; // already blocked (manually or automatically)
    const count = await prisma.ipAccessRule.count({ where: { kind: 'BLOCK' } });
    if (count >= MAX_IP_RULES_PER_KIND) {
      log.warn({ ip, count }, 'repeat offender not blocked — the block list is full');
      return false;
    }
    let prior = 0;
    try {
      prior = await prisma.auditLog.count({
        where: {
          action: 'security.ip.autoblock', targetName: c.cidr,
          timestamp: { gte: new Date(Date.now() - AUTO_BLOCK_HISTORY_DAYS * 86_400_000) },
        },
      });
    } catch (err) {
      log.warn({ err }, 'earlier automatic blocks could not be counted — using the first step');
    }
    const days = autoBlockLifetimeDays(prior, settings.autoBlockDays);
    const expiresAt = days > 0 ? new Date(Date.now() + days * 86_400_000) : null;
    await prisma.ipAccessRule.create({
      data: { kind: 'BLOCK', cidr: c.cidr, note: AUTO_BLOCK_NOTE, auto: true, expiresAt, createdBy: null },
    });
    await prisma.auditLog.create({
      data: {
        actorEmail: 'system', action: 'security.ip.autoblock', targetType: 'ip', targetName: c.cidr,
        changes: { locks, days, step: prior + 1, expiresAt: expiresAt?.toISOString() ?? null },
        success: true,
      },
    }).catch((err: unknown) => log.warn({ err }, 'audit row of an automatic block not written'));
    await publishIpAccessReload();
    recordSecurityEvent({ type: 'IP_AUTO_BLOCKED', ip, protocol, important: true, detail: { locks, days, step: prior + 1, cidr: c.cidr } });
    if (settings.notifyEnabled) {
      const r = peekRedisClient() as unknown as NotifyRedis | null;
      if (r) await queueAttackNotice(r, { kind: 'autoblock', ip: c.cidr, locks, days, at: new Date().toISOString() });
    }
    log.warn({ ip: c.cidr, locks, days, step: prior + 1 }, 'repeat offender added to the block list');
    return true;
  } catch (err) {
    // P2002: another process added it at the same moment
    if ((err as { code?: string }).code !== 'P2002') log.warn({ err, ip }, 'automatic block failed');
    return false;
  }
}

const productionHandler = createLockoutEventHandler({
  record: recordSecurityEvent,
  settings: loadAttackProtectionSettings,
  notifyRedis: () => peekRedisClient() as unknown as NotifyRedis | null,
  autoBlock: async (ip, locks, s, protocol) => { await addAutoBlock(ip, locks, s, protocol); },
});

/** The production hook of the shared lockout (fire-and-forget, never throws). */
export function handleLockoutEvent(e: LockoutEvent): void {
  void productionHandler(e);
}

// ─── Lock admin (Redis) ──────────────────────────────────────────────────────

/** The Redis surface of the lock view (ioredis compatible). */
export interface LockScanRedis {
  scan(cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', n: number): Promise<[string, string[]]>;
  ttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

export interface ActiveLock {
  scope: 'ip' | 'account';
  /** IP (scope ip) or the account hash (scope account) — the release id. */
  id: string;
  ip: string | null;
  /** Account locks: the e-mail (from the info record; null for locks before 10.5). */
  account: string | null;
  remainingSec: number;
  strikes: number;
  failures: number | null;
  protocol: string | null;
  lockedAt: string | null;
  lockSec: number | null;
  /** IP locks: locks within the 7-day window. */
  locksInWindow: number | null;
}

const LOCK_KEY_RE = /^mailauth:(ip|acct):lock:(.+)$/;

/** Currently locked IPs and accounts (SCAN, at most `max` locks). */
export async function listActiveLocks(redis: LockScanRedis, opts: { max?: number } = {}): Promise<{ ips: ActiveLock[]; accounts: ActiveLock[]; truncated: boolean }> {
  const max = opts.max ?? 500;
  const keys: string[] = [];
  let cursor = '0';
  let truncated = false;
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'mailauth:*:lock:*', 'COUNT', 500);
    cursor = next;
    for (const k of batch) {
      if (keys.length >= max) { truncated = true; break; }
      if (LOCK_KEY_RE.test(k)) keys.push(k);
    }
  } while (cursor !== '0' && !truncated);

  const out: ActiveLock[] = [];
  for (const key of keys) {
    const m = LOCK_KEY_RE.exec(key)!;
    const scope = m[1] === 'ip' ? 'ip' : 'acct';
    const id = m[2]!;
    const [ttl, strikesRaw, infoRaw, locksRaw] = await Promise.all([
      redis.ttl(key),
      redis.get(key),
      redis.get(LOCKOUT_KEYS.info(scope, id)),
      scope === 'ip' ? redis.get(LOCKOUT_KEYS.locks(id)) : Promise.resolve(null),
    ]);
    if (ttl <= 0) continue;
    let info: Partial<LockInfo> = {};
    try { info = infoRaw ? JSON.parse(infoRaw) as LockInfo : {}; } catch { /* old / broken record */ }
    out.push({
      scope: scope === 'ip' ? 'ip' : 'account',
      id,
      ip: scope === 'ip' ? id : (info.ip ?? null),
      account: info.account ?? null,
      remainingSec: ttl,
      strikes: parseInt(strikesRaw ?? '', 10) || info.strikes || 1,
      failures: typeof info.failures === 'number' ? info.failures : null,
      protocol: info.protocol ?? null,
      lockedAt: info.lockedAt ?? null,
      lockSec: typeof info.lockSec === 'number' ? info.lockSec : null,
      locksInWindow: locksRaw ? parseInt(locksRaw, 10) || null : null,
    });
  }
  out.sort((a, b) => b.remainingSec - a.remainingSec);
  return { ips: out.filter((l) => l.scope === 'ip'), accounts: out.filter((l) => l.scope === 'account'), truncated };
}

/**
 * Resolves the release id of a lock: scope ip → the IP lock id (IPv4 address,
 * IPv6 /64 — an IPv6 address or its /64 text), scope account → the 32-hex
 * account hash or an e-mail address (hashed). null = invalid.
 */
export function lockIdOf(scope: 'ip' | 'account', raw: string): string | null {
  const v = String(raw ?? '').trim();
  if (scope === 'ip') return ipLockIdOf(v) || null;
  if (/^[0-9a-f]{32}$/.test(v)) return v;
  if (/^[^\s@]+@[^\s@]+$/.test(v) && v.length <= 254) return accountLockId(v.toLowerCase());
  return null;
}

/**
 * Releases a lock: deletes the lock, the failure counter and the info record;
 * `resetStrikes` also forgets the backoff level (and, for IPs, the repeat-offender
 * counter). Returns whether a lock existed and its info record.
 */
export async function releaseLock(
  redis: LockScanRedis, scope: 'ip' | 'account', id: string, opts: { resetStrikes?: boolean } = {},
): Promise<{ released: boolean; info: LockInfo | null }> {
  const s = scope === 'ip' ? 'ip' : 'acct';
  let info: LockInfo | null = null;
  try {
    const raw = await redis.get(LOCKOUT_KEYS.info(s, id));
    info = raw ? JSON.parse(raw) as LockInfo : null;
  } catch { /* ignore */ }
  const ttl = await redis.ttl(LOCKOUT_KEYS.lock(s, id));
  const keys = [LOCKOUT_KEYS.lock(s, id), LOCKOUT_KEYS.fail(s, id), LOCKOUT_KEYS.info(s, id)];
  if (opts.resetStrikes) {
    keys.push(LOCKOUT_KEYS.strikes(s, id));
    if (s === 'ip') keys.push(LOCKOUT_KEYS.locks(id));
  }
  await redis.del(...keys);
  return { released: ttl > 0, info };
}

/** Forgets the repeat-offender counter of an IP (an automatic entry was removed by an admin). */
export async function resetRepeatCounter(redis: Pick<LockScanRedis, 'del'>, ip: string): Promise<void> {
  const v = ipLockIdOf(ip);
  if (v) await redis.del(LOCKOUT_KEYS.locks(v));
}

// ─── Retention ───────────────────────────────────────────────────────────────

export function attackEventRetentionDays(): number {
  const n = parseInt(process.env['ATTACK_EVENT_RETENTION_DAYS'] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 90;
}

/** Deletes expired block list / exception entries and old attack events. */
export async function purgeAttackProtectionData(now = new Date()): Promise<{ rules: number; events: number }> {
  const rules = await prisma.ipAccessRule.deleteMany({ where: { expiresAt: { lte: now } } });
  if (rules.count > 0) await publishIpAccessReload();
  const days = attackEventRetentionDays();
  const events = days > 0
    ? await prisma.attackEvent.deleteMany({ where: { timestamp: { lt: new Date(now.getTime() - days * 86_400_000) } } })
    : { count: 0 };
  return { rules: rules.count, events: events.count };
}
