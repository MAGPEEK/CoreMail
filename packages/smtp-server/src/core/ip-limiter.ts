/**
 * SMTP IP Rate Limiter & Brute-Force Lockout
 *
 * Protection goals (MITRE T1110 / OWASP A07):
 *
 * 1. Per-IP connection limit (in-memory)
 *    — Maximum concurrent connections per IP: MAX_CONNS_PER_IP
 *    — Protects against SMTP mail bombing / resource exhaustion (MITRE T1499)
 *
 * 2. Brute-force lockout — v7: shared by all mail protocols
 *    (verifyMailCredentials in @coremail/storage, Redis counters per IP and
 *    per account). Here only the connect-time check remains: a locked IP gets
 *    421 right away instead of a greeting.
 *
 * 3. New-connection rate (in-memory, per IP, sliding window)
 *    — At most NEW_CONN_PER_MIN new connections per minute per IP.
 *    — Protects against SYN flooding of the SMTP stack.
 */

import { getRedisClient, createLogger, CHANNEL_ADMIN_ATTACK } from '@coremail/core';
import { prisma, mailAuthIpLockedFor, isPrivateOrLoopbackIp, normalizeIp as normalizeIpShared } from '@coremail/storage';

const log = createLogger('smtp:ip-limiter');

// ── Configuration ─────────────────────────────────────────────────────────────

/** Maximum concurrent connections per IP */
const MAX_CONNS_PER_IP = parseInt(process.env['SMTP_MAX_CONNS_PER_IP'] ?? '10', 10);

/** Maximum new connections per minute per IP (sliding window) */
const NEW_CONN_PER_MIN = parseInt(process.env['SMTP_NEW_CONN_PER_MIN'] ?? '30', 10);

const RATE_WINDOW_MS = 60_000;

// ── In-memory connection counters ─────────────────────────────────────────────

/** Active connections per IP (currently open sockets) */
const activeConns = new Map<string, number>();

/** New connections per IP: [{timestamp}] — sliding window */
const newConnTimestamps = new Map<string, number[]>();

let lastPrune = 0;

/** Returns the normalized IP (IPv4-mapped IPv6 → IPv4) */
export function normalizeIp(ip: string): string {
  return normalizeIpShared(ip);
}

/** Private / loopback per CIDR (net.BlockList) — 172.32.0.0+ and 172.2.x are public. */
export function isPrivateIp(ip: string): boolean {
  return isPrivateOrLoopbackIp(ip);
}

/**
 * Drops sliding-window entries whose newest timestamp is older than the
 * window, so the map does not grow with every IP that ever connected.
 */
export function pruneConnTimestamps(now = Date.now()): void {
  const windowStart = now - RATE_WINDOW_MS;
  for (const [ip, stamps] of newConnTimestamps) {
    const last = stamps[stamps.length - 1] ?? 0;
    if (last <= windowStart) newConnTimestamps.delete(ip);
  }
  lastPrune = now;
}

/** Number of IPs tracked by the new-connection limiter (tests/metrics). */
export function trackedConnRateIps(): number {
  return newConnTimestamps.size;
}

// ── Connection tracking ───────────────────────────────────────────────────────

/**
 * Checks whether a new connection from this IP is allowed.
 * Returns true if OK, false if it should be rejected.
 */
export function checkAndTrackConnection(rawIp: string, now = Date.now()): boolean {
  const ip = normalizeIp(rawIp);

  // Always allow private / loopback IPs
  if (isPrivateIp(ip)) return true;

  if (now - lastPrune > RATE_WINDOW_MS) pruneConnTimestamps(now);

  // 1. Concurrent-Connection-Limit
  const current = activeConns.get(ip) ?? 0;
  if (current >= MAX_CONNS_PER_IP) {
    log.warn({ ip, current, limit: MAX_CONNS_PER_IP }, 'SMTP: max concurrent connections exceeded');
    return false;
  }

  // 2. New-Connection-Rate (Sliding Window)
  const windowStart = now - RATE_WINDOW_MS;
  const timestamps = (newConnTimestamps.get(ip) ?? []).filter((t) => t > windowStart);
  timestamps.push(now);
  newConnTimestamps.set(ip, timestamps);

  if (timestamps.length > NEW_CONN_PER_MIN) {
    log.warn({ ip, rate: timestamps.length, limit: NEW_CONN_PER_MIN }, 'SMTP: new-connection rate exceeded');
    return false;
  }

  // Increment counters
  activeConns.set(ip, current + 1);
  return true;
}

/** Must be called when a connection is closed. */
export function releaseConnection(rawIp: string): void {
  const ip = normalizeIp(rawIp);
  if (isPrivateIp(ip)) return;
  const current = activeConns.get(ip) ?? 1;
  if (current <= 1) {
    activeConns.delete(ip);
  } else {
    activeConns.set(ip, current - 1);
  }
}

// ── Brute-force auth lockout (shared mail-auth lockout) ───────────────────────

/** Checks whether an IP is currently locked by the shared mail-auth lockout. */
export async function isAuthBanned(rawIp: string): Promise<boolean> {
  const ip = normalizeIp(rawIp);
  const ttl = await mailAuthIpLockedFor(ip);
  if (ttl > 0) {
    log.info({ ip, expiresIn: ttl }, 'SMTP: connection rejected — IP is auth-locked');
    return true;
  }
  return false;
}

/**
 * Reports a failed AUTH for the admin attack dashboard. Counting and lockout
 * happen in verifyMailCredentials — this only publishes the event.
 */
export function reportAuthFailure(rawIp: string, detail: Record<string, unknown>): void {
  const ip = normalizeIp(rawIp);
  if (isPrivateIp(ip)) return;
  void publishAttackEvent(ip, 'AUTH_BRUTE_FORCE', detail);
}

// ── Attack event publisher ────────────────────────────────────────────────────

/**
 * Publishes an attack event to:
 * 1. Redis CHANNEL_ADMIN_ATTACK (for the SSE live dashboard in the BCP)
 * 2. PostgreSQL AttackEvent table (for historical analysis)
 */
async function publishAttackEvent(
  ip: string,
  type: string,
  detail: Record<string, unknown>,
  target?: string,
): Promise<void> {
  try {
    const event = { ip, type, detail, target: target ?? null, service: 'smtp', timestamp: new Date().toISOString() };
    const redis = getRedisClient();
    await redis.publish(CHANNEL_ADMIN_ATTACK, JSON.stringify(event));

    // Persist in DB (fire-and-forget — no await in the critical path)
    type DbDetail = Exclude<Parameters<typeof prisma.attackEvent.create>[0]['data']['detail'], undefined>;
    prisma.attackEvent.create({
      data: { ip, type, ...(target ? { target } : {}), detail: detail as DbDetail, service: 'smtp' },
    }).catch((err) => {
      log.error({ err, ip, type }, 'Failed to persist attack event to DB');
    });
  } catch (err) {
    log.error({ err, ip, type }, 'Failed to publish attack event');
  }
}

/** Publishes a connection rate-limit event (for external callers). */
export function publishConnectionLimitEvent(ip: string, detail: Record<string, unknown>): void {
  void publishAttackEvent(ip, 'IP_RATE_LIMIT', detail);
}
