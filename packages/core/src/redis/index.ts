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
