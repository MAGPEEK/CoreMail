/**
 * Per-user outgoing message rate (10.5) — ONE limiter for every client
 * submission path: SMTP submission (587/465), webmail / REST `/mail/send` and
 * draft send, ActiveSync SendMail / SmartReply / SmartForward, JMAP
 * EmailSubmission/set and MAPI RopSubmitMessage. It stops a compromised account
 * from spamming: it counts the MESSAGES and the RECIPIENTS a user submits per
 * sliding hour and refuses a submission that would exceed either limit.
 *
 * Counting
 *  - Key: the AUTHENTICATED user. Mail sent as / on behalf of a Shared Mailbox
 *    counts against the user who sends it.
 *  - Sliding-window counter (two fixed hour windows, the previous one weighted
 *    by the part of it still inside the last hour) in Redis
 *    (`sendrate:<userId>:<window>` hash {m, r}); check and increment are one
 *    Lua script, so parallel submissions of several processes cannot both pass
 *    the last slot. A refused submission is not counted.
 *  - Redis not ready, slow (> 500 ms) or failing → the same counter in process
 *    memory (one log line per minute). Each process then counts on its own —
 *    the limit is approximate until Redis is back (fail-open across processes,
 *    never "unlimited" inside one). An unexpected error lets the submission
 *    through with an error log line: the limiter never blocks mail on its own
 *    failure.
 *
 * Limits: ServerSettings.sendRateMessagesPerHour / sendRateRecipientsPerHour
 * (default 200 / 1000, switch sendRateLimitEnabled), a user's MailFlowPolicy
 * maxMessagesPerHour / maxRecipientsPerHour replace them for that mailbox.
 * Read with a 60 s cache, cleared together with the submission limits
 * (clearSubmissionLimitsCache on CHANNEL_SETTINGS_RELOAD).
 *
 * When a user hits the limit (first refusal per user and hour, shared claim):
 * audit entry `mail.send.rate-limited`, an AttackEvent row (type
 * SEND_RATE_LIMIT, also published on CHANNEL_ADMIN_ATTACK) and a notice to the
 * organisation admin address (ServerSettings.adminEmail when it is a local
 * mailbox, else the ORGANIZATION_MANAGEMENT admins). With
 * sendRateBlockOnExceed the account may then not send at all for one hour.
 *
 * Test seam: `globalThis.__sendRateRedis` replaces the Redis client
 * (null = no Redis: the in-process counter); `setSendRateHooks()` replaces the
 * side effects of a hit limit.
 */
import { createLogger, getRedisClient, CHANNEL_ADMIN_ATTACK } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { loadMailFlowPolicy } from './mail-flow.js';
import { addressVariants } from './idn.js';
import { notifyMailboxInbox } from './internal-notify.js';
import { getProductName } from './branding.js';

const log = createLogger('submission-rate');

/** The sliding window (one hour). */
export const SEND_RATE_WINDOW_SEC = 3600;
/** How long an account stays blocked with sendRateBlockOnExceed. */
export const SEND_RATE_BLOCK_SEC = 3600;
/** At most one notice / audit entry / attack event per user within this time. */
export const SEND_RATE_NOTICE_SEC = 3600;

export interface SendRateSettings {
  enabled: boolean;
  messagesPerHour: number;
  recipientsPerHour: number;
  blockOnExceed: boolean;
}

/** Schema defaults of the ServerSettings columns. */
export const SEND_RATE_DEFAULTS: Readonly<SendRateSettings> = Object.freeze({
  enabled: true, messagesPerHour: 200, recipientsPerHour: 1000, blockOnExceed: false,
});

/** Accepted ranges of the global values (BCP / admin API). */
export const SEND_RATE_BOUNDS = {
  messagesPerHour: [1, 100_000],
  recipientsPerHour: [1, 1_000_000],
} as const;

/** The submission path (audit / attack event detail). */
export type SendRateProtocol = 'smtp' | 'webmail' | 'activesync' | 'jmap' | 'mapi';

