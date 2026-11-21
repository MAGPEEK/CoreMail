/**
 * Setup wizard certificate step (10.6, pages/SetupPage.tsx, docs/setup-wizard.md):
 * for a public host name the wizard obtains a Let's Encrypt certificate.
 *
 *   GET  /api/v1/setup/certificate/status   names, contact default, terms of service, order state
 *                                           (?view=certificate while polling: order state only)
 *   POST /api/v1/setup/certificate/preflight the BCP pre-flight → per-check status
 *   POST /api/v1/setup/certificate/issue    { email, termsAccepted: true } — SMTP/IMAP/POP3 by the
 *                                           issuance, HTTPS by the server once issued; idempotent
 *
 * Pure apart from the injected API, so the order (pre-flight first, nothing
 * ordered when it fails, HTTPS confirmed before "done") is covered by
 * lib/setupCertificate.test.ts. The server decides the names; the wizard only
 * shows them.
 */

export const CERT_STATUS_PATH = '/api/v1/setup/certificate/status';
export const CERT_PREFLIGHT_PATH = '/api/v1/setup/certificate/preflight';
export const CERT_ISSUE_PATH = '/api/v1/setup/certificate/issue';

export type CheckId = 'dns' | 'ipv6' | 'server-ip' | 'caa' | 'local' | 'public';
export type CheckStatus = 'ok' | 'warn' | 'error' | 'skip';

export interface PreflightCheck { id: CheckId; status: CheckStatus; message: string }
export interface PreflightReport {
  ok: boolean;
  domains: Array<{ domain: string; checks: PreflightCheck[] }>;
  external: { status: CheckStatus; message: string; code?: string };
}

export interface CertificateView {
  id: string;
  status: string;
  domains: string[];
  lastError: string | null;
  lastErrorCode: string | null;
  httpsActive: boolean;
  protocolActive: boolean;
  expiresAt: string | null;
}

/** GET /api/v1/setup/certificate/status (full view). */
export interface CertificateStepInfo {
  eligible: boolean;
  hostname: string | null;
  domains: string[];
  sans: Array<{ name: string; resolvesHere: boolean; message: string }>;
  contactEmail: string | null;
  termsOfServiceUrl: string;
  termsOfServiceFromDirectory?: boolean;
  certificate: CertificateView | null;
}

export interface CertApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export type CertPhase = 'idle' | 'preflight' | 'ordering' | 'waiting' | 'activating' | 'done' | 'failed';

export type CertResult =
  | { kind: 'done'; certificate: CertificateView }
  | { kind: 'preflight-failed'; report: PreflightReport }
  | { kind: 'issuance-failed'; code: string | null; message: string | null; certificateId: string }
  | { kind: 'timeout'; certificateId: string | null }
  | { kind: 'error'; reason: CertErrorReason; message: string | null };

export type CertErrorReason = 'rate-limited' | 'window-closed' | 'local-hostname' | 'busy' | 'input' | 'failed';

// ── Input checks ──────────────────────────────────────────────────────────────

/** Same rule as the server (zod `email()`), at most 254 characters. */
const EMAIL_RE = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

export function isValidContactEmail(v: string): boolean {
  const e = v.trim();
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}

export type CertBlockReason = 'acmeEmail' | 'acmeTerms';

/** Why "Zertifikat anfordern" is not allowed yet (null = allowed). */
export function certificateBlockReason(f: { acmeEmail: string; acmeTermsAccepted: boolean }): CertBlockReason | null {
  if (!isValidContactEmail(f.acmeEmail)) return 'acmeEmail';
  if (!f.acmeTermsAccepted) return 'acmeTerms';
  return null;
}

/** Body of POST /setup/certificate/issue. */
export function issueBody(email: string): { email: string; termsAccepted: true } {
  return { email: email.trim(), termsAccepted: true };
}

