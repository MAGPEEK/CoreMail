/**
 * 10.5: one recorder for the attack dashboard (table attack_events + the live
 * channel CHANNEL_ADMIN_ATTACK) — used by the shared lockout of every login
 * front door (SMTP, IMAP, POP3, web, JMAP, DAV, ActiveSync, MAPI, MCP,
 * Autodiscover), the connect-time block list refusals and the SMTP limiter.
 *
 * Bounded so a flood never floods the database:
 *  - per client IP at most SECURITY_EVENTS_PER_IP_PER_MIN (10) events per
 *    minute — in this process and, when Redis is up, across all processes
 *    (`secevt:<ip>:<minute>`); further events of that minute are dropped
 *    (sampled, the lockout counters themselves are not affected);
 *  - per process at most SECURITY_EVENTS_PER_MIN (300) events per minute in
 *    total (distributed attacks from many IPs);
 *  - `important` events (locks, automatic blocks) skip the per-IP budget AND
 *    the global one (10.5 review: a flood of ordinary events must never hide a
 *    lock); they still count towards the global budget and have their own,
 *    much higher ceiling (SECURITY_EVENTS_IMPORTANT_PER_MIN, default 10× the
 *    global value) — locks need ≥ 10 failures each, so this only bounds the
 *    database in an extreme distributed attack;
 *  - rows older than ATTACK_EVENT_RETENTION_DAYS (90) are purged
 *    (attack-protection.ts, api-gateway worker).
 *
 * Never throws; recording is fire-and-forget.
 */
import { createLogger, peekRedisClient, CHANNEL_ADMIN_ATTACK } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { isLoopbackIp, normalizeIp, safeAccountLabel } from './mail-auth-core.js';

const log = createLogger('security-events');

export interface SecurityEventInput {
  /** AUTH_BRUTE_FORCE | AUTH_LOCKOUT | AUTH_LOCKED | IP_BLOCKLIST | IP_AUTO_BLOCKED | IP_RATE_LIMIT | … */
  type: string;
  ip: string | null | undefined;
  /** smtp | imap | pop3 | web | jmap | caldav | activesync | mapi | autodiscover | mcp | http */
  protocol: string;
  /** Account (e-mail) the event is about — capped, attacker-supplied text. */
  target?: string | null | undefined;
  detail?: Record<string, unknown> | undefined;
  /** Locks / automatic blocks: skip the per-IP sampling budget. */
  important?: boolean | undefined;
}

export interface SecurityEventRow {
  type: string;
  ip: string;
  protocol: string;
  service: string;
  target: string | null;
  detail: Record<string, unknown>;
  timestamp: string;
}

export interface SecurityEventSink {
  write(row: SecurityEventRow): Promise<void>;
}

/** Shared (cross-process) per-IP counter; returns the count of this minute incl. this event. */
export type SharedSampler = (key: string) => Promise<number>;

export interface SecurityEventRecorderOptions {
  perIpPerMinute?: number;
  globalPerMinute?: number;
  /** 10.5 review: ceiling of `important` events per minute (default 10 × globalPerMinute). */
  importantPerMinute?: number;
  now?: () => number;
  sink: SecurityEventSink;
  /** Cross-process budget (Redis); null = in-process only. */
  shared?: (() => SharedSampler | null) | undefined;
}

