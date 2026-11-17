/**
 * Read server settings from the database.
 * Used by Autodiscover v1 + v2 so URLs are configurable in the BCP.
 *
 *  - Fresh install without a ServerSettings row: environment defaults (not cached).
 *  - Database error: the last value read from the database is served (stale) if
 *    there is one; otherwise {@link ServerConfigUnavailableError} is thrown and the
 *    handlers answer 503. The built-in `mail.local` defaults are never served or
 *    cached because of a database error — Outlook would store those hosts in the
 *    profile.
 */
import { prisma, getBranding, brandingDefaults } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('autodiscover:settings');

export interface ServerConfig {
  owaUrl: string;
  easUrl: string;
  autodiscoverBase: string;
  imapHost: string;
  imapPort: number;
  imapSsl: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  // v8.1 (Thunderbird autoconfig / Apple profile): POP3 + the public web endpoint
  pop3Host: string;
  pop3Port: number;
  pop3Ssl: boolean;
  publicHostname: string;
  useHttps: boolean;
  httpPort: number;
  orgName: string;
  /** 9.3 branding product name (Thunderbird autoconfig display name once branded). */
  productName?: string;
}

/** The settings could not be read and nothing was read before (→ HTTP 503). */
export class ServerConfigUnavailableError extends Error {
  constructor(cause: unknown) {
    super('server settings unavailable', { cause });
    this.name = 'ServerConfigUnavailableError';
  }
}

// In-memory cache (60 second TTL) — avoids a DB query per Autodiscover request
let cache: ServerConfig | null = null;
let cacheExpiry = 0;
/** Last value read from the database; served while the database is unreachable. */
let lastGood: ServerConfig | null = null;
const CACHE_TTL_MS = 60_000;
const DEFAULT_IMAPS_PORT = 993;
const DEFAULT_SUBMISSION_PORT = 587;
const DEFAULT_POP3S_PORT = 995;

/**
 * A host-name variable, trimmed; empty or whitespace-only counts as unset (9.1).
 * The Compose files pass optional variables through as `${VAR:-}`, so an unset
 * variable arrives as an empty string and must not replace the default host.
 */
export function envHost(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** Settings used before the setup wizard has created the ServerSettings row. */
export function envDefaults(): ServerConfig {
  const hostname = envHost('MAIL_HOSTNAME') || 'mail.local';
  const port = process.env['AUTODISCOVER_HTTP_PORT'] ?? '8080';
  const proto = process.env['MAIL_USE_HTTPS'] === 'true' ? 'https' : 'http';
  const base = `${proto}://${hostname}:${port}`;
  return {
    owaUrl:          process.env['OWA_URL']          ?? `${base}/owa/`,
    easUrl:          process.env['EAS_URL']          ?? `${base}/Microsoft-Server-ActiveSync`,
    autodiscoverBase: process.env['AUTODISCOVER_BASE'] ?? base,
    imapHost:        envHost('IMAP_HOSTNAME')    || hostname,
    imapPort:        DEFAULT_IMAPS_PORT,
    imapSsl:         true,
    smtpHost:        envHost('SMTP_HOSTNAME')    || hostname,
    smtpPort:        DEFAULT_SUBMISSION_PORT,
    smtpTls:         true,
    pop3Host:        envHost('POP3_HOSTNAME')    || hostname,
    pop3Port:        DEFAULT_POP3S_PORT,
    pop3Ssl:         true,
    publicHostname:  hostname,
    useHttps:        proto === 'https',
    httpPort:        parseInt(port, 10) || 8080,
    orgName:         'CoreMail',
    productName:     brandingDefaults().productName,
  };
}

export async function getServerConfig(now: number = Date.now()): Promise<ServerConfig> {
  if (cache && now < cacheExpiry) return cache;

  let settings;
  try {
    settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
  } catch (err) {
    if (lastGood) {
      log.warn({ err }, 'Could not read ServerSettings — serving the last known settings');
      return lastGood;
    }
    log.error({ err }, 'Could not read ServerSettings and no earlier value is known');
    throw new ServerConfigUnavailableError(err);
  }

  if (!settings) {
    // Fresh install (no settings row yet): environment defaults, re-checked next time.
    return envDefaults();
  }

  cache = {
    owaUrl:           settings.owaUrl,
    easUrl:           settings.easUrl,
    autodiscoverBase: settings.autodiscoverBase,
    imapHost:         settings.imapHost,
    imapPort:         settings.imapPort,
    imapSsl:          settings.imapSsl,
    smtpHost:         settings.smtpHost,
    smtpPort:         settings.smtpPort,
    smtpTls:          settings.smtpTls,
    // `??` fallbacks: rows from partial test fakes may lack the newer fields.
    pop3Host:         settings.pop3Host ?? settings.imapHost,
    pop3Port:         settings.pop3Port ?? DEFAULT_POP3S_PORT,
    pop3Ssl:          settings.pop3Ssl ?? true,
    publicHostname:   settings.publicHostname ?? settings.imapHost,
    useHttps:         settings.useHttps ?? false,
    httpPort:         settings.httpPort ?? 8080,
    orgName:          settings.orgName ?? 'CoreMail',
    productName:      (await getBranding()).productName,
  };
  lastGood = cache;
  cacheExpiry = now + CACHE_TTL_MS;
  return cache;
}

/** Invalidate the cache (after BCP changes). The last known value stays as an outage fallback. */
export function invalidateSettingsCache(): void {
  cache = null;
  cacheExpiry = 0;
}

/** Test helper: forget everything, including the outage fallback. */
export function resetSettingsCacheForTests(): void {
  invalidateSettingsCache();
  lastGood = null;
}
