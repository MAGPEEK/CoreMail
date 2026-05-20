/**
 * SMTP IP Rate Limiter & Brute-Force Lockout
 *
 * Schutzziele (MITRE T1110 / OWASP A07):
 *
 * 1. Per-IP-Verbindungslimit (in-memory)
 *    — Maximale gleichzeitige Verbindungen pro IP: MAX_CONNS_PER_IP
 *    — Schützt gegen SMTP Mail-Bombing / Resource-Exhaustion (MITRE T1499)
 *
 * 2. Brute-Force-Lockout (Redis-backed — überlebt SMTP-Neustarts)
 *    — Nach AUTH_FAIL_THRESHOLD fehlgeschlagenen Auth-Versuchen innerhalb AUTH_WINDOW_S Sekunden:
 *      IP wird für AUTH_BAN_S Sekunden gesperrt.
 *    — Schützt Submission-Ports (465/587) vor Credential-Stuffing.
 *
 * 3. New-Connection-Rate (in-memory, pro IP, Sliding Window)
 *    — Maximal NEW_CONN_PER_MIN neue Verbindungen pro Minute pro IP.
 *    — Schützt gegen SYN-Flooding des SMTP-Stacks.
 */

import { getRedisClient, createLogger } from '@coremail/core';

const log = createLogger('smtp:ip-limiter');

// ── Konfiguration ─────────────────────────────────────────────────────────────

/** Maximale gleichzeitige Verbindungen pro IP */
const MAX_CONNS_PER_IP = parseInt(process.env['SMTP_MAX_CONNS_PER_IP'] ?? '10', 10);

/** Maximale neue Verbindungen pro Minute pro IP (Sliding Window) */
const NEW_CONN_PER_MIN = parseInt(process.env['SMTP_NEW_CONN_PER_MIN'] ?? '30', 10);

/** Anzahl Auth-Fehlversuche, bevor eine IP gebannt wird */
const AUTH_FAIL_THRESHOLD = parseInt(process.env['SMTP_AUTH_FAIL_THRESHOLD'] ?? '5', 10);

/** Zeitfenster für Auth-Fehlversuche in Sekunden */
const AUTH_WINDOW_S = parseInt(process.env['SMTP_AUTH_WINDOW_S'] ?? '300', 10); // 5 min

/** Ban-Dauer nach zu vielen Auth-Fehlern in Sekunden */
const AUTH_BAN_S = parseInt(process.env['SMTP_AUTH_BAN_S'] ?? '600', 10); // 10 min

// Redis-Key-Präfix
const KEY_AUTH_FAIL  = 'smtp:authfail:';   // ZSET: IP → score = fail count, TTL
const KEY_AUTH_BAN   = 'smtp:authban:';    // STRING mit TTL

// ── In-Memory-Verbindungszähler ───────────────────────────────────────────────

/** Aktive Verbindungen pro IP (aktuell aufgebaute Sockets) */
const activeConns = new Map<string, number>();

/** Neue Verbindungen pro IP: [{timestamp}] — Sliding Window */
const newConnTimestamps = new Map<string, number[]>();

/** Gibt die normalisierte IP zurück (IPv4-mapped IPv6 → IPv4) */
export function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/, '');
}

// ── Verbindungs-Tracking ──────────────────────────────────────────────────────

/**
 * Prüft, ob eine neue Verbindung von dieser IP erlaubt ist.
 * Gibt true zurück wenn OK, false wenn abzulehnen ist.
 */
export function checkAndTrackConnection(rawIp: string): boolean {
  const ip = normalizeIp(rawIp);

  // Private / Loopback IPs grundsätzlich erlauben
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

  // Zähler erhöhen
  activeConns.set(ip, current + 1);
  return true;
}

/** Muss aufgerufen werden wenn eine Verbindung getrennt wird. */
export function releaseConnection(rawIp: string): void {
  const ip = normalizeIp(rawIp);
  const current = activeConns.get(ip) ?? 1;
  if (current <= 1) {
    activeConns.delete(ip);
  } else {
    activeConns.set(ip, current - 1);
  }
}

// ── Brute-Force Auth-Lockout (Redis-backed) ───────────────────────────────────

/** Prüft, ob eine IP aktuell gebannt ist (zu viele Auth-Fehlversuche). */
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
 * Registriert einen fehlgeschlagenen Auth-Versuch.
 * Wenn der Schwellwert erreicht wird → IP für AUTH_BAN_S sperren.
 */
export async function recordAuthFailure(rawIp: string): Promise<void> {
  const ip = normalizeIp(rawIp);
  if (isPrivateIp(ip)) return;
  try {
    const redis = getRedisClient();
    const key = `${KEY_AUTH_FAIL}${ip}`;

    // Atomare Erhöhung + Ablauf setzen
    const count = await redis.incr(key);
    if (count === 1) {
      // Erstes Fehlschlagen: TTL auf AUTH_WINDOW_S setzen
      await redis.expire(key, AUTH_WINDOW_S);
    }

    log.info({ ip, count, threshold: AUTH_FAIL_THRESHOLD }, 'SMTP: auth failure recorded');

    if (count >= AUTH_FAIL_THRESHOLD) {
      // IP sperren
      const banKey = `${KEY_AUTH_BAN}${ip}`;
      await redis.set(banKey, String(count), 'EX', AUTH_BAN_S);
      // Zähler zurücksetzen (für nächste Runde nach Ban-Ablauf)
      await redis.del(key);
      log.warn({ ip, count, banSeconds: AUTH_BAN_S }, 'SMTP: IP auth-banned');
    }
  } catch (err) {
    log.error({ err, ip }, 'Redis error in recordAuthFailure');
  }
}

/** Löscht den Auth-Fehlzähler nach erfolgreichem Login. */
export async function clearAuthFailures(rawIp: string): Promise<void> {
  const ip = normalizeIp(rawIp);
  if (isPrivateIp(ip)) return;
  try {
    await getRedisClient().del(`${KEY_AUTH_FAIL}${ip}`);
  } catch {
    // non-critical
  }
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

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
