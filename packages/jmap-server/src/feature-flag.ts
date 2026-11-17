/**
 * JMAP service switch (v5.7.1, 9.4).
 * `ServerSettings.jmapEnabled` (default true) is the server level of the JMAP
 * protocol switch. The service answers /jmap/* and /.well-known/jmap with 404
 * only while JMAP is off at the server level AND no domain/user switch turns it
 * on; otherwise the per-account switch is checked after authentication (403).
 * 60s cache, invalidation via Redis CHANNEL_SETTINGS_RELOAD (published on every
 * protocol switch change). Fail-open (the schema default is "on").
 */
import { protocolEnabledAnywhere } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import type { Request, Response, NextFunction } from 'express';

const log = createLogger('jmap:flag');
const CACHE_TTL_MS = 60_000;
let cached: boolean | null = null;
let cacheExpiry = 0;

export async function isJmapEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cached !== null && now < cacheExpiry) return cached;
  try {
    cached = await protocolEnabledAnywhere('jmap');
  } catch (err) {
    log.warn({ err }, 'Protocol switches not readable — JMAP stays enabled (schema default)');
    cached = true;
  }
  cacheExpiry = now + CACHE_TTL_MS;
  return cached;
}

export function invalidateJmapFlagCache(): void {
  cached = null;
  cacheExpiry = 0;
}

export async function requireJmapEnabled(_req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await isJmapEnabled()) return next();
  res.status(404).type('text/plain').send('JMAP is disabled');
}