export interface SendRateRequest {
  /** The authenticated user (never the Shared Mailbox sent as). */
  userId: string;
  /** Recipients of the message (envelope, after de-duplication). 0 = only the message count is checked. */
  recipients: number;
  protocol: SendRateProtocol;
  /** Client IP when known (audit / attack event). */
  ipAddress?: string;
}

export type SendRateDecision =
  | { allowed: true }
  | {
    allowed: false;
    /** messages / recipients = the hourly limit; blocked = sendRateBlockOnExceed is in force. */
    reason: 'messages' | 'recipients' | 'blocked';
    limit: number;
    /** Seconds until a submission of the same size may pass (≥ 1). */
    retryAfterSec: number;
  };

// ─── Pure rules ──────────────────────────────────────────────────────────────

const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Pure: the settings from a ServerSettings row (missing / invalid → defaults). */
export function sendRateSettingsFrom(row: Partial<{
  sendRateLimitEnabled: boolean | null;
  sendRateMessagesPerHour: number | null;
  sendRateRecipientsPerHour: number | null;
  sendRateBlockOnExceed: boolean | null;
}> | null | undefined): SendRateSettings {
  const d = SEND_RATE_DEFAULTS;
  return {
    enabled: typeof row?.sendRateLimitEnabled === 'boolean' ? row.sendRateLimitEnabled : d.enabled,
    messagesPerHour: positiveInt(row?.sendRateMessagesPerHour) ? Math.floor(row.sendRateMessagesPerHour) : d.messagesPerHour,
    recipientsPerHour: positiveInt(row?.sendRateRecipientsPerHour) ? Math.floor(row.sendRateRecipientsPerHour) : d.recipientsPerHour,
    blockOnExceed: typeof row?.sendRateBlockOnExceed === 'boolean' ? row.sendRateBlockOnExceed : d.blockOnExceed,
  };
}

/** Pure: the limits of one user — a per-mailbox value replaces the global one. */
export function effectiveSendRate(
  global: SendRateSettings,
  policy: { maxMessagesPerHour?: number | null; maxRecipientsPerHour?: number | null } | null,
): { messagesPerHour: number; recipientsPerHour: number } {
  return {
    messagesPerHour: positiveInt(policy?.maxMessagesPerHour) ? policy.maxMessagesPerHour : global.messagesPerHour,
    recipientsPerHour: positiveInt(policy?.maxRecipientsPerHour) ? policy.maxRecipientsPerHour : global.recipientsPerHour,
  };
}

/** Counts of the current and the previous fixed window. */
export interface WindowCounts { curM: number; curR: number; prevM: number; prevR: number }

/**
 * Pure: the sliding-window verdict of one submission of `recipients` recipients
 * at `elapsedMs` into the current window. `retryAfterSec` is the time until the
 * weighted previous window has decayed enough (or, when the current window
 * alone is over the limit, until the next window plus that decay).
 */
export function slidingVerdict(
  c: WindowCounts,
  limits: { messagesPerHour: number; recipientsPerHour: number },
  recipients: number,
  elapsedMs: number,
  windowMs = SEND_RATE_WINDOW_SEC * 1000,
): { allowed: true } | { allowed: false; reason: 'messages' | 'recipients'; limit: number; retryAfterSec: number } {
  const weight = Math.max(0, 1 - elapsedMs / windowMs);
  const msgs = c.prevM * weight + c.curM;
  const rcpts = c.prevR * weight + c.curR;
  const overM = msgs + 1 > limits.messagesPerHour;
  const overR = recipients > 0 && rcpts + recipients > limits.recipientsPerHour;
  if (!overM && !overR) return { allowed: true };
  const wait = (prev: number, cur: number, need: number, limit: number): number => {
    // need: what this submission adds; the estimate must drop to limit - need.
    const room = limit - need;
    if (room < 0) return windowMs * 2 - elapsedMs; // larger than the limit itself: two windows
    if (cur > room) {
      // The current window alone is too much: in the next window it becomes the
      // previous one (weight 1 → 0 over that window).
      const w = cur > 0 ? room / cur : 1;
      return windowMs - elapsedMs + windowMs * (1 - w);
    }
    if (prev <= 0) return 0;
    const w = (room - cur) / prev; // the weight at which the estimate fits
    return Math.max(0, windowMs * (1 - w) - elapsedMs);
  };
  const waitMs = Math.max(
    overM ? wait(c.prevM, c.curM, 1, limits.messagesPerHour) : 0,
    overR ? wait(c.prevR, c.curR, recipients, limits.recipientsPerHour) : 0,
  );
  const retryAfterSec = Math.min(2 * SEND_RATE_WINDOW_SEC, Math.max(1, Math.ceil(waitMs / 1000)));
  return overM
    ? { allowed: false, reason: 'messages', limit: limits.messagesPerHour, retryAfterSec }
    : { allowed: false, reason: 'recipients', limit: limits.recipientsPerHour, retryAfterSec };
}

