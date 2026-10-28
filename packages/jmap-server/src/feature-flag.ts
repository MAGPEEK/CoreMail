/**
 * JMAP feature flag (v5.7.1) — analogous to ews-server/mapi/feature-flag.ts.
 * `ServerSettings.jmapEnabled` (default true). Off → /jmap/* and
 * /.well-known/jmap return 404. 60s cache, invalidation via Redis
 * CHANNEL_SETTINGS_RELOAD. Fail-open (the schema default is "on").
 */
import { prisma } from '@coremail/storage';
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
    const s = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { jmapEnabled: true },
    });
    cached = s?.jmapEnabled ?? true;
  } catch (err) {
    log.warn({ err }, 'ServerSettings not readable — JMAP stays enabled (schema default)');
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
