/**
 * Certificate lifecycle — pure helpers (no Prisma / Redis imports, unit-testable).
 *
 * Used by the admin certificates router, the renewal scheduler
 * (lib/cert-renewal.ts) and the integrated HTTPS proxy (tls-proxy.ts).
 */
import { X509Certificate } from 'node:crypto';

/** Mirrors the Prisma enum CertStatus without importing @prisma/client. */
export type CertStatus = 'PENDING' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'ERROR' | 'RENEWING';

const DAY_MS = 24 * 3600 * 1000;

/** A certificate counts as EXPIRING (and is renewed) when ≤ this many days remain. */
export const RENEW_BEFORE_DAYS = 30;

/** Hostnames that are considered "never configured" (schema defaults / self-signed fallbacks). */
const DEFAULT_HOSTNAMES = new Set(['', 'mail.local', 'mail.localhost', 'localhost']);

export interface CertValidity { validFrom: Date; validTo: Date }

/** Parses notBefore/notAfter from a PEM certificate. Returns null for missing/invalid PEM. */
export function parseCertValidity(certPem: string | null | undefined): CertValidity | null {
  if (!certPem) return null;
  try {
    const x509 = new X509Certificate(certPem);
    const validFrom = new Date(x509.validFrom);
    const validTo   = new Date(x509.validTo);
    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) return null;
    return { validFrom, validTo };
  } catch {
    return null;
  }
}

/** True when the PEM parses and `now` lies inside [notBefore, notAfter]. */
export function isPemCurrentlyValid(certPem: string | null | undefined, now: Date = new Date()): boolean {
  const v = parseCertValidity(certPem);
  if (!v) return false;
  const t = now.getTime();
  return v.validFrom.getTime() <= t && t <= v.validTo.getTime();
}

/** ACTIVE / EXPIRING (≤ RENEW_BEFORE_DAYS left) / EXPIRED from the expiry date; PENDING without one. */
export function deriveCertStatus(
  validTo: Date | null | undefined,
  now: Date = new Date(),
  expiringDays: number = RENEW_BEFORE_DAYS,
): CertStatus {
  if (!validTo) return 'PENDING';
  const expMs = validTo.getTime();
  const nowMs = now.getTime();
  if (expMs <= nowMs)                          return 'EXPIRED';
  if (expMs <= nowMs + expiringDays * DAY_MS)  return 'EXPIRING';
  return 'ACTIVE';
}

/**
 * Status recomputation for the periodic check. Only "settled" states are
 * touched — PENDING/RENEWING belong to a running ACME process and ERROR keeps
 * its lastError visible until a renewal succeeds.
 */
export function recomputeStatus(
  current: CertStatus,
  validTo: Date | null | undefined,
  now: Date = new Date(),
): CertStatus {
  if (current !== 'ACTIVE' && current !== 'EXPIRING' && current !== 'EXPIRED') return current;
  if (!validTo) return current;
  return deriveCertStatus(validTo, now);
}

// ── Renewal decision ─────────────────────────────────────────────────────────

export interface RenewalCandidate {
  id: string;
  type: string;            // CertType: LETSENCRYPT | CUSTOM | SELF_SIGNED
  status: CertStatus;
  autoRenew: boolean;
  acmeEmail: string | null;
  domains: string[];
  certPem: string | null;
  expiresAt: Date | null;
}

export interface RenewalBackoff {
  /** Consecutive failed renewal attempts. */
  failures: number;
  /** Time of the last failed attempt (ms since epoch). */
  lastFailureAt: number;
}

/** Backoff after a failed renewal: 2h, 4h, 8h, 16h, then capped at 24h. */
export const BACKOFF_BASE_MS = 2 * 3600 * 1000;
export const BACKOFF_MAX_MS  = 24 * 3600 * 1000;

export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

export function nextAttemptAt(backoff: RenewalBackoff | null): number {
  if (!backoff || backoff.failures <= 0) return 0;
  return backoff.lastFailureAt + backoffDelayMs(backoff.failures);
}

export type RenewalDecision =
  | { renew: true; reason: 'due'; daysLeft: number }
  | { renew: false; reason:
      'not-letsencrypt' | 'auto-renew-off' | 'no-acme-email' | 'no-domains'
      | 'in-progress' | 'not-due' | 'backoff' | 'locked' | 'no-expiry';
      daysLeft?: number; retryAt?: number };

/**
 * Decides whether the scheduler should renew a certificate now.
 * Expiry comes from the PEM (authoritative) with the DB `expiresAt` as fallback.
 */