// ─── Counter store (Redis, in-process fallback) ──────────────────────────────

/** The part of an ioredis client the limiter uses. */
export interface SendRateRedis {
  status?: string;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  set(key: string, value: string, mode: 'EX', ttl: number, nx: 'NX'): Promise<unknown>;
}

/**
 * KEYS: current window, previous window, block key.
 * ARGV: weight, message limit, recipient limit, recipients, window TTL (s),
 *       commit (1/0), block on refusal (1/0), block TTL (ms).
 * Returns {code, curM, curR, prevM, prevR, blockTtlMs}: code 1 = allowed (and
 * counted when commit), 0 = refused (block set when requested), 2 = blocked.
 */
const SCRIPT = `
local b = redis.call('PTTL', KEYS[3])
if b > 0 then return {2, 0, 0, 0, 0, b} end
local cm = tonumber(redis.call('HGET', KEYS[1], 'm') or '0')
local cr = tonumber(redis.call('HGET', KEYS[1], 'r') or '0')
local pm = tonumber(redis.call('HGET', KEYS[2], 'm') or '0')
local pr = tonumber(redis.call('HGET', KEYS[2], 'r') or '0')
local w = tonumber(ARGV[1])
local n = tonumber(ARGV[4])
local overM = pm * w + cm + 1 > tonumber(ARGV[2])
local overR = n > 0 and (pr * w + cr + n > tonumber(ARGV[3]))
if overM or overR then
  if ARGV[7] == '1' then redis.call('SET', KEYS[3], '1', 'PX', ARGV[8]) end
  return {0, cm, cr, pm, pr, 0}
end
if ARGV[6] == '1' then
  redis.call('HINCRBY', KEYS[1], 'm', 1)
  if n > 0 then redis.call('HINCRBY', KEYS[1], 'r', n) end
  redis.call('EXPIRE', KEYS[1], ARGV[5])
end
return {1, cm, cr, pm, pr, 0}
`;

const REDIS_TIMEOUT_MS = 500;
const MAX_LOCAL_KEYS = 50_000;

/** In-process windows and blocks (fallback; also the claim store without Redis). */
const local = {
  windows: new Map<string, { m: number; r: number; expires: number }>(),
  blocks: new Map<string, number>(),
  claims: new Map<string, number>(),
};

/** Tests: forget the in-process counters, blocks and notice claims. */
export function resetSendRateState(): void {
  local.windows.clear();
  local.blocks.clear();
  local.claims.clear();
  lastFallbackLog = 0;
}

function prune(now: number): void {
  if (local.windows.size + local.blocks.size + local.claims.size < MAX_LOCAL_KEYS) return;
  for (const [k, v] of local.windows) if (v.expires <= now) local.windows.delete(k);
  for (const [k, v] of local.blocks) if (v <= now) local.blocks.delete(k);
  for (const [k, v] of local.claims) if (v <= now) local.claims.delete(k);
  if (local.windows.size > MAX_LOCAL_KEYS) local.windows.clear();
}

function redisOf(): SendRateRedis | null {
  const g = globalThis as { __sendRateRedis?: SendRateRedis | null };
  if (g.__sendRateRedis !== undefined) return g.__sendRateRedis;
  return getRedisClient();
}

let lastFallbackLog = 0;
function logFallback(err: unknown): void {
  const now = Date.now();
  if (now - lastFallbackLog < 60_000) return;
  lastFallbackLog = now;
  log.warn({ err }, 'Send rate limit: Redis unavailable — counting in this process only (fail-open across processes)');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`send-rate store timed out after ${ms} ms`)), ms);
    timer.unref?.();
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

