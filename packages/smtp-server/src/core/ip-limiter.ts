/**
 * SMTP IP Rate Limiter & Brute-Force Lockout
 *
 * Protection goals (MITRE T1110 / OWASP A07):
 *
 * 1. Per-IP connection limit (in-memory)
 *    — Maximum concurrent connections per IP: MAX_CONNS_PER_IP
 *    — Protects against SMTP mail bombing / resource exhaustion (MITRE T1499)
 *
 * 2. Brute-force lockout (Redis-backed — survives SMTP restarts)
 *    — After AUTH_FAIL_THRESHOLD failed auth attempts within AUTH_WINDOW_S seconds:
 *      the IP is banned for AUTH_BAN_S seconds.
 *    — Protects submission ports (465/587) against credential stuffing.
 *
 * 3. New-connection rate (in-memory, per IP, sliding window)
 *    — At most NEW_CONN_PER_MIN new connections per minute per IP.
 *    — Protects against SYN flooding of the SMTP stack.
 */

import { getRedisClient, createLogger, CHANNEL_ADMIN_ATTACK } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log = createLogger('smtp:ip-limiter');

// ── Configuration ─────────────────────────────────────────────────────────────

/** Maximum concurrent connections per IP */
const MAX_CONNS_PER_IP = parseInt(process.env['SMTP_MAX_CONNS_PER_IP'] ?? '10', 10);

/** Maximum new connections per minute per IP (sliding window) */
const NEW_CONN_PER_MIN = parseInt(process.env['SMTP_NEW_CONN_PER_MIN'] ?? '30', 10);

/** Number of failed auth attempts before an IP is banned */
const AUTH_FAIL_THRESHOLD = parseInt(process.env['SMTP_AUTH_FAIL_THRESHOLD'] ?? '5', 10);

/** Time window for failed auth attempts in seconds */
const AUTH_WINDOW_S = parseInt(process.env['SMTP_AUTH_WINDOW_S'] ?? '300', 10); // 5 min

/** Ban duration after too many auth failures in seconds */
const AUTH_BAN_S = parseInt(process.env['SMTP_AUTH_BAN_S'] ?? '600', 10); // 10 min

// Redis key prefixes
const KEY_AUTH_FAIL  = 'smtp:authfail:';   // ZSET: IP → score = fail count, TTL
const KEY_AUTH_BAN   = 'smtp:authban:';    // STRING with TTL

// ── In-memory connection counters ─────────────────────────────────────────────

/** Active connections per IP (currently open sockets) */
const activeConns = new Map<string, number>();

/** New connections per IP: [{timestamp}] — sliding window */
const newConnTimestamps = new Map<string, number[]>();

/** Returns the normalized IP (IPv4-mapped IPv6 → IPv4) */
export function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/, '');
}

// ── Connection tracking ───────────────────────────────────────────────────────

/**
 * Checks whether a new connection from this IP is allowed.
 * Returns true if OK, false if it should be rejected.
 */
export function checkAndTrackConnection(rawIp: string): boolean {
  const ip = normalizeIp(rawIp);

  // Always allow private / loopback IPs
  if (isPrivateIp(ip)) return true;

  // 1. Concurrent-Connection-Limit
  const current = activeConns.get(ip) ?? 0;
  if (current >= MAX_CONNS_PER_IP) {
    log.warn({ ip, current, limit: MAX_CONNS_PER_IP }, 'SMTP: max concurrent connections exceeded');
    return false;
  }

  // 2. New-Connection-Rate (Sliding Window)
  const now = Date.now();
  const windowStart = now - 60_000;
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
  const current = activeConns.get(ip) ?? 1;
  if (current <= 1) {
    activeConns.delete(ip);
  } else {
    activeConns.set(ip, current - 1);
  }
}

// ── Brute-force auth lockout (Redis-backed) ───────────────────────────────────

/** Checks whether an IP is currently banned (too many failed auth attempts). */
export async function isAuthBanned(rawIp: string): Promise<boolean> {
  const ip = normalizeIp(rawIp);
  if (isPrivateIp(ip)) return false;
  try {
    const banned = await getRedisClient().get(`${KEY_AUTH_BAN}${ip}`);
    if (banned) {
      log.info({ ip, expiresIn: banned }, 'SMTP: connection rejected — IP is auth-banned');
      return true;
    }
    return false;
  } catch (err) {
    log.error({ err, ip }, 'Redis error in isAuthBanned — failing open');
    return false;
  }
}

/**
 * Records a failed auth attempt.
 * When the threshold is reached → ban the IP for AUTH_BAN_S.
 */
export async function recordAuthFailure(rawIp: string): Promise<void> {
  const ip = normalizeIp(rawIp);
  if (isPrivateIp(ip)) return;
  try {
    const redis = getRedisClient();
    const key = `${KEY_AUTH_FAIL}${ip}`;

    // Atomic increment + set expiry
    const count = await redis.incr(key);
    if (count === 1) {
      // First failure: set TTL to AUTH_WINDOW_S
      await redis.expire(key, AUTH_WINDOW_S);
    }

    log.info({ ip, count, threshold: AUTH_FAIL_THRESHOLD }, 'SMTP: auth failure recorded');

    // Store + broadcast attack event
    void publishAttackEvent(ip, 'AUTH_BRUTE_FORCE', { count, threshold: AUTH_FAIL_THRESHOLD });

    if (count >= AUTH_FAIL_THRESHOLD) {
      // Ban IP
      const banKey = `${KEY_AUTH_BAN}${ip}`;
      await redis.set(banKey, String(count), 'EX', AUTH_BAN_S);
      // Reset counter (for the next round after the ban expires)
      await redis.del(key);
      log.warn({ ip, count, banSeconds: AUTH_BAN_S }, 'SMTP: IP auth-banned');
      void publishAttackEvent(ip, 'AUTH_BRUTE_FORCE', { count, banSeconds: AUTH_BAN_S, banned: true });
    }
  } catch (err) {
    log.error({ err, ip }, 'Redis error in recordAuthFailure');
  }
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

/** Clears the auth failure counter after a successful login. */
export async function clearAuthFailures(rawIp: string): Promise<void> {
  const ip = normalizeIp(rawIp);
  if (isPrivateIp(ip)) return;
  try {
    await getRedisClient().del(`${KEY_AUTH_FAIL}${ip}`);
  } catch {
    // non-critical
  }
}

// ── Helper functions ──────────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.16.') ||
    ip.startsWith('172.17.') ||
    ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') ||
    ip.startsWith('172.2') ||
    ip.startsWith('172.30.') ||
    ip.startsWith('172.31.')
  );
}
