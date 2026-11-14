/**
 * Per-service log level, changeable at runtime from the BCP.
 *
 * api-gateway `PUT /admin/logs/levels` stores `{ <service>: LEVEL }` in the
 * Redis hash `config:log-levels` and publishes the same object on
 * `config:log-levels:updated`. Every service calls `initRuntimeLogLevel()`
 * once at startup: it applies the stored level and follows later updates.
 *
 * Key matching (first hit wins): exact service name (e.g. `smtp-server`),
 * one of the aliases (e.g. `smtp`), then the wildcard keys `*` / `all`.
 */
import type { Redis } from 'ioredis';
import { getRedisClient } from '../redis/index.js';
import { createLogger, normalizeLogLevel, setLogLevel, type RuntimeLogLevel } from './index.js';

export const LOG_LEVELS_HASH = 'config:log-levels';
export const CHANNEL_LOG_LEVELS = 'config:log-levels:updated';

const WILDCARD_KEYS = ['*', 'all'];

/** Pure: the level that applies to `service` from a `{ key: LEVEL }` map, or null. */
export function resolveServiceLogLevel(
  levels: Record<string, unknown>,
  service: string,
  aliases: readonly string[] = [],
): RuntimeLogLevel | null {
  const lower = new Map(Object.entries(levels).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const key of [service, ...aliases, ...WILDCARD_KEYS]) {
    const lvl = normalizeLogLevel(lower.get(key.toLowerCase()));
    if (lvl) return lvl;
  }
  return null;
}

export interface RuntimeLogLevelHandle {
  /** Apply a `{ key: LEVEL }` update; returns the applied level or null. */
  apply(levels: Record<string, unknown>): RuntimeLogLevel | null;
  stop(): Promise<void>;
}

/**
 * Applies the stored level for `service` and subscribes to updates.
 * Never throws — without Redis the env `LOG_LEVEL` simply stays in effect.
 */
export async function initRuntimeLogLevel(
  service: string,
  opts: { aliases?: readonly string[]; redis?: Redis } = {},
): Promise<RuntimeLogLevelHandle> {
  const log = createLogger('log-level');
  const aliases = opts.aliases ?? [];
  const apply = (levels: Record<string, unknown>): RuntimeLogLevel | null => {
    const lvl = resolveServiceLogLevel(levels, service, aliases);
    if (lvl) {
      setLogLevel(lvl);
      log.info({ service, level: lvl }, 'Log level applied');
    }
    return lvl;
  };

  let sub: Redis | null = null;
  try {
    const redis = opts.redis ?? getRedisClient();
    apply(await redis.hgetall(LOG_LEVELS_HASH));
    sub = redis.duplicate();
    sub.on('message', (_channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) apply(parsed as Record<string, unknown>);
      } catch { /* ignore malformed payloads */ }
    });
    await sub.subscribe(CHANNEL_LOG_LEVELS);
  } catch (err) {
    log.warn({ err, service }, 'Runtime log level unavailable — using LOG_LEVEL');
  }

  return {
    apply,
    stop: async () => { if (sub) await sub.quit().catch(() => undefined); },
  };
}