interface EvalInput {
  userId: string;
  limits: { messagesPerHour: number; recipientsPerHour: number };
  recipients: number;
  commit: boolean;
  block: boolean;
  now: number;
}
type EvalResult = { code: 0 | 1 | 2; counts: WindowCounts; blockTtlMs: number };

const windowKey = (userId: string, w: number) => `sendrate:${userId}:${w}`;
const blockKey = (userId: string) => `sendrate:block:${userId}`;

function evalLocal(i: EvalInput, windowMs: number): EvalResult {
  prune(i.now);
  const blockedUntil = local.blocks.get(blockKey(i.userId)) ?? 0;
  if (blockedUntil > i.now) return { code: 2, counts: { curM: 0, curR: 0, prevM: 0, prevR: 0 }, blockTtlMs: blockedUntil - i.now };
  const w = Math.floor(i.now / windowMs);
  const read = (k: string) => { const v = local.windows.get(k); return v && v.expires > i.now ? v : { m: 0, r: 0, expires: 0 }; };
  const cur = read(windowKey(i.userId, w));
  const prev = read(windowKey(i.userId, w - 1));
  const counts = { curM: cur.m, curR: cur.r, prevM: prev.m, prevR: prev.r };
  const v = slidingVerdict(counts, i.limits, i.recipients, i.now - w * windowMs, windowMs);
  if (!v.allowed) {
    if (i.block) local.blocks.set(blockKey(i.userId), i.now + SEND_RATE_BLOCK_SEC * 1000);
    return { code: 0, counts, blockTtlMs: 0 };
  }
  if (i.commit) {
    local.windows.set(windowKey(i.userId, w), { m: cur.m + 1, r: cur.r + Math.max(0, i.recipients), expires: (w + 2) * windowMs });
  }
  return { code: 1, counts, blockTtlMs: 0 };
}

async function evalShared(i: EvalInput): Promise<EvalResult> {
  const windowMs = SEND_RATE_WINDOW_SEC * 1000;
  const redis = redisOf();
  if (redis && (redis.status === undefined || redis.status === 'ready')) {
    const w = Math.floor(i.now / windowMs);
    const weight = Math.max(0, 1 - (i.now - w * windowMs) / windowMs);
    try {
      const out = await withTimeout(redis.eval(
        SCRIPT, 3, windowKey(i.userId, w), windowKey(i.userId, w - 1), blockKey(i.userId),
        String(weight), i.limits.messagesPerHour, i.limits.recipientsPerHour, Math.max(0, i.recipients),
        SEND_RATE_WINDOW_SEC * 2 + 60, i.commit ? '1' : '0', i.block ? '1' : '0', SEND_RATE_BLOCK_SEC * 1000,
      ), REDIS_TIMEOUT_MS) as unknown[];
      const n = Array.isArray(out) ? out.map((x) => Number(x)) : [];
      if (n.length < 6 || ![0, 1, 2].includes(n[0]!)) throw new Error('unexpected send-rate script reply');
      return {
        code: n[0] === 1 ? 1 : n[0] === 2 ? 2 : 0,
        counts: { curM: n[1] ?? 0, curR: n[2] ?? 0, prevM: n[3] ?? 0, prevR: n[4] ?? 0 },
        blockTtlMs: n[5] ?? 0,
      };
    } catch (err) {
      logFallback(err);
    }
  } else if (redis) {
    logFallback(new Error(`Redis status ${redis.status ?? 'unknown'}`));
  }
  return evalLocal(i, windowMs);
}

/** First claim of `key` within `ttlSec` across processes (Redis SET NX; in-process without Redis). */
async function claimOnce(key: string, ttlSec: number, now: number): Promise<boolean> {
  const held = local.claims.get(key) ?? 0;
  if (held > now) return false;
  const redis = redisOf();
  if (redis && (redis.status === undefined || redis.status === 'ready')) {
    try {
      const got = await withTimeout(redis.set(key, '1', 'EX', ttlSec, 'NX'), REDIS_TIMEOUT_MS);
      if (got === 'OK') { local.claims.set(key, now + ttlSec * 1000); return true; }
      local.claims.set(key, now + Math.min(ttlSec * 1000, 60_000));
      return false;
    } catch (err) {
      logFallback(err);
    }
  }
  local.claims.set(key, now + ttlSec * 1000);
  return true;
}

