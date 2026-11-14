/**
 * EWS feature flag (v5.7.0 as MAPI flag; gates EWS only since MAPI over HTTP was removed again)
 *
 * Exchange Web Services (`/EWS/*` + `/OAB/*`) are optional and can be enabled
 * via BCP → Server → "Exchange Web Services (EWS)". The switch is stored in the
 * historical DB field `ServerSettings.mapiHttpEnabled` (default false; the name
 * was kept to avoid a destructive schema change). When off, `/EWS/*` and
 * `/OAB/*` return 404 and Autodiscover does not advertise EWS.
 *
 * 60s in-memory cache; the ews-server invalidates it via the Redis signal
 * CHANNEL_SETTINGS_RELOAD, which the api-gateway sends after every settings save.
 */
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import type { Request, Response, NextFunction } from 'express';

const log = createLogger('ews:flag');
const CACHE_TTL_MS = 60_000;
let cached: boolean | null = null;
let cacheExpiry = 0;

export async function isEwsEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cached !== null && now < cacheExpiry) return cached;
  try {
    const s = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { mapiHttpEnabled: true },
    });
    cached = s?.mapiHttpEnabled ?? false;
  } catch (err) {
    // Fail-closed: no EWS without the DB.
    log.warn({ err }, 'ServerSettings not readable — EWS stays off');
    cached = false;
  }
  cacheExpiry = now + CACHE_TTL_MS;
  return cached;
}

export function invalidateEwsFlagCache(): void {
  cached = null;
  cacheExpiry = 0;
}

/** Express gate: 404 as long as "Exchange Web Services (EWS)" is disabled in the BCP. */
export async function requireEwsEnabled(_req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await isEwsEnabled()) return next();
  res.status(404).set('Content-Type', 'text/plain').send('Exchange Web Services (EWS) are disabled');
}
