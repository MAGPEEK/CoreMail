/**
 * Dashboard card "Zertifikat einrichten" (10.4.2, components/CertificateSetupCard.tsx):
 * one button runs the certificates page's Let's Encrypt flow for the public
 * host name and then assigns the new certificate to HTTPS.
 *
 *   GET  /admin/certificates/acme-suggestions   host name + autodiscover./autoconfig.
 *                                               of the primary domain (resolvesHere)
 *   POST /admin/certificates/preflight          problems → the card shows them
 *   POST /admin/certificates/letsencrypt        with the mail services: the issuance
 *                                               assigns SMTP/IMAP/POP3 (afterAcmeIssued)
 *   GET  /admin/certificates/:id                poll until ACTIVE / ERROR
 *   POST /admin/certificates/:id/activate-https same as the lock action on the page
 *
 * Pure apart from the injected API, so the order (above all: HTTPS only after
 * a successful issuance) is covered by lib/certificateCard.test.ts.
 *
 * 10.5 (local domain first): while the public host name is a local / private
 * name (the setup wizard's mail.example.local, a bare IP — lib/localHostname.ts)
 * the card offers no Let's Encrypt order but "Eigene Domain hinzufügen"
 * (Domains → add → make primary → request a certificate): cardVariant().
 */
import { isLocalHostname } from './localHostname.ts';

/** GET /admin/setup-state (fields of newer servers optional). */
export interface SetupState {
  certificateCard: boolean;
  /** The name a Let's Encrypt order may use (null for a local / private name). */
  publicHostname: string | null;
  /** 10.5: the configured host name the card is about (also a local one). */
  hostname?: string | null;
  acmeEmail: string | null;
}

export type CardVariant = 'letsencrypt' | 'add-domain';

/** Which card to show: Let's Encrypt for a public host name, "add your domain" for a local / private one. */
export function cardVariant(state: Pick<SetupState, 'publicHostname' | 'hostname'>): CardVariant {
  const host = state.hostname ?? state.publicHostname;
  return !state.publicHostname || isLocalHostname(host) ? 'add-domain' : 'letsencrypt';
}

/** The host name the card names. */
export function cardHost(state: Pick<SetupState, 'publicHostname' | 'hostname'>): string {
  return state.hostname ?? state.publicHostname ?? '';
}

export interface CardApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export type CardPhase = 'idle' | 'preflight' | 'ordering' | 'waiting' | 'activating' | 'done' | 'failed';

export type CardResult =
  | { kind: 'done'; certificateId: string; domains: string[] }
  | { kind: 'preflight-failed'; problems: string[] }
  | { kind: 'issuance-failed'; message: string | null; certificateId: string }
  | { kind: 'timeout'; certificateId: string }
  | { kind: 'error'; message: string | null };

interface AcmeSuggestions {
  publicHostname: string | null;
  sans?: Array<{ name: string; resolvesHere: boolean }>;
  preselectServices?: string[];
}
interface PreflightCheckLite { status: string; message: string }
interface PreflightReportLite {
  ok: boolean;
  domains: Array<{ domain: string; checks: PreflightCheckLite[] }>;
  external: { status: string; message: string };
}

/** Names of the order: the host name plus the suggested names whose DNS points here (as the certificates dialog decides). */
export function acmeDomains(hostname: string, sans: ReadonlyArray<{ name: string; resolvesHere: boolean }>): string[] {
  const norm = (d: string) => d.trim().toLowerCase().replace(/\.$/, '');
  return [norm(hostname), ...sans.filter((s) => s.resolvesHere).map((s) => norm(s.name))]
    .filter((d, i, a) => d !== '' && a.indexOf(d) === i);
}

/** The error messages of a failed preflight (external test last). */
export function preflightProblems(report: PreflightReportLite): string[] {
  const msgs = report.domains.flatMap((d) => d.checks.filter((c) => c.status === 'error').map((c) => `${d.domain}: ${c.message}`));
  if (report.external.status === 'error' && report.external.message) msgs.push(report.external.message);
  return msgs.length ? msgs : [report.external.message].filter(Boolean);
}

/** Certificate status → poll outcome. */
export function pollOutcome(status: string): 'done' | 'failed' | 'waiting' {
  if (status === 'ACTIVE' || status === 'EXPIRING') return 'done';
  if (status === 'ERROR' || status === 'EXPIRED') return 'failed';
  return 'waiting';
}

export interface RunOptions {
  /** Contact address of the ACME account. */
  email: string;
  onPhase?: (p: CardPhase) => void;
  pollMs?: number;
  pollLimitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** false once the card is gone (stop polling quietly). */
  alive?: () => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const message = (err: unknown) => (err instanceof Error && err.message ? err.message : null);

export async function runCertificateCard(api: CardApi, opts: RunOptions): Promise<CardResult> {
  const phase = (p: CardPhase) => opts.onPhase?.(p);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const alive = opts.alive ?? (() => true);
  const pollMs = opts.pollMs ?? 3_000;
  const pollLimitMs = opts.pollLimitMs ?? 5 * 60_000;
  let certificateId = '';
  try {
    phase('preflight');
    const sug = await api.get<AcmeSuggestions>('/admin/certificates/acme-suggestions');
    if (!sug.publicHostname) { phase('failed'); return { kind: 'error', message: null }; }
    const domains = acmeDomains(sug.publicHostname, sug.sans ?? []);
    const report = await api.post<PreflightReportLite>('/admin/certificates/preflight', { domains, external: true });
    if (!report.ok) { phase('failed'); return { kind: 'preflight-failed', problems: preflightProblems(report) }; }

    phase('ordering');
    const cert = await api.post<{ id: string }>('/admin/certificates/letsencrypt', {
      name: domains[0], domains, email: opts.email, services: sug.preselectServices ?? ['SMTP', 'IMAP', 'POP3'], autoRenew: true,
    });
    certificateId = cert.id;

    phase('waiting');
    const started = now();
    for (;;) {
      if (now() - started >= pollLimitMs) { phase('failed'); return { kind: 'timeout', certificateId }; }
      await sleep(pollMs);
      if (!alive()) return { kind: 'timeout', certificateId };
      const c = await api.get<{ status: string; lastError?: string | null }>(`/admin/certificates/${encodeURIComponent(certificateId)}`);
      const o = pollOutcome(c.status);
      if (o === 'failed') { phase('failed'); return { kind: 'issuance-failed', message: c.lastError ?? null, certificateId }; }
      if (o === 'done') break;
    }

    // Issued: also serve it on HTTPS (the issuance already took over SMTP/IMAP/POP3).
    phase('activating');
    await api.post(`/admin/certificates/${encodeURIComponent(certificateId)}/activate-https`);
    phase('done');
    return { kind: 'done', certificateId, domains };
  } catch (err) {
    phase('failed');
    return certificateId ? { kind: 'issuance-failed', message: message(err), certificateId } : { kind: 'error', message: message(err) };
  }
}