// ─── Settings ────────────────────────────────────────────────────────────────

const CACHE_MS = 60_000;
let settingsCache: { settings: SendRateSettings; expires: number } | null = null;

/** Forget the cached settings (called by clearSubmissionLimitsCache). */
export function clearSendRateSettingsCache(): void {
  settingsCache = null;
}

/** The global settings (60 s cache; unreadable → defaults, retried after the TTL). */
export async function loadSendRateSettings(now = Date.now()): Promise<SendRateSettings> {
  if (settingsCache && settingsCache.expires > now) return settingsCache.settings;
  let settings: SendRateSettings;
  try {
    const row = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { sendRateLimitEnabled: true, sendRateMessagesPerHour: true, sendRateRecipientsPerHour: true, sendRateBlockOnExceed: true },
    });
    settings = sendRateSettingsFrom(row);
  } catch {
    settings = sendRateSettingsFrom(null);
  }
  settingsCache = { settings, expires: now + CACHE_MS };
  return settings;
}

// ─── Side effects of a hit limit ─────────────────────────────────────────────

/** What happened, for the notice / audit / attack event. */
export interface SendRateHit {
  userId: string;
  protocol: SendRateProtocol;
  ipAddress?: string;
  reason: 'messages' | 'recipients';
  limit: number;
  messagesPerHour: number;
  recipientsPerHour: number;
  /** sendRateBlockOnExceed was on: the account is blocked for SEND_RATE_BLOCK_SEC. */
  blocked: boolean;
}

export interface SendRateHooks {
  /** true = first claim of `key` within `ttlSec` (one notice per user and hour). */
  claim(key: string, ttlSec: number): Promise<boolean>;
  /** Runs once per claimed hit (audit, attack event, admin notice); must not throw. */
  onLimitHit(hit: SendRateHit): Promise<void>;
}

const defaultHooks: SendRateHooks = {
  claim: (key, ttlSec) => claimOnce(key, ttlSec, Date.now()),
  onLimitHit: (hit) => reportSendRateHit(hit),
};
let hooks: SendRateHooks = defaultHooks;

/** Tests: replace the side effects (null restores the defaults). */
export function setSendRateHooks(h: Partial<SendRateHooks> | null): void {
  hooks = h ? { ...defaultHooks, ...h } : defaultHooks;
}

/** Pure: the German notice to the admins (subject + text). */
export function sendRateNotice(hit: SendRateHit, account: string, productName: string, at = new Date()): { subject: string; bodyText: string } {
  const what = hit.reason === 'messages'
    ? `mehr als ${hit.messagesPerHour} Nachrichten pro Stunde`
    : `mehr als ${hit.recipientsPerHour} Empfänger pro Stunde`;
  const proto: Record<SendRateProtocol, string> = {
    smtp: 'SMTP (Port 587/465)', webmail: 'Webmail / REST-API', activesync: 'ActiveSync', jmap: 'JMAP', mapi: 'Outlook (MAPI)',
  };
  return {
    subject: `Konto ${account} hat das Sendelimit erreicht — möglicherweise kompromittiert`,
    bodyText: [
      `Das Konto ${account} wollte ${what} versenden. ${productName} hat weitere Nachrichten vorübergehend abgelehnt.`,
      '',
      `Zeitpunkt:        ${at.toISOString()}`,
      `Versandweg:       ${proto[hit.protocol]}`,
      `Client-IP:        ${hit.ipAddress || 'unbekannt'}`,
      `Grenzwerte:       ${hit.messagesPerHour} Nachrichten / ${hit.recipientsPerHour} Empfänger pro Stunde`,
      hit.blocked
        ? `Versandsperre:    Das Konto darf ${SEND_RATE_BLOCK_SEC / 60} Minuten lang gar nicht senden.`
        : 'Versandsperre:    nein — sobald das Stundenfenster es zulässt, wird wieder angenommen.',
      '',
      'Ein so hohes Sendeaufkommen deutet oft auf ein kompromittiertes Konto hin (Spam-Versand).',
      'Empfohlen: Passwort zurücksetzen, App-Kennwörter und aktive Sitzungen prüfen bzw. widerrufen,',
      'die Warteschlange auf ausgehende Spam-Nachrichten prüfen.',
      '',
      `Weitere Treffer dieses Kontos werden ${SEND_RATE_NOTICE_SEC / 60} Minuten lang nicht erneut gemeldet.`,
      'Die Grenzwerte stehen in der Verwaltung unter SMTP & Routing → Sendelimit (pro Postfach: Nachrichtenfluss).',
    ].join('\n'),
  };
}

