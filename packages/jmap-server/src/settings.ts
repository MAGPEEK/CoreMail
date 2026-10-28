/**
 * Öffentliche Basis-URL + Limits für die Session-Resource.
 * Quelle: ServerSettings (publicHostname/useHttps/httpPort), Fallback auf
 * Host-Header des Requests. 60s-Cache, Reload über Redis settings:reload.
 */
import type { Request } from 'express';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('jmap:settings');

export { LIMITS, type JmapLimits } from './limits.js';

interface PublicSettings {
  publicHostname: string;
  useHttps: boolean;
  httpPort: number;
  maxMessageSizeMb: number;
}

let cache: PublicSettings | null = null;
let cacheExpiry = 0;

async function loadSettings(): Promise<PublicSettings> {
  const now = Date.now();
  if (cache && now < cacheExpiry) return cache;
  try {
    const s = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { publicHostname: true, useHttps: true, httpPort: true, maxMessageSizeMb: true },
    });
    cache = s ?? { publicHostname: 'mail.local', useHttps: false, httpPort: 8080, maxMessageSizeMb: 25 };
  } catch (err) {
    log.warn({ err }, 'ServerSettings nicht lesbar — Host-Header wird verwendet');
    cache = { publicHostname: 'mail.local', useHttps: false, httpPort: 8080, maxMessageSizeMb: 25 };
  }
  cacheExpiry = now + 60_000;
  return cache;
}

export function invalidateSettingsCache(): void {
  cache = null;
  cacheExpiry = 0;
}

/** Basis-URL ohne trailing slash, z.B. https://mail.example.de */
export async function publicBaseUrl(req: Request): Promise<string> {
  const s = await loadSettings();
  if (s.publicHostname && s.publicHostname !== 'mail.local') {
    // gleiche Regel wie api-gateway/lib/server-urls.ts deriveServerUrls()
    const proto = s.useHttps ? 'https' : 'http';
    const portSuffix = (s.useHttps && s.httpPort === 443) || (!s.useHttps && s.httpPort === 80)
      ? '' : `:${s.httpPort}`;
    return `${proto}://${s.publicHostname}${portSuffix}`;
  }
  // Fallback: aus dem Request (hinter Proxy: X-Forwarded-*)
  const proto = (req.get('X-Forwarded-Proto') ?? req.protocol ?? 'http').split(',')[0]!.trim();
  const host = (req.get('X-Forwarded-Host') ?? req.get('Host') ?? 'localhost').split(',')[0]!.trim();
  return `${proto}://${host}`;
}

export async function maxMessageSizeBytes(): Promise<number> {
  const s = await loadSettings();
  return s.maxMessageSizeMb * 1024 * 1024;
}
