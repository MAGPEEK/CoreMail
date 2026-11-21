/**
 * Setup wizard certificate step (10.6, docs/setup-wizard.md, routes/setup-followup.ts).
 *
 * For a public host name the wizard obtains a Let's Encrypt certificate right
 * after the admin step: names = host name + autodiscover./autoconfig. of the
 * primary domain when their DNS points here (lib/acme-order.ts orderDomains),
 * mail services SMTP/IMAP/POP3 (assigned by the issuance, afterAcmeIssued),
 * then HTTPS — the same result as the BCP dashboard card. Local / private host
 * names (lib/local-hostname.ts, e.g. mail.example.local) have no step.
 *
 * Only the planning and the state shown to the wizard live here; the ACME work
 * is lib/acme-order.ts → lib/cert-renewal.ts → lib/cert-acme.ts.
 */
import { prisma } from '@coremail/storage';
import { recomputeStatus } from './cert-lifecycle.js';
import { acmeSuggestions, orderDomains } from './acme-order.js';
import { isIssuableHostname } from './setup-state.js';

export interface SetupCertificatePlan {
  /** A public CA can issue for the configured host name (not local / private, not a schema default). */
  eligible: boolean;
  hostname: string | null;
  /** Names of the order (empty when not eligible). */
  domains: string[];
  /** autodiscover./autoconfig. of the primary domain and whether their DNS points here. */
  sans: Array<{ name: string; resolvesHere: boolean; message: string }>;
}

/** Host name of the installation as configured (lower case, trimmed). */
export async function configuredHostname(): Promise<string> {
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { publicHostname: true },
  }).catch(() => null);
  return (s?.publicHostname ?? '').trim().toLowerCase();
}

/** The names the wizard orders — with DNS look-ups (autodiscover./autoconfig.). */
export async function setupCertificatePlan(): Promise<SetupCertificatePlan> {
  const host = await configuredHostname();
  if (!isIssuableHostname(host)) return { eligible: false, hostname: host || null, domains: [], sans: [] };
  const sug = await acmeSuggestions();
  if (!sug.publicHostname) return { eligible: false, hostname: host, domains: [], sans: [] };
  const sans = sug.sans.map((s) => ({ name: s.name, resolvesHere: s.resolvesHere, message: s.message }));
  return { eligible: true, hostname: sug.publicHostname, domains: orderDomains(sug.publicHostname, sans), sans };
}

/** The certificate the wizard shows. */
export interface SetupCertificateView {
  id: string;
  status: string;
  domains: string[];
  lastError: string | null;
  lastErrorCode: string | null;
  httpsActive: boolean;
  protocolActive: boolean;
  expiresAt: string | null;
}

const VIEW_SELECT = {
  id: true, status: true, domains: true, lastError: true, lastErrorCode: true,
  isActiveHttps: true, isActiveProtocol: true, expiresAt: true, certPem: true, keyPem: true,
  acmeEmail: true, createdAt: true,
} as const;

export interface SetupCertificateRow {
  id: string;
  status: string;
  domains: string[];
  lastError: string | null;
  lastErrorCode: string | null;
  isActiveHttps: boolean;
  isActiveProtocol: boolean;
  expiresAt: Date | null;
  certPem: string | null;
  keyPem: string | null;
  acmeEmail: string | null;
}

/**
 * The Let's Encrypt certificate this setup run ordered for `hostname`: the
 * newest production order covering it that was created after the setup was
 * completed (a reload of the wizard finds the running order again).
 */
export async function findSetupCertificate(hostname: string, since: Date): Promise<SetupCertificateRow | null> {
  const row = await prisma.certificate.findFirst({
    where: { type: 'LETSENCRYPT', acmeStaging: false, domains: { has: hostname }, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: VIEW_SELECT,
  });
  return (row as SetupCertificateRow | null) ?? null;
}

export function viewOf(row: SetupCertificateRow, now: Date = new Date()): SetupCertificateView {
  return {
    id: row.id,
    status: recomputeStatus(row.status as never, row.expiresAt, now) as string,
    domains: row.domains,
    lastError: row.lastError,
    lastErrorCode: row.lastErrorCode,
    httpsActive: row.isActiveHttps,
    protocolActive: row.isActiveProtocol,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

/** Issued and usable: the issuance wrote the PEM and the status says so. */
export function isIssued(row: Pick<SetupCertificateRow, 'status' | 'certPem' | 'keyPem'>): boolean {
  return (row.status === 'ACTIVE' || row.status === 'EXPIRING') && !!row.certPem && !!row.keyPem;
}

/** An ACME run for the row is in progress (or was, until a restart). */
export function isInProgress(row: Pick<SetupCertificateRow, 'status'>): boolean {
  return row.status === 'PENDING' || row.status === 'RENEWING';
}

/** Contact address offered for the ACME account: the order's, else ServerSettings.adminEmail, else the admin's own. */
export async function defaultContactEmail(sessionEmail: string | undefined, existing: SetupCertificateRow | null): Promise<string | null> {
  if (existing?.acmeEmail) return existing.acmeEmail;
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { adminEmail: true },
  }).catch(() => null);
  return (s?.adminEmail ?? '').trim() || sessionEmail || null;
}
