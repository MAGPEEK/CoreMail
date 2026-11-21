/**
 * Let's Encrypt order building blocks shared by the BCP certificates routes
 * (routes/admin/certificates.ts) and the setup wizard's certificate step
 * (routes/setup-followup.ts, 10.6) — one implementation of:
 *
 *   acmeSuggestions() / orderDomains()  host name + autodiscover./autoconfig. when
 *                                 their DNS points here
 *   preflightForServer()          the pre-flight with this server's host name as
 *                                 the DNS reference (+ the external staging test)
 *   requestLetsEncryptCertificate() create the PENDING row and start the issuance
 *                                 (lib/cert-renewal.ts startRenewal, per-cert lock)
 *   activateHttpsCertificate()    serve a certificate on the integrated HTTPS server
 *   acmeTermsOfServiceUrl()       the CA's current terms of service (ACME directory
 *                                 `meta.termsOfService`)
 *
 * No ACME protocol logic lives here — issuance is lib/cert-acme.ts runAcmeIssuance.
 */
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { isDefaultHostname, isPemCurrentlyValid } from './cert-lifecycle.js';
import { getChallengeServing, LE_DIRECTORY, publishTlsReload, runAcmeValidationTest } from './cert-acme.js';
import {
  lookupAddresses, runPreflight, suggestAdditionalSans, type PreflightReport, type SanSuggestion,
} from './acme-preflight.js';
import { startRenewal } from './cert-renewal.js';
import { hasMailService, MAIL_SERVICES, withMailServices } from './protocol-cert-assign.js';

const log = createLogger('admin:certificates');

// ── Names of the order ────────────────────────────────────────────────────────

export interface AcmeSuggestions {
  publicHostname: string | null;
  domain: string | null;
  sans: SanSuggestion[];
  preselectServices: string[];
}

/**
 * 9.3: defaults for a Let's Encrypt order for the public host name — the mail
 * services are preselected, autodiscover.<domain> / autoconfig.<domain> of the
 * primary domain are offered as additional names (`resolvesHere` when their DNS
 * points to this server).
 */
export async function acmeSuggestions(): Promise<AcmeSuggestions> {
  const settings = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { publicHostname: true },
  }).catch(() => null);
  const hostname = (settings?.publicHostname ?? '').trim().toLowerCase();
  if (!hostname || isDefaultHostname(hostname) || !hostname.includes('.')) {
    return { publicHostname: null, domain: null, sans: [], preselectServices: [] };
  }
  const primary = await prisma.domain.findFirst({
    where: { primary: true }, select: { name: true },
  }).catch(() => null);
  const domain = (primary?.name ?? hostname.split('.').slice(1).join('.')).toLowerCase();
  const sans = await suggestAdditionalSans(hostname, domain).catch(() => []);
  return { publicHostname: hostname, domain, sans, preselectServices: [...MAIL_SERVICES] };
}

/**
 * The names of the order: the host name plus the suggested names whose DNS
 * points here — the same decision as the certificates dialog and the dashboard
 * card (admin-panel lib/certificateCard.ts acmeDomains).
 */
export function orderDomains(hostname: string, sans: ReadonlyArray<{ name: string; resolvesHere: boolean }>): string[] {
  const norm = (d: string) => d.trim().toLowerCase().replace(/\.$/, '');
  return [norm(hostname), ...sans.filter((s) => s.resolvesHere).map((s) => norm(s.name))]
    .filter((d, i, a) => d !== '' && a.indexOf(d) === i);
}

// ── Pre-flight ────────────────────────────────────────────────────────────────

/**
 * Let's Encrypt prerequisites for `domains`: DNS (A/AAAA, same address as the
 * server host name), CAA, local serving of /.well-known/acme-challenge/, fetch
 * over the public name (informational) and — `external` — a real validation
 * by the Let's Encrypt STAGING environment (no certificate, no production limits).
 */
export async function preflightForServer(domains: string[], opts: { external: boolean }): Promise<PreflightReport> {
  const settings = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { publicHostname: true },
  }).catch(() => null);
  let serverHost: { hostname: string; ipv4: string[] } | null = null;
  const hostname = settings?.publicHostname?.trim().toLowerCase() ?? '';
  if (hostname && !isDefaultHostname(hostname)) {
    const l = await lookupAddresses(hostname).catch(() => null);
    if (l) serverHost = { hostname, ipv4: l.ipv4 };
  }
  return runPreflight(domains, {
    serving: getChallengeServing({ ttlSeconds: 120 }),
    serverHost,
    ...(opts.external ? { external: (d: string[]) => runAcmeValidationTest(d) } : {}),
  });
}

// ── Order ─────────────────────────────────────────────────────────────────────

export interface LetsEncryptRequest {
  name: string;
  domains: string[];
  /** Contact address of the ACME account (Certificate.acmeEmail — also used by every renewal). */
  email: string;
  services: string[];
  autoRenew: boolean;
  staging: boolean;
}

export type LetsEncryptRequestResult =
  | { ok: true; cert: Record<string, unknown> & { id: string } }
  | { ok: false; error: string; id: string };

