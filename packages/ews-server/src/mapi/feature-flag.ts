/**
 * MAPI over HTTP + EWS — feature flag (v5.7.0, EWS since v5.8.0)
 *
 * The Outlook "Exchange account" path (MAPI/HTTP including the companion protocols EWS and
 * OAB) is optional and can be enabled via BCP → Server → "MAPI over HTTP + EWS"
 * (`ServerSettings.mapiHttpEnabled`, default false). When the switch is off,
 * `/mapi/*`, `/EWS/*` and `/OAB/*` return 404 and Autodiscover advertises
 * neither mapiHttp nor EWS, so Outlook cleanly sets itself up as an IMAP account.
 *
 * 60s in-memory cache; the ews-server invalidates it via the Redis signal
 * CHANNEL_SETTINGS_RELOAD, which the api-gateway sends after every settings save.
 */
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import type { Request, Response, NextFunction } from 'express';

const log = createLogger('mapi:flag');
const CACHE_TTL_MS = 60_000;
let cached: boolean | null = null;
let cacheExpiry = 0;

export async function isMapiHttpEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cached !== null && now < cacheExpiry) return cached;
  try {
    const s = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { mapiHttpEnabled: true },
    });
    cached = s?.mapiHttpEnabled ?? false;
  } catch (err) {
    // Fail-closed: no MAPI without the DB (Outlook falls back to IMAP).
    log.warn({ err }, 'ServerSettings nicht lesbar — MAPI/HTTP bleibt aus');
    cached = false;
  }
  cacheExpiry = now + CACHE_TTL_MS;
  return cached;
}

export function invalidateMapiFlagCache(): void {
  cached = null;
  cacheExpiry = 0;
}

/** Express gate: 404 as long as "MAPI over HTTP + EWS" is disabled in the BCP. */
export async function requireMapiEnabled(_req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await isMapiHttpEnabled()) return next();
  res.status(404).set('Content-Type', 'text/plain').send('Exchange protocols (MAPI over HTTP / EWS) are disabled');
}
