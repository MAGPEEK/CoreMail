/**
 * v3.18.36: Zentraler Helper zum Ableiten und Speichern der Server-URLs aus
 * dem `publicHostname`. Wird aus mehreren Stellen aufgerufen:
 *
 *   - `POST /api/v1/setup/complete`           (initiales Setup)
 *   - `POST /api/v1/admin/domains`            (erste Domain anlegen)
 *   - `POST /api/v1/admin/domains/:id/make-primary` (primäre Domain wechseln)
 *   - `PUT  /api/v1/admin/servers/settings`   (Hostname-Änderung im BCP)
 *
 * Microsoft-Spec für Outlook-Autodiscover: `autodiscover.<root-domain>` muss
 * separat erreichbar sein (eigener CNAME). Für `mail.example.com` ist der
 * Autodiscover-Host also `autodiscover.example.com`.
 */
import { prisma } from '@coremail/storage';
import { createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';

const log = createLogger('server-urls');

export interface DerivedUrls {
  ewsUrl:           string;
  owaUrl:           string;
  easUrl:           string;
  autodiscoverBase: string;
  imapHost:         string;
  pop3Host:         string;
  smtpHost:         string;
}

/**
 * URLs aus dem Hostname + TLS-Setup ableiten — KEIN DB-Zugriff.
 */
export function deriveServerUrls(
  publicHostname: string,
  useHttps: boolean,
  httpPort: number,
): DerivedUrls {
  const proto = useHttps ? 'https' : 'http';
  const portSuffix = (useHttps && httpPort === 443) || (!useHttps && httpPort === 80)
    ? ''
    : `:${httpPort}`;
  const base = `${proto}://${publicHostname}${portSuffix}`;

  // Autodiscover muss auf eigener CNAME laufen (Microsoft-Spec):
  //   `autodiscover.<root-domain>` — Outlook sucht IMMER zuerst dort.
  // Beispiele:
  //   mail.example.com    → autodiscover.example.com  (Sub-Domain abschneiden)
  //   example.com         → autodiscover.example.com  (direkt prefix)
  //   autodiscover.x.com  → autodiscover.x.com        (schon korrekt)
  const adHost = (() => {
    const lower = publicHostname.toLowerCase();
    if (lower.startsWith('autodiscover.')) return publicHostname;
    const labels = publicHostname.split('.');
    const rootDomain = labels.length >= 3 ? labels.slice(1).join('.') : publicHostname;
    return `autodiscover.${rootDomain}`;
  })();

  return {
    ewsUrl:           `${base}/EWS/Exchange.asmx`,
    owaUrl:           `${base}/owa/`,
    easUrl:           `${base}/Microsoft-Server-ActiveSync`,
    autodiscoverBase: `${proto}://${adHost}${portSuffix}`,
    imapHost:         publicHostname,
    pop3Host:         publicHostname,
    smtpHost:         publicHostname,
  };
}

/**
 * Idempotenter Sync: Berechnet URLs aus aktuellem `publicHostname` + `useHttps`
 * + `httpPort` in `ServerSettings` und schreibt sie zurück. Wenn URLs schon
 * stimmen, kein Write. Published bei Änderung `coremail:settings:reload`.
 *
 * Rückgabe: true wenn URLs aktualisiert wurden, false sonst.
 */
export async function syncServerUrlsFromHostname(): Promise<boolean> {
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: {
      publicHostname: true,
      useHttps: true,
      httpPort: true,
      ewsUrl: true,
      owaUrl: true,
      easUrl: true,
      autodiscoverBase: true,
      imapHost: true,
      pop3Host: true,
      smtpHost: true,
    },
  });
  if (!s) return false;
  if (!s.publicHostname || s.publicHostname === 'mail.local') {
    log.debug('publicHostname noch leer/default — kein URL-Sync');
    return false;
  }

  const derived = deriveServerUrls(s.publicHostname, s.useHttps, s.httpPort);

  const needsUpdate =
    s.ewsUrl           !== derived.ewsUrl ||
    s.owaUrl           !== derived.owaUrl ||
    s.easUrl           !== derived.easUrl ||
    s.autodiscoverBase !== derived.autodiscoverBase ||
    s.imapHost         !== derived.imapHost ||
    s.pop3Host         !== derived.pop3Host ||
    s.smtpHost         !== derived.smtpHost;

  if (!needsUpdate) return false;

  await prisma.serverSettings.update({
    where: { id: 'singleton' },
    data: derived,
  });
  log.info({ publicHostname: s.publicHostname, ...derived }, 'Server-URLs aus publicHostname neu abgeleitet');

  // Cache-Invalidation an autodiscover + andere Services
  await getRedisClient()
    .publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'urls' }))
    .catch(() => undefined);

  return true;
}

/**
 * Wird beim Anlegen / Wechseln der primären Domain aufgerufen. Setzt
 * `publicHostname` auf `mail.<primary-domain>` wenn er noch leer oder Default
 * ist, und leitet alle URLs daraus ab. Respektiert eine bereits explizit
 * gesetzte Konfiguration (kein Überschreiben falls Admin schon einen anderen
 * Hostname konfiguriert hat).
 *
 * @param primaryDomain die Domain die gerade primary geworden ist (z.B. "example.com")
 * @param force         wenn true, überschreibt auch eine bereits gesetzte publicHostname
 */
export async function syncFromPrimaryDomain(primaryDomain: string, force = false): Promise<void> {
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { publicHostname: true, useHttps: true, httpPort: true },
  });
  if (!s) return;

  const isDefault = !s.publicHostname || s.publicHostname === 'mail.local' || s.publicHostname === '';
  if (!isDefault && !force) {
    log.debug({ publicHostname: s.publicHostname, primaryDomain }, 'publicHostname bereits gesetzt — kein Auto-Update');
    // Trotzdem URLs syncen, falls jemand publicHostname geändert hat ohne URLs zu derive'n
    await syncServerUrlsFromHostname();
    return;
  }

  // Default-Hostname für die Domain ist `mail.<domain>` (Convention)
  const newHostname = `mail.${primaryDomain}`;
  const derived = deriveServerUrls(newHostname, s.useHttps, s.httpPort);

  await prisma.serverSettings.update({
    where: { id: 'singleton' },
    data: {
      publicHostname: newHostname,
      ...derived,
    },
  });
  log.info({ newHostname, primaryDomain, derived }, 'publicHostname + URLs aus erster/neuer primary Domain abgeleitet');

  await getRedisClient()
    .publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'hostname' }))
    .catch(() => undefined);
}
