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

/** One row of the service_listeners table (only the fields used here). */
export interface ListenerRow {
  service: string;
  port: number;
  ssl: boolean;
  active: boolean;
}

/** Submission ports of the SMTP server (465 implicit TLS, 587 STARTTLS). */
const SUBMISSION_PORTS: readonly number[] = [
  parseInt(process.env['SMTP_PORT_465'] ?? '465', 10),
  parseInt(process.env['SMTP_PORT_587'] ?? '587', 10),
];

/**
 * Pure: the endpoint to announce for one protocol, given the configured
 * (public) port and the listener rows of that protocol.
 *  - No listener row uses the configured port → keep it (a NAT / port mapping
 *    may translate it; nothing contradicts the configuration).
 *  - An ACTIVE row uses it → keep the port, take the listener's TLS mode.
 *  - Only an INACTIVE row uses it (the admin switched that port off) → the
 *    first active listener, implicit TLS preferred; none → keep the setting.
 */
export function endpointForListeners(
  configured: { port: number; ssl: boolean },
  rows: readonly ListenerRow[],
): { port: number; ssl: boolean } {
  const onPort = rows.filter((r) => r.port === configured.port);
  if (onPort.length === 0) return configured;
  const active = onPort.find((r) => r.active);
  if (active) return { port: active.port, ssl: active.ssl };
  const candidates = rows.filter((r) => r.active).sort((a, b) => Number(b.ssl) - Number(a.ssl) || a.port - b.port);
  const pick = candidates[0];
  return pick ? { port: pick.port, ssl: pick.ssl } : configured;
}

/**
 * Pure: aligns the announced IMAP / POP3 / SMTP endpoints with the enabled
 * listeners (BCP → Dienste), so a client is never sent to a switched-off port
 * or told the wrong TLS mode. SMTP only considers submission ports.
 */
export function alignWithListeners(cfg: ServerConfig, rows: readonly ListenerRow[]): ServerConfig {
  const of = (service: string) => rows.filter((r) => r.service === service);
  const imap = endpointForListeners({ port: cfg.imapPort, ssl: cfg.imapSsl }, of('IMAP'));
  const pop3 = endpointForListeners({ port: cfg.pop3Port, ssl: cfg.pop3Ssl }, of('POP3'));
  const smtpRows = of('SMTP_RECEIVE').filter((r) => SUBMISSION_PORTS.includes(r.port));
  const smtp = endpointForListeners({ port: cfg.smtpPort, ssl: cfg.smtpPort === SUBMISSION_PORTS[0] }, smtpRows);
  return {
    ...cfg,
    imapPort: imap.port, imapSsl: imap.ssl,
    pop3Port: pop3.port, pop3Ssl: pop3.ssl,
    smtpPort: smtp.port,
    // a submission listener always requires TLS (implicit on 465, STARTTLS on 587)
    smtpTls: smtp.port === cfg.smtpPort ? cfg.smtpTls : true,
  };
}

async function loadListenerRows(): Promise<ListenerRow[] | null> {
  try {
    return await prisma.serviceListener.findMany({
      where: { service: { in: ['IMAP', 'POP3', 'SMTP_RECEIVE'] } },
      select: { service: true, port: true, ssl: true, active: true },
    });
  } catch (err) {
    log.warn({ err }, 'Could not read the service listeners — announcing the configured ports');
    return null;
  }
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

  const fromSettings: ServerConfig = {
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
  const listeners = await loadListenerRows();
  cache = listeners ? alignWithListeners(fromSettings, listeners) : fromSettings;
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
