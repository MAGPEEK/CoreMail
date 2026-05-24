/**
 * Server-Einstellungen aus der Datenbank lesen.
 * Wird von Autodiscover v1 + v2 verwendet, damit URLs im ECP konfigurierbar sind.
 * Fällt auf Umgebungsvariablen zurück, wenn noch kein DB-Eintrag existiert.
 */
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('autodiscover:settings');

export interface ServerConfig {
  ewsUrl: string;
  owaUrl: string;
  easUrl: string;
  autodiscoverBase: string;
  imapHost: string;
  imapPort: number;
  imapSsl: boolean;
  pop3Host: string;
  pop3Port: number;
  pop3Ssl: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  orgName: string;
}

// In-Memory-Cache (60 Sekunden TTL) — vermeidet DB-Abfrage pro Autodiscover-Request
let cache: ServerConfig | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60_000;

function envDefaults(): ServerConfig {
  const hostname = process.env['MAIL_HOSTNAME'] ?? 'mail.local';
  const port = process.env['AUTODISCOVER_HTTP_PORT'] ?? '8080';
  const proto = process.env['MAIL_USE_HTTPS'] === 'true' ? 'https' : 'http';
  const base = `${proto}://${hostname}:${port}`;
  return {
    ewsUrl:          process.env['EWS_URL']          ?? `${base}/EWS/Exchange.asmx`,
    owaUrl:          process.env['OWA_URL']          ?? `${base}/owa/`,
    easUrl:          process.env['EAS_URL']          ?? `${base}/Microsoft-Server-ActiveSync`,
    autodiscoverBase: process.env['AUTODISCOVER_BASE'] ?? base,
    imapHost:        process.env['IMAP_HOSTNAME']    ?? hostname,
    imapPort:        993,
    imapSsl:         true,
    pop3Host:        process.env['IMAP_HOSTNAME']    ?? hostname,
    pop3Port:        995,
    pop3Ssl:         true,
    smtpHost:        process.env['SMTP_HOSTNAME']    ?? hostname,
    smtpPort:        587,
    smtpTls:         true,
    orgName:         'CoreMail',
  };
}

export async function getServerConfig(): Promise<ServerConfig> {
  const now = Date.now();
  if (cache && now < cacheExpiry) return cache;

  try {
    const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    if (settings) {
      cache = {
        ewsUrl:           settings.ewsUrl,
        owaUrl:           settings.owaUrl,
        easUrl:           settings.easUrl,
        autodiscoverBase: settings.autodiscoverBase,
        imapHost:         settings.imapHost,
        imapPort:         settings.imapPort,
        imapSsl:          settings.imapSsl,
        pop3Host:         settings.pop3Host,
        pop3Port:         settings.pop3Port,
        pop3Ssl:          settings.pop3Ssl,
        smtpHost:         settings.smtpHost,
        smtpPort:         settings.smtpPort,
        smtpTls:          settings.smtpTls,
        orgName:          settings.orgName,
      };
      cacheExpiry = now + CACHE_TTL_MS;
      return cache;
    }
  } catch (err) {
    log.warn({ err }, 'Could not read ServerSettings from DB — using env defaults');
  }

  // Fallback: Umgebungsvariablen
  const defaults = envDefaults();
  cache = defaults;
  cacheExpiry = now + CACHE_TTL_MS;
  return defaults;
}

/** Cache invalidieren (nach ECP-Änderungen) */
export function invalidateSettingsCache(): void {
  cache = null;
  cacheExpiry = 0;
}
