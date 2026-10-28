/**
 * v3.18.36: central helper for deriving and storing the server URLs from
 * `publicHostname`. Called from several places:
 *
 *   - `POST /api/v1/setup/complete`           (initial setup)
 *   - `POST /api/v1/admin/domains`            (create first domain)
 *   - `POST /api/v1/admin/domains/:id/make-primary` (change primary domain)
 *   - `PUT  /api/v1/admin/servers/settings`   (hostname change in BCP)
 *
 * Microsoft spec for Outlook Autodiscover: `autodiscover.<root-domain>` must
 * be reachable separately (own CNAME). For `mail.example.com` the
 * Autodiscover host is therefore `autodiscover.example.com`.
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
 * Derive URLs from hostname + TLS setup — NO DB access.
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

  // Autodiscover must run on its own CNAME (Microsoft spec):
  //   `autodiscover.<root-domain>` — Outlook ALWAYS looks there first.
  // Examples:
  //   mail.example.com    → autodiscover.example.com  (strip sub-domain)
  //   example.com         → autodiscover.example.com  (direct prefix)
  //   autodiscover.x.com  → autodiscover.x.com        (already correct)
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
 * Idempotent sync: computes URLs from the current `publicHostname` + `useHttps`
 * + `httpPort` in `ServerSettings` and writes them back. If the URLs are already
 * correct, no write. Publishes `coremail:settings:reload` on change.
 *
 * Returns: true if URLs were updated, false otherwise.
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
    log.debug('publicHostname still empty/default — skipping URL sync');
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
  log.info({ publicHostname: s.publicHostname, ...derived }, 'Server URLs re-derived from publicHostname');

  // Cache invalidation for autodiscover + other services
  await getRedisClient()
    .publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'urls' }))
    .catch(() => undefined);

  return true;
}

/**
 * Called when creating / changing the primary domain. Sets `publicHostname`
 * to `mail.<primary-domain>` if it is still empty or the default, and
 * derives all URLs from it. Respects an already explicitly set
 * configuration (no overwrite if the admin has already configured a
 * different hostname).
 *
 * @param primaryDomain the domain that just became primary (e.g. "example.com")
 * @param force         if true, also overwrites an already set publicHostname
 */
export async function syncFromPrimaryDomain(primaryDomain: string, force = false): Promise<void> {
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { publicHostname: true, useHttps: true, httpPort: true },
  });
  if (!s) return;

  const isDefault = !s.publicHostname || s.publicHostname === 'mail.local' || s.publicHostname === '';
  if (!isDefault && !force) {
    log.debug({ publicHostname: s.publicHostname, primaryDomain }, 'publicHostname already set — no auto-update');
    // Still sync URLs in case someone changed publicHostname without deriving the URLs
    await syncServerUrlsFromHostname();
    return;
  }

  // Default hostname for the domain is `mail.<domain>` (convention)
  const newHostname = `mail.${primaryDomain}`;
  const derived = deriveServerUrls(newHostname, s.useHttps, s.httpPort);

  await prisma.serverSettings.update({
    where: { id: 'singleton' },
    data: {
      publicHostname: newHostname,
      ...derived,
    },
  });
  log.info({ newHostname, primaryDomain, derived }, 'publicHostname + URLs derived from first/new primary domain');

  await getRedisClient()
    .publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'hostname' }))
    .catch(() => undefined);
}
