import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('redis');

let _client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!_client) {
    _client = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    _client.on('connect', () => log.info('Redis connected'));
    _client.on('error', (err) => log.error({ err }, 'Redis error'));
    _client.on('reconnecting', () => log.warn('Redis reconnecting'));
  }
  return _client;
}

/**
 * Erstellt eine neue Redis-Verbindung speziell für BullMQ.
 * BullMQ v5 erfordert maxRetriesPerRequest: null (Blocking-Commands).
 * Gibt IMMER eine neue Instanz zurück (kein Singleton) — BullMQ verwaltet
 * seine Verbindungen selbst und schließt sie beim Worker/Queue-Destroy.
 */
export function createBullMqConnection(): Redis {
  const conn = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
  conn.on('error', (err) => log.error({ err }, 'BullMQ Redis error'));
  return conn;
}

export async function closeRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}

// Session store helpers
export const SESSION_PREFIX = 'session:';
export const GREYLIST_PREFIX = 'greylist:';
export const DNSBL_CACHE_PREFIX = 'dnsbl:';
export const MFA_CHALLENGE_PREFIX = 'mfa:challenge:';

export function sessionKey(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

export function greylistKey(ip: string, mailFrom: string, rcptTo: string): string {
  const hash = Buffer.from(`${ip}|${mailFrom}|${rcptTo}`).toString('base64url');
  return `${GREYLIST_PREFIX}${hash}`;
}

export function mfaChallengeKey(userId: string): string {
  return `${MFA_CHALLENGE_PREFIX}${userId}`;
}

// Pub/Sub channels
export const CHANNEL_MAIL_NEW = 'mail:new';
export const CHANNEL_MAIL_UPDATE = 'mail:update';
export const CHANNEL_CALENDAR_UPDATE = 'calendar:update';
export const CHANNEL_ADMIN_EVENT = 'admin:event';
export const CHANNEL_SERVICE_LISTENERS_RELOAD = 'service:listeners:reload';
/** Fired after ServerSettings.publicHostname (or other global settings) change. */
export const CHANNEL_SETTINGS_RELOAD = 'settings:reload';
/** Fired whenever a security attack event is detected (brute-force, relay, DNSBL, etc.). */
export const CHANNEL_ADMIN_ATTACK = 'admin:attack';
/** Fired on calendar-share lifecycle changes (create/update/delete/self_remove). v3.18.17 */
export const CHANNEL_CALENDAR_SHARES = 'calendar:shares';