/** The mailbox ids that receive the notice: the admin address when local, else the organisation admins. */
async function noticeMailboxes(adminEmail: string): Promise<string[]> {
  const address = adminEmail.trim().toLowerCase();
  if (address) {
    const spellings = addressVariants(address);
    const [user, shared, alias] = await Promise.all([
      prisma.user.findFirst({ where: { email: { in: spellings }, active: true }, select: { id: true } }),
      prisma.sharedMailbox.findFirst({ where: { email: { in: spellings }, active: true }, select: { id: true } }),
      prisma.emailAlias.findFirst({ where: { address: { in: spellings }, active: true }, select: { targetUserId: true, targetSharedId: true } }),
    ]);
    const userId = user?.id ?? alias?.targetUserId ?? null;
    const sharedId = !userId ? (shared?.id ?? alias?.targetSharedId ?? null) : null;
    const mailbox = userId
      ? await prisma.mailbox.findFirst({ where: { userId }, select: { id: true } })
      : sharedId ? await prisma.mailbox.findFirst({ where: { sharedBoxId: sharedId }, select: { id: true } }) : null;
    if (mailbox) return [mailbox.id];
    log.warn({ adminEmail: address }, 'Send rate notice: the admin address is no local mailbox — notifying the organisation admins');
  }
  const admins = await prisma.user.findMany({
    where: { active: true, role: 'ORGANIZATION_MANAGEMENT' },
    select: { mailbox: { select: { id: true } } },
  });
  return admins.map((a) => a.mailbox?.id).filter((id): id is string => !!id);
}

/** Default onLimitHit: audit entry, AttackEvent, admin notice. Never throws. */
export async function reportSendRateHit(hit: SendRateHit): Promise<void> {
  try {
    const [user, settings] = await Promise.all([
      prisma.user.findUnique({ where: { id: hit.userId }, select: { email: true } }),
      prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { adminEmail: true, publicHostname: true, auditLogEnabled: true } }),
    ]);
    const account = user?.email ?? hit.userId;
    const detail = {
      protocol: hit.protocol, reason: hit.reason, limit: hit.limit,
      messagesPerHour: hit.messagesPerHour, recipientsPerHour: hit.recipientsPerHour, blocked: hit.blocked,
    };

    // Audit (respects the global audit switch like every other non-critical action)
    if (settings?.auditLogEnabled !== false) {
      await prisma.auditLog.create({
        data: {
          actorId: hit.userId, actorEmail: account,
          action: 'mail.send.rate-limited',
          targetType: 'user', targetId: hit.userId, targetName: account,
          ...(hit.ipAddress ? { ipAddress: hit.ipAddress } : {}),
          changes: detail as never,
          success: false,
          errorMsg: `send rate limit exceeded (${hit.reason})`,
        },
      }).catch((err: unknown) => log.error({ err }, 'Send rate audit entry failed'));
    }

    // Attack event (BCP dashboard: live via CHANNEL_ADMIN_ATTACK, history in attack_events)
    const ip = hit.ipAddress ?? '';
    await prisma.attackEvent.create({
      data: { ip, type: 'SEND_RATE_LIMIT', target: account, detail: detail as never, service: hit.protocol },
    }).catch((err: unknown) => log.error({ err }, 'Send rate attack event failed'));
    const redis = redisOf() as unknown as { publish?: (c: string, m: string) => Promise<unknown>; status?: string } | null;
    if (redis?.publish && (redis.status === undefined || redis.status === 'ready')) {
      await redis.publish(CHANNEL_ADMIN_ATTACK, JSON.stringify({
        ip, type: 'SEND_RATE_LIMIT', detail, target: account, service: hit.protocol, timestamp: new Date().toISOString(),
      })).catch(() => undefined);
    }

    // Notice to the organisation admin address
    const productName = await getProductName().catch(() => 'CoreMail');
    const notice = sendRateNotice(hit, account, productName);
    const host = settings?.publicHostname || 'localhost';
    for (const mailboxId of await noticeMailboxes(settings?.adminEmail ?? '')) {
      await notifyMailboxInbox(mailboxId, { fromName: `${productName} Security`, fromAddr: `system@${host}`, ...notice });
    }
  } catch (err) {
    log.error({ err, userId: hit.userId }, 'Send rate limit report failed');
  }
}