export function decideRenewal(
  cert: RenewalCandidate,
  opts: { now?: Date; backoff?: RenewalBackoff | null; lockHeld?: boolean; renewBeforeDays?: number } = {},
): RenewalDecision {
  const now = opts.now ?? new Date();
  const renewBeforeDays = opts.renewBeforeDays ?? RENEW_BEFORE_DAYS;

  if (cert.type !== 'LETSENCRYPT') return { renew: false, reason: 'not-letsencrypt' };
  if (!cert.autoRenew)             return { renew: false, reason: 'auto-renew-off' };
  if (!cert.acmeEmail)             return { renew: false, reason: 'no-acme-email' };
  if (cert.domains.length === 0)   return { renew: false, reason: 'no-domains' };
  if (cert.status === 'PENDING' || cert.status === 'RENEWING') return { renew: false, reason: 'in-progress' };
  if (opts.lockHeld)               return { renew: false, reason: 'locked' };

  const validTo = parseCertValidity(cert.certPem)?.validTo ?? cert.expiresAt;
  if (!validTo) return { renew: false, reason: 'no-expiry' };
  const daysLeft = (validTo.getTime() - now.getTime()) / DAY_MS;
  if (daysLeft > renewBeforeDays) return { renew: false, reason: 'not-due', daysLeft };

  const retryAt = nextAttemptAt(opts.backoff ?? null);
  if (retryAt > now.getTime()) return { renew: false, reason: 'backoff', daysLeft, retryAt };

  return { renew: true, reason: 'due', daysLeft };
}

// ── publicHostname rule ──────────────────────────────────────────────────────

export function isDefaultHostname(hostname: string | null | undefined): boolean {
  return DEFAULT_HOSTNAMES.has((hostname ?? '').trim().toLowerCase());
}

/**
 * Returns the hostname to store in ServerSettings.publicHostname when a cert
 * is applied to SMTP/IMAP/POP3, or null to leave it unchanged.
 * Only an unconfigured (default) hostname is replaced, and never on renewal.
 */
export function hostnameUpdateFor(
  currentHostname: string | null | undefined,
  domains: string[],
  opts: { isRenewal: boolean },
): string | null {
  if (opts.isRenewal) return null;
  if (!isDefaultHostname(currentHostname)) return null;
  const primary = domains.find(d => !d.startsWith('*') && !isDefaultHostname(d));
  return primary ?? null;
}

// ── HTTPS proxy cert selection ───────────────────────────────────────────────

export interface ProxyCertRow {
  id: string;
  name: string;
  certPem: string | null;
  keyPem: string | null;
  chainPem: string | null;
  domains: string[];
  isActiveHttps: boolean;
  createdAt?: Date;
  /** Let's Encrypt staging certificate (untrusted) — never preferred over a trusted one. */
  acmeStaging?: boolean;
}

export interface SelectedProxyCert extends ProxyCertRow {
  certPem: string;
  keyPem: string;
  validFrom: Date;
  validTo: Date;
}

/**
 * Selects every certificate whose PEM is currently valid — regardless of its
 * DB status (EXPIRING / RENEWING / ERROR with a still-valid PEM keep serving).
 * Result is ordered newest first (notBefore, then createdAt) so the newest
 * certificate wins on a hostname conflict — except that Let's Encrypt staging
 * (test, untrusted) certificates always come after the trusted ones (9.2.x:
 * a staging test must not replace a working certificate in browsers).
 */
export function selectProxyCerts(rows: ProxyCertRow[], now: Date = new Date()): SelectedProxyCert[] {
  const out: SelectedProxyCert[] = [];
  for (const r of rows) {
    if (!r.certPem || !r.keyPem) continue;
    const v = parseCertValidity(r.certPem);
    if (!v) continue;
    const t = now.getTime();
    if (v.validFrom.getTime() > t || v.validTo.getTime() < t) continue;
    out.push({ ...r, certPem: r.certPem, keyPem: r.keyPem, validFrom: v.validFrom, validTo: v.validTo });
  }
  out.sort((a, b) =>
    (Number(!!a.acmeStaging) - Number(!!b.acmeStaging)) ||
    (b.validFrom.getTime() - a.validFrom.getTime()) ||
    ((b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)));
  return out;
}

/**
 * HTTPS proxy (w1): unreadable private keys removed certificates from the SNI map
 * and none is left — port 443 would stop serving TLS. The self-signed replacement
 * for the public host name is served instead.
 */
export function needsHttpsReplacement(usableCount: number, unreadableKeys: number): boolean {
  return usableCount === 0 && unreadableKeys > 0;
}

/**
 * The self-signed replacement (storage selfSignedReplacement) as the only, default
 * proxy certificate. Not marked isActiveHttps: no HTTP → HTTPS redirect to an
 * untrusted certificate. Null when its PEM cannot be parsed.
 */