/**
 * Creates the certificate as PENDING (the mail services stay on the current
 * certificate until this one is issued — afterAcmeIssued applies it) and starts
 * the issuance in the background (same code path as retry / renewal: per-cert
 * lock, stored staging flag, ERROR with the CA's problem detail on failure).
 * The caller decides whether staging may hold mail services.
 */
export async function requestLetsEncryptCertificate(r: LetsEncryptRequest): Promise<LetsEncryptRequestResult> {
  // One protocol certificate serves SMTP, IMAP and POP3 together.
  const services = withMailServices(r.services, hasMailService(r.services));
  const cert = await prisma.certificate.create({
    data: {
      name: r.name,
      domains: r.domains,
      services,
      type: 'LETSENCRYPT',
      status: 'PENDING',
      acmeEmail: r.email,
      acmeStaging: r.staging,
      autoRenew: r.autoRenew,
    },
  });
  log.info({ id: cert.id, domains: r.domains, staging: r.staging }, 'Let\'s Encrypt certificate requested');
  const failed = await startIssuance(cert.id);
  if (failed) return { ok: false, error: failed, id: cert.id };
  return { ok: true, cert: cert as unknown as Record<string, unknown> & { id: string } };
}

/**
 * Starts the ACME run of an existing Let's Encrypt row (first issuance or a
 * retry after ERROR). Returns null when started, else the reason (the row is
 * then marked ERROR with it).
 */
export async function startIssuance(certId: string): Promise<string | null> {
  try {
    const started = await startRenewal(certId, 'issue');
    if (!started.started) throw new Error(`issuance not started (${started.reason})`);
    return null;
  } catch (err) {
    const msg = `Could not start the issuance: ${err instanceof Error ? err.message : String(err)}`;
    log.error({ err, id: certId }, 'Failed to start ACME issuance');
    await prisma.certificate.update({
      where: { id: certId }, data: { status: 'ERROR', lastError: msg.slice(0, 1000), lastErrorCode: 'unknown' },
    }).catch(() => undefined);
    return msg;
  }
}

// ── HTTPS ─────────────────────────────────────────────────────────────────────

export type ActivateHttpsResult =
  | { ok: true; name: string }
  | { ok: false; reason: 'not-found' | 'no-pem' | 'invalid'; status?: string };

/**
 * Serves this certificate on the integrated HTTPS server (port 443) — and only
 * there: SMTP/IMAP/POP3 (isActiveProtocol) are not touched. Usability is
 * decided by the PEM validity, not by the DB status.
 */
export async function activateHttpsCertificate(id: string): Promise<ActivateHttpsResult> {
  const cert = await prisma.certificate.findUnique({
    where: { id },
    select: { id: true, name: true, status: true, certPem: true, keyPem: true },
  });
  if (!cert) return { ok: false, reason: 'not-found' };
  if (!cert.certPem || !cert.keyPem) return { ok: false, reason: 'no-pem', status: cert.status };
  if (!isPemCurrentlyValid(cert.certPem)) return { ok: false, reason: 'invalid', status: cert.status };
  await prisma.$transaction([
    prisma.certificate.updateMany({ data: { isActiveHttps: false } }),
    prisma.certificate.update({ where: { id }, data: { isActiveHttps: true } }),
  ]);
  // Reload tls-proxy.ts (listens on coremail:tls:reload)
  await publishTlsReload(id);
  log.info({ id, name: cert.name }, 'Certificate activated for HTTPS proxy — protocol TLS unchanged');
  return { ok: true, name: cert.name };
}

// ── Terms of service ──────────────────────────────────────────────────────────

/** Shown when the ACME directory cannot be read: the CA's page listing the current agreement. */
export const LE_REPOSITORY_URL = 'https://letsencrypt.org/repository/';

const TOS_CACHE_MS = 60 * 60_000;
let tosCache: { url: string | null; at: number; directory: string } | null = null;

export type DirectoryFetch = (url: string) => Promise<unknown>;

const defaultDirectoryFetch: DirectoryFetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/**
 * The CA's current terms of service (RFC 8555 §7.1.1 directory `meta.termsOfService`),
 * cached for an hour; null when the directory cannot be read or names no
 * https URL. Production directory unless `staging`.
 */
export async function acmeTermsOfServiceUrl(
  opts: { staging?: boolean; fetchDirectory?: DirectoryFetch; now?: number } = {},
): Promise<string | null> {
  const directory = opts.staging ? LE_DIRECTORY.staging : LE_DIRECTORY.production;
  const now = opts.now ?? Date.now();
  if (!opts.fetchDirectory && tosCache && tosCache.directory === directory && now - tosCache.at < TOS_CACHE_MS) return tosCache.url;
  let url: string | null = null;
  try {
    const dir = await (opts.fetchDirectory ?? defaultDirectoryFetch)(directory) as { meta?: { termsOfService?: unknown } } | null;
    const tos = dir?.meta?.termsOfService;
    if (typeof tos === 'string' && /^https:\/\/[^\s"<>]+$/i.test(tos) && tos.length <= 500) url = tos;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'ACME directory not readable — terms of service link falls back to the repository page');
    if (!opts.fetchDirectory) { tosCache = { url: null, at: now - TOS_CACHE_MS + 60_000, directory }; return null; }
    return null;
  }
  if (!opts.fetchDirectory) tosCache = { url, at: now, directory };
  return url;
}
