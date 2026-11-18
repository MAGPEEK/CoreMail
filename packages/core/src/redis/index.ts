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
 * Creates a new Redis connection specifically for BullMQ.
 * BullMQ v5 requires maxRetriesPerRequest: null (blocking commands).
 * ALWAYS returns a new instance (no singleton) — BullMQ manages
 * its connections itself and closes them on worker/queue destroy.
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

/**
 * Closes the shared client. A client that is not connected (connecting /
 * reconnecting to an unreachable server) is disconnected immediately — `quit()`
 * would queue behind the reconnect loop, whose timer keeps the process alive.
 */
export async function closeRedis(): Promise<void> {
  const client = _client;
  if (!client) return;
  _client = null;
  if (client.status === 'ready') {
    await client.quit().catch(() => client.disconnect());
  } else {
    client.disconnect();
  }
}

// Session store helpers
export const SESSION_PREFIX = 'session:';
export const GREYLIST_PREFIX = 'greylist:';
export const MFA_CHALLENGE_PREFIX = 'mfa:challenge:';

export function greylistKey(ip: string, mailFrom: string, rcptTo: string): string {
  const hash = Buffer.from(`${ip}|${mailFrom}|${rcptTo}`).toString('base64url');
  return `${GREYLIST_PREFIX}${hash}`;
}

// Pub/Sub channels
/** New mail delivered (sender/subject for toasts and Web Push). State changes: realtime/events.ts. */
export const CHANNEL_MAIL_NEW = 'mail:new';
export const CHANNEL_ADMIN_EVENT = 'admin:event';
export const CHANNEL_SERVICE_LISTENERS_RELOAD = 'service:listeners:reload';
/** Fired after ServerSettings.publicHostname (or other global settings) change. */
export const CHANNEL_SETTINGS_RELOAD = 'settings:reload';
/** Fired whenever a security attack event is detected (brute-force, relay, DNSBL, etc.). */
export const CHANNEL_ADMIN_ATTACK = 'admin:attack';