// ─── Entry points ────────────────────────────────────────────────────────────

async function evaluate(req: SendRateRequest, commit: boolean, now: number): Promise<SendRateDecision> {
  try {
    const global = await loadSendRateSettings(now);
    if (!global.enabled) return { allowed: true };
    const policy = await loadMailFlowPolicy({ userId: req.userId }).catch(() => null);
    const limits = effectiveSendRate(global, policy);
    const r = await evalShared({
      userId: req.userId, limits, recipients: Math.max(0, Math.floor(req.recipients)), commit, block: global.blockOnExceed, now,
    });
    if (r.code === 1) return { allowed: true };
    if (r.code === 2) {
      return { allowed: false, reason: 'blocked', limit: limits.messagesPerHour, retryAfterSec: Math.max(1, Math.ceil(r.blockTtlMs / 1000)) };
    }
    const windowMs = SEND_RATE_WINDOW_SEC * 1000;
    const elapsed = now - Math.floor(now / windowMs) * windowMs;
    const v = slidingVerdict(r.counts, limits, req.recipients, elapsed, windowMs);
    // The script and this re-evaluation see the same counts; a refusal stays one.
    const reason: 'messages' | 'recipients' = v.allowed ? 'messages' : v.reason;
    const decision: SendRateDecision = global.blockOnExceed
      ? { allowed: false, reason, limit: v.allowed ? limits.messagesPerHour : v.limit, retryAfterSec: SEND_RATE_BLOCK_SEC }
      : { allowed: false, reason, limit: v.allowed ? limits.messagesPerHour : v.limit, retryAfterSec: v.allowed ? 60 : v.retryAfterSec };
    log.warn({ userId: req.userId, protocol: req.protocol, reason, limits, blocked: global.blockOnExceed }, 'Submission refused: send rate limit');
    if (await hooks.claim(`sendrate:notice:${req.userId}`, SEND_RATE_NOTICE_SEC).catch(() => false)) {
      await hooks.onLimitHit({
        userId: req.userId, protocol: req.protocol, ...(req.ipAddress ? { ipAddress: req.ipAddress } : {}),
        reason, limit: decision.limit, messagesPerHour: limits.messagesPerHour, recipientsPerHour: limits.recipientsPerHour,
        blocked: global.blockOnExceed,
      }).catch((err: unknown) => log.error({ err }, 'Send rate limit hook failed'));
    }
    return decision;
  } catch (err) {
    // Never block mail on the limiter's own failure.
    log.error({ err, userId: req.userId }, 'Send rate limit check failed — submission allowed');
    return { allowed: true };
  }
}

/**
 * Counts one submission of `recipients` recipients by `userId` — or refuses it
 * (not counted). Call it right before the message is accepted / queued, after
 * every other check, so a message refused for another reason does not count.
 */
export function consumeSendRate(req: SendRateRequest, now = Date.now()): Promise<SendRateDecision> {
  return evaluate(req, true, now);
}

/**
 * The same verdict without counting — for an early refusal before the message
 * is transferred (SMTP MAIL FROM: `recipients: 0` checks the message count and
 * a block only).
 */
export function peekSendRate(req: SendRateRequest, now = Date.now()): Promise<SendRateDecision> {
  return evaluate(req, false, now);
}
