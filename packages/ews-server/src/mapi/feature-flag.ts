/**
 * MAPI over HTTP — Feature-Flag (v5.7.0)
 *
 * MAPI/HTTP ist optional und per BCP → Server → „MAPI over HTTP" zuschaltbar
 * (`ServerSettings.mapiHttpEnabled`, Default false). Ist der Schalter aus,
 * liefert `/mapi/*` 404 und Autodiscover annonciert kein mapiHttp-Protokoll,
 * sodass Outlook sich sauber als IMAP-Konto einrichtet.
 *
 * 60s-In-Memory-Cache; der ews-server invalidiert ihn über das Redis-Signal
 * CHANNEL_SETTINGS_RELOAD, das der api-gateway nach jedem Settings-Save sendet.
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
    // Fail-closed: ohne DB kein MAPI (Outlook fällt auf IMAP zurück).
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

/** Express-Gate: 404 solange MAPI/HTTP im BCP deaktiviert ist. */
export async function requireMapiEnabled(_req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await isMapiHttpEnabled()) return next();
  res.status(404).set('Content-Type', 'text/plain').send('MAPI over HTTP is disabled');
}