/** Only an https link from the server is shown as the terms of service (fallback: the CA's repository page). */
export const LE_REPOSITORY_URL = 'https://letsencrypt.org/repository/';
export function safeTermsUrl(url: string | null | undefined): string {
  return typeof url === 'string' && /^https:\/\/[^\s"<>]+$/i.test(url) ? url : LE_REPOSITORY_URL;
}

// ── Outcome helpers ───────────────────────────────────────────────────────────

/** Certificate status → poll outcome. */
export function pollOutcome(status: string): 'issued' | 'failed' | 'waiting' {
  if (status === 'ACTIVE' || status === 'EXPIRING') return 'issued';
  if (status === 'ERROR' || status === 'EXPIRED') return 'failed';
  return 'waiting';
}

/** The order state a reloaded wizard finds: done, still running, failed — or nothing yet. */
export function resumeState(c: CertificateView | null | undefined): 'none' | 'done' | 'running' | 'failed' {
  if (!c) return 'none';
  const o = pollOutcome(c.status);
  if (o === 'issued') return c.httpsActive ? 'done' : 'running';
  return o === 'failed' ? 'failed' : 'running';
}

/** Checks that stop the order (errors), in report order — the external test last. */
export function blockingChecks(report: PreflightReport): Array<{ domain: string; check: PreflightCheck }> {
  return report.domains.flatMap((d) => d.checks.filter((c) => c.status === 'error').map((check) => ({ domain: d.domain, check })));
}

function errorReason(err: unknown): CertErrorReason {
  const e = err as { status?: number; code?: string } | null;
  if (e?.status === 429 || e?.code === 'RATE_LIMITED') return 'rate-limited';
  if (e?.status === 404) return 'window-closed';
  if (e?.code === 'LOCAL_HOSTNAME') return 'local-hostname';
  if (e?.code === 'BUSY') return 'busy';
  if (e?.code === 'INVALID_EMAIL' || e?.code === 'TERMS_REQUIRED') return 'input';
  return 'failed';
}
const messageOf = (err: unknown) => (err instanceof Error && err.message ? err.message : null);

// ── Run ───────────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Contact address of the ACME account. */
  email: string;
  onPhase?: (p: CertPhase) => void;
  onReport?: (r: PreflightReport) => void;
  onCertificate?: (c: CertificateView) => void;
  pollMs?: number;
  /** Upper bound of the wait for the issuance (default 6 min — the server gives up after 5). */
  pollLimitMs?: number;
  /** Polls after the issuance before the HTTPS assignment is asked for again. */
  httpsGracePolls?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** false once the step is gone (stop quietly). */
  alive?: () => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "Zertifikat anfordern": pre-flight → order → wait for the issuance and the HTTPS assignment. */
export async function runSetupCertificate(api: CertApi, opts: RunOptions): Promise<CertResult> {
  const phase = (p: CertPhase) => opts.onPhase?.(p);
  try {
    phase('preflight');
    const pf = await api.post<{ domains: string[]; report: PreflightReport }>(CERT_PREFLIGHT_PATH, {});
    opts.onReport?.(pf.report);
    if (!pf.report.ok) { phase('failed'); return { kind: 'preflight-failed', report: pf.report }; }
    if (opts.alive && !opts.alive()) return { kind: 'timeout', certificateId: null };

    phase('ordering');
    const ordered = await api.post<{ certificate: CertificateView | null }>(CERT_ISSUE_PATH, issueBody(opts.email));
    if (ordered.certificate) opts.onCertificate?.(ordered.certificate);
  } catch (err) {
    phase('failed');
    return { kind: 'error', reason: errorReason(err), message: messageOf(err) };
  }
  return waitForCertificate(api, opts);
}

/**
 * Waits for the running order (also after a reload of the wizard): issued AND
 * served on HTTPS → done; ERROR → the reason. When the issuance is done but
 * HTTPS still is not assigned after a few polls (the server restarted in
 * between), the order is sent again — idempotent, it only assigns HTTPS.
 */
export async function waitForCertificate(api: CertApi, opts: RunOptions): Promise<CertResult> {
  const phase = (p: CertPhase) => opts.onPhase?.(p);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const alive = opts.alive ?? (() => true);
  const pollMs = opts.pollMs ?? 3_000;
  const pollLimitMs = opts.pollLimitMs ?? 6 * 60_000;
  const grace = opts.httpsGracePolls ?? 4;
  let certificateId: string | null = null;
  let issuedPolls = 0;
  let reassigned = false;
  phase('waiting');
  const started = now();
  try {
    for (;;) {
      if (now() - started >= pollLimitMs) { phase('failed'); return { kind: 'timeout', certificateId }; }
      await sleep(pollMs);
      if (!alive()) return { kind: 'timeout', certificateId };
      const s = await api.get<{ certificate: CertificateView | null }>(`${CERT_STATUS_PATH}?view=certificate`);
      const c = s.certificate;
      if (!c) continue;
      certificateId = c.id;
      opts.onCertificate?.(c);
      const o = pollOutcome(c.status);
      if (o === 'failed') {
        phase('failed');
        return { kind: 'issuance-failed', code: c.lastErrorCode, message: c.lastError, certificateId: c.id };
      }
      if (o === 'waiting') continue;
      if (c.httpsActive) { phase('done'); return { kind: 'done', certificate: c }; }
      phase('activating');
      issuedPolls++;
      if (issuedPolls >= grace && !reassigned) {
        reassigned = true;
        const r = await api.post<{ certificate: CertificateView | null }>(CERT_ISSUE_PATH, issueBody(opts.email));
        if (r.certificate?.httpsActive) { phase('done'); return { kind: 'done', certificate: r.certificate }; }
      }
    }
  } catch (err) {
    phase('failed');
    return { kind: 'error', reason: errorReason(err), message: messageOf(err) };
  }
}