export interface SecurityEventRecorder {
  /** Resolves true when the event was written, false when sampled away / failed. */
  record(e: SecurityEventInput): Promise<boolean>;
  stats(): { written: number; dropped: number };
}

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createSecurityEventRecorder(opts: SecurityEventRecorderOptions): SecurityEventRecorder {
  const perIp = opts.perIpPerMinute ?? 10;
  const global = opts.globalPerMinute ?? 300;
  const importantCap = opts.importantPerMinute ?? global * 10;
  const now = opts.now ?? Date.now;
  const perIpCounts = new Map<string, number>();
  let minute = -1;
  let globalCount = 0;
  let importantCount = 0;
  let written = 0;
  let dropped = 0;

  const roll = (m: number): void => {
    if (m !== minute) { minute = m; perIpCounts.clear(); globalCount = 0; importantCount = 0; }
  };

  return {
    async record(e) {
      try {
        const ip = normalizeIp(e.ip ?? '') || '-';
        if (ip !== '-' && isLoopbackIp(ip)) return false; // internal hops are no attack
        const m = Math.floor(now() / 60_000);
        roll(m);
        if (e.important) {
          // 10.5 review: the important flag first — locks are never sampled away by a flood
          if (importantCount >= importantCap) { dropped++; return false; }
          importantCount++;
        } else {
          if (globalCount >= global) { dropped++; return false; }
          const n = (perIpCounts.get(ip) ?? 0) + 1;
          perIpCounts.set(ip, n);
          if (n > perIp) { dropped++; return false; }
          const sampler = opts.shared?.() ?? null;
          if (sampler) {
            const shared = await sampler(`secevt:${ip}:${m}`).catch(() => 0);
            if (shared > perIp) { dropped++; return false; }
          }
        }
        globalCount++;
        const row: SecurityEventRow = {
          type: e.type,
          ip,
          protocol: e.protocol,
          service: e.protocol,
          // 10.5 review: an account label, never raw login text (non-addresses are masked)
          target: safeAccountLabel(e.target ?? null),
          detail: e.detail ?? {},
          timestamp: new Date(now()).toISOString(),
        };
        await opts.sink.write(row);
        written++;
        return true;
      } catch (err) {
        log.warn({ err, type: e.type }, 'security event not recorded');
        return false;
      }
    },
    stats: () => ({ written, dropped }),
  };
}

/** Production sink: attack_events row + live event for the BCP dashboard. */
const defaultSink: SecurityEventSink = {
  async write(row) {
    type DbDetail = Exclude<Parameters<typeof prisma.attackEvent.create>[0]['data']['detail'], undefined>;
    await prisma.attackEvent.create({
      data: {
        type: row.type, ip: row.ip, service: row.service, protocol: row.protocol,
        ...(row.target ? { target: row.target } : {}),
        detail: row.detail as DbDetail,
      },
    });
    const redis = peekRedisClient();
    if (redis) await redis.publish(CHANNEL_ADMIN_ATTACK, JSON.stringify(row)).catch(() => undefined);
  },
};

const redisSampler = (): SharedSampler | null => {
  const redis = peekRedisClient();
  if (!redis) return null;
  return async (key) => {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 120);
    return n;
  };
};

declare global {
  // eslint-disable-next-line no-var
  var __securityEventSink: SecurityEventSink | undefined;
}

let recorder: SecurityEventRecorder | null = null;

function getRecorder(): SecurityEventRecorder {
  recorder ??= createSecurityEventRecorder({
    perIpPerMinute: envInt('SECURITY_EVENTS_PER_IP_PER_MIN', 10),
    globalPerMinute: envInt('SECURITY_EVENTS_PER_MIN', 300),
    importantPerMinute: envInt('SECURITY_EVENTS_IMPORTANT_PER_MIN', envInt('SECURITY_EVENTS_PER_MIN', 300) * 10),
    // Test seam: globalThis.__securityEventSink (checked per write).
    sink: { write: (row) => (globalThis.__securityEventSink ?? defaultSink).write(row) },
    shared: () => (globalThis.__securityEventSink ? null : redisSampler()),
  });
  return recorder;
}

/** Replaces the process-wide recorder (tests). null = rebuild from the environment. */
export function setSecurityEventRecorder(r: SecurityEventRecorder | null): void {
  recorder = r;
}

/** Records one security event (sampled, bounded, fire-and-forget safe). */
export function recordSecurityEvent(e: SecurityEventInput): void {
  void getRecorder().record(e);
}
