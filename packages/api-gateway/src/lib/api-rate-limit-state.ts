/**
 * Current API rate-limit configuration of this process (lib/api-rate-limit.ts):
 * loaded from ServerSettings at start, refreshed every 60 s and right after a save in
 * BCP → Settings → Security.
 */
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { resolveApiRateLimit, type ApiRateLimitConfig } from './api-rate-limit.js';

const log = createLogger('api-rate-limit');

let current: ApiRateLimitConfig = resolveApiRateLimit(null);

export function apiRateLimitConfig(): ApiRateLimitConfig {
  return current;
}

/** Reload from the database; on an error the previous configuration stays in effect. */
export async function reloadApiRateLimitConfig(): Promise<void> {
  try {
    const row = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { apiRateLimitEnabled: true, apiRateLimitWindowMin: true, apiRateLimitPerIp: true, apiRateLimitPerUser: true },
    });
    current = resolveApiRateLimit(row);
  } catch (err) {
    log.warn({ err }, 'API rate-limit settings not readable — keeping the previous values');
  }
}

/** Initial load + periodic refresh (timer does not keep the process alive). */
export function startApiRateLimitRefresh(intervalMs = 60_000): void {
  void reloadApiRateLimitConfig();
  setInterval(() => { void reloadApiRateLimitConfig(); }, intervalMs).unref();
}