export function replacementProxyCert(
  r: { certPem: string; keyPem: string; hostname: string; certId?: string; certName?: string },
  now: Date = new Date(),
): SelectedProxyCert | null {
  const v = parseCertValidity(r.certPem);
  if (!v) return null;
  return {
    id: r.certId ?? `self-signed-replacement:${r.hostname}`,
    name: r.certName ?? `${r.hostname} (self-signed replacement)`,
    certPem: r.certPem,
    keyPem: r.keyPem,
    chainPem: null,
    domains: [r.hostname],
    isActiveHttps: false,
    createdAt: now,
    acmeStaging: false,
    validFrom: v.validFrom,
    validTo: v.validTo,
  };
}

const PEM_CERT_RE =/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Leaf + intermediates as one PEM (what TLS servers must send). Certificates
 * from `chainPem` that are not already part of `certPem` are appended — an
 * uploaded certificate with a separate chain used to be served without its
 * intermediates on SMTP/IMAP/POP3 (and relied on `ca` for HTTPS).
 */
export function buildFullChainPem(certPem: string, chainPem: string | null | undefined): string {
  if (!chainPem) return certPem;
  const norm = (s: string) => s.replace(/\s+/g, '');
  const have = new Set((certPem.match(PEM_CERT_RE) ?? []).map(norm));
  const extra = (chainPem.match(PEM_CERT_RE) ?? []).filter((c) => !have.has(norm(c)));
  if (extra.length === 0) return certPem;
  return `${certPem.trimEnd()}\n${extra.join('\n')}\n`;
}

/** Host name covered by a certificate name (exact, or `*.` wildcard for exactly one label). */
function nameCovers(certName: string, host: string): boolean {
  const n = certName.toLowerCase();
  const h = host.toLowerCase();
  if (n === h) return true;
  if (n.startsWith('*.')) {
    const suffix = n.slice(1);
    if (!h.endsWith(suffix)) return false;
    const prefix = h.slice(0, -suffix.length);
    return prefix.length > 0 && !prefix.includes('.');
  }
  return false;
}

/** Domains the certificate (CN + DNS SANs) does not cover; [] when all are covered. */
export function uncoveredDomains(certPem: string, domains: string[]): string[] {
  const names = extractCertHostnames(certPem);
  return domains.filter((d) => !names.some((n) => nameCovers(n, d) || n === d.toLowerCase()));
}

/** Extracts DNS names (CN + SAN DNS entries), lowercased, without duplicates. */
export function extractCertHostnames(certPem: string): string[] {
  try {
    const x509 = new X509Certificate(certPem);
    const hostnames = new Set<string>();
    const cnMatch = /CN=([^,/\n]+)/i.exec(x509.subject);
    if (cnMatch?.[1]) hostnames.add(cnMatch[1].trim().toLowerCase());
    const san = x509.subjectAltName;
    if (san) {
      for (const part of san.split(',')) {
        const [type, value] = part.trim().split(':');
        if (type?.trim().toUpperCase() === 'DNS' && value) hostnames.add(value.trim().toLowerCase());
      }
    }
    return Array.from(hostnames);
  } catch {
    return [];
  }
}

export interface SniPlan {
  /** exact hostname → cert id */
  exact: Map<string, string>;
  /** wildcard suffix ('.example.com') → cert id, in priority order */
  wildcards: Array<{ suffix: string; certId: string }>;
  /** default cert id (isActiveHttps, else newest) */
  defaultId: string | null;
}

/**
 * Builds the SNI assignment from certificates ordered newest first
 * (see selectProxyCerts): the first certificate claiming a hostname wins.
 */
export function planSni(certs: Array<Pick<SelectedProxyCert, 'id' | 'certPem' | 'domains' | 'isActiveHttps'>>): SniPlan {
  const exact = new Map<string, string>();
  const wildcards: SniPlan['wildcards'] = [];
  const seenWildcards = new Set<string>();
  let defaultId: string | null = null;

  for (const cert of certs) {
    const names = new Set<string>([
      ...extractCertHostnames(cert.certPem),
      ...cert.domains.map(d => d.toLowerCase()),
    ]);
    for (const name of names) {
      if (name.startsWith('*.')) {
        const suffix = name.slice(1);
        if (!seenWildcards.has(suffix)) { seenWildcards.add(suffix); wildcards.push({ suffix, certId: cert.id }); }
      } else if (!exact.has(name)) {
        exact.set(name, cert.id);
      }
    }
    if (cert.isActiveHttps && !defaultId) defaultId = cert.id;
  }
  if (!defaultId && certs[0]) defaultId = certs[0].id;
  return { exact, wildcards, defaultId };
}

/** Resolves an SNI server name against a plan: exact → wildcard (one label) → default. */
export function resolveSni(plan: SniPlan, servername: string): string | null {
  const lower = servername.toLowerCase();
  const exact = plan.exact.get(lower);
  if (exact) return exact;
  for (const w of plan.wildcards) {
    if (lower.endsWith(w.suffix)) {
      const prefix = lower.slice(0, -w.suffix.length);
      if (prefix.length > 0 && !prefix.includes('.')) return w.certId;
    }
  }
  return plan.defaultId;
}
