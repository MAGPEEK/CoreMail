/**
 * Pure logic of the first-run setup wizard (10.4, pages/SetupPage.tsx,
 * docs/setup-wizard.md): which steps show, when "Weiter" is allowed, input
 * checks, the secrets download and the resume marker.
 *
 * Order (10.4.2): welcome (token) → domain → admin → ⟨POST /setup/complete +
 * sign-in⟩ → [secrets — download, only when generated] → done. The secrets
 * download needs the admin session, so the commit happens when leaving the
 * admin step. Steps before the commit can not be revisited once setup is
 * complete; reaching "done" closes the download (POST /setup/finish), so there
 * is no way back from it either. DNS is set up in the BCP.
 *
 * 10.6: for a public host name a certificate step follows the secrets step
 * (Let's Encrypt, lib/setupCertificate.ts); local / private host names skip it
 * and keep the self-signed certificate (the BCP dashboard card stays).
 *
 * 10.5 (local domain first): the domain step starts with the local domain
 * example.local (host name mail.example.local, following the domain while the
 * host name is untouched) and a self-signed certificate; the real domain is
 * added later in the BCP (Domains → make primary). A real domain may still be
 * typed in; private suffixes (lib/localHostname.ts) pass the same checks.
 */
import { isLocalHostname } from './localHostname.ts';
import { certificateBlockReason, type CertBlockReason } from './setupCertificate.ts';

export type WizardStepId = 'welcome' | 'domain' | 'admin' | 'secrets' | 'certificate' | 'done';

/** What GET /api/v1/setup/status answers (fields of newer servers optional). */
export interface SetupStatus {
  setupRequired: boolean;
  setupTokenRequired?: boolean;
  /** Path of the generated secrets file on the host (null / missing: none). */
  secretsFile?: string | null;
  /** True when the installation generated the secrets (they must be backed up). */
  secretsGenerated?: boolean;
  /** 10.4.2: the request reached the server over HTTPS (req.secure). */
  secureConnection?: boolean;
}

export interface WizardOptions {
  /** Show the "Secrets sichern" step (status.secretsGenerated). */
  secretsGenerated: boolean;
  /** 10.6: show the "Zertifikat" step (a public host name — showCertificateStep). */
  certificate?: boolean;
}

export function wizardSteps(opts: WizardOptions): WizardStepId[] {
  return [
    'welcome', 'domain', 'admin',
    ...(opts.secretsGenerated ? ['secrets' as const] : []),
    ...(opts.certificate ? ['certificate' as const] : []),
    'done',
  ];
}

/**
 * 10.6: the certificate step shows only for a public host name — a local /
 * private name or an IP address (lib/localHostname.ts, e.g. mail.example.local)
 * keeps the self-signed certificate.
 */
export function showCertificateStep(hostname: string | null | undefined): boolean {
  const h = normalizeHost(hostname ?? '');
  return isValidHostname(h) && !isLocalHostname(h);
}

/** Steps that run before POST /setup/complete. */
export const PRE_COMMIT_STEPS: readonly WizardStepId[] = ['welcome', 'domain', 'admin'];

export function isPreCommit(step: WizardStepId): boolean {
  return PRE_COMMIT_STEPS.includes(step);
}

/** The step whose "Weiter" creates the installation (last pre-commit step shown). */
export function commitStep(steps: readonly WizardStepId[]): WizardStepId {
  const pre = steps.filter(isPreCommit);
  return pre[pre.length - 1] ?? 'admin';
}

export function nextStep(steps: readonly WizardStepId[], current: WizardStepId): WizardStepId | null {
  const i = steps.indexOf(current);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1]! : null;
}

/**
 * The step "Zurück" leads to, or null when there is none. After the commit the
 * steps before it are closed (the installation exists; the token is spent);
 * "done" has closed the secrets download, so it has no way back.
 */
export function previousStep(steps: readonly WizardStepId[], current: WizardStepId, committed: boolean): WizardStepId | null {
  const i = steps.indexOf(current);
  if (i <= 0 || current === 'done') return null;
  const prev = steps[i - 1]!;
  if (committed && isPreCommit(prev)) return null;
  return prev;
}

/** 1-based position for "Schritt x von n". */
export function stepPosition(steps: readonly WizardStepId[], current: WizardStepId): { index: number; total: number } {
  return { index: Math.max(0, steps.indexOf(current)) + 1, total: steps.length };
}

/** Whether the token hint names the secrets directory (only when the server reports a secrets file). */
export function showTokenFileHint(status: Pick<SetupStatus, 'secretsFile'> | null | undefined): boolean {
  return typeof status?.secretsFile === 'string' && status.secretsFile.trim() !== '';
}

export const DEFAULT_SECRETS_FILE = './secrets/coremail.env';

/** The secrets file named in the backup step's hint. */
export function secretsFilePath(status: Pick<SetupStatus, 'secretsFile'> | null | undefined): string {
  return showTokenFileHint(status) ? status!.secretsFile!.trim() : DEFAULT_SECRETS_FILE;
}

// ── Secrets download (GET /api/v1/setup/secrets-download) ─────────────────────

export const SECRETS_DOWNLOAD_PATH = '/api/v1/setup/secrets-download';

/**
 * The connection is unencrypted: the server's answer (status.secureConnection)
 * wins; servers before 10.4.2 do not send it — then the page's own protocol.
 */
export function insecureConnection(secureConnection: boolean | undefined, pageProtocol: string): boolean {
  if (typeof secureConnection === 'boolean') return !secureConnection;
  return pageProtocol !== 'https:';
}

/** `coremail-secrets-<host>-<YYYY-MM-DD>.env` — the same rule as the server. */
export function defaultSecretsFilename(host: string, now: Date = new Date()): string {
  const h = host.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 100);
  return `coremail-secrets-${h || 'server'}-${now.toISOString().slice(0, 10)}.env`;
}

/** File name from Content-Disposition (`filename="…"`), else the default; never a path. */
export function downloadFilename(contentDisposition: string | null | undefined, host: string, now: Date = new Date()): string {
  const m = /filename="([^"\\/]+)"/i.exec(contentDisposition ?? '');
  const name = m?.[1]?.trim();
  return name && /^[\w.-]+$/.test(name) ? name : defaultSecretsFilename(host, now);
}

// ── Input checks ──────────────────────────────────────────────────────────────

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_RE = new RegExp(`^(?=.{4,253}$)(?:${LABEL}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`);

export function normalizeHost(v: string): string {
  return v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

/** A mail domain such as example.com (same rule as the server). */
export function isValidDomain(v: string): boolean {
  const d = normalizeHost(v);
  return d.length >= 3 && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && HOST_RE.test(d);
}

export function isValidHostname(v: string): boolean {
  return HOST_RE.test(normalizeHost(v));
}

export function defaultHostname(domain: string): string {
  const d = normalizeHost(domain);
  return d ? `mail.${d}` : '';
}

/** 10.5: the domain the wizard suggests (local — no public DNS, self-signed certificate). */
export const SUGGESTED_DOMAIN = 'example.local';

/** 10.5: a local / private domain or host name (.local, .lan, .internal, .home.arpa, .test, .localdomain, IPs). */
export function isLocalDomain(v: string): boolean {
  return isLocalHostname(normalizeHost(v));
}

/** Local part of the admin address (the domain is fixed by step 2). */
export function isValidLocalPart(v: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?$/i.test(v.trim()) && !v.includes('..');
}

export const MIN_PASSWORD_LENGTH = 8;

/** 0 (empty) … 4 (strong). Length counts most; character classes add. */
export function passwordScore(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0;
  if (pw.length < MIN_PASSWORD_LENGTH) return 1;
  let score = 1;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length;
  if (classes >= 3) score++;
  // one repeated character or an obvious sequence is never strong
  if (/^(.)\1+$/.test(pw) || /^(?:0123456789|1234567890|abcdefgh|qwertz|qwerty|password|passwort)/i.test(pw)) score = 1;
  return Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
}

// ── Gating of "Weiter" ────────────────────────────────────────────────────────

export interface WizardForm {
  tokenRequired: boolean;
  token: string;
  /** The token value the server confirmed (POST /setup/verify-token). */
  verifiedToken: string | null;
  domain: string;
  hostname: string;
  organizationName: string;
  adminName: string;
  localPart: string;
  password: string;
  confirm: string;
  secretsConfirmed: boolean;
  /** 10.6: contact e-mail of the Let's Encrypt account (default: the admin address). */
  acmeEmail: string;
  /** 10.6: the Let's Encrypt terms of service were accepted. */
  acmeTermsAccepted: boolean;
}

/** 10.5: the form a new wizard starts with — example.local / mail.example.local, organisation empty, admin@<domain>. */
export const INITIAL_FORM: WizardForm = {
  tokenRequired: true, token: '', verifiedToken: null,
  domain: SUGGESTED_DOMAIN, hostname: defaultHostname(SUGGESTED_DOMAIN), organizationName: '',
  adminName: '', localPart: 'admin', password: '', confirm: '', secretsConfirmed: false,
  acmeEmail: '', acmeTermsAccepted: false,
};

export type BlockReason =
  | 'token' | 'domain' | 'hostname' | 'organization' | 'localPart' | 'passwordLength' | 'passwordMismatch' | 'secrets'
  | CertBlockReason;

/**
 * Why "Weiter" is not allowed on a step (null = allowed). The welcome step is
 * passed by verifying the token, which the page does on "Weiter" — here it only
 * needs a non-empty token. The secrets step needs the checkbox (a download is
 * not required: some admins copy the file on the server themselves).
 * 10.6: on the certificate step it gates "Zertifikat anfordern" (valid contact
 * e-mail, terms of service accepted); "Später" never needs it.
 */
export function blockReason(step: WizardStepId, f: WizardForm): BlockReason | null {
  switch (step) {
    case 'welcome':
      return f.tokenRequired && !f.token.trim() ? 'token' : null;
    case 'domain':
      if (!isValidDomain(f.domain)) return 'domain';
      if (!isValidHostname(f.hostname)) return 'hostname';
      if (f.organizationName.trim().length > 200) return 'organization';
      return null;
    case 'admin':
      if (!isValidLocalPart(f.localPart)) return 'localPart';
      if (f.password.length < MIN_PASSWORD_LENGTH) return 'passwordLength';
      if (f.password !== f.confirm) return 'passwordMismatch';
      return null;
    case 'secrets':
      return f.secretsConfirmed ? null : 'secrets';
    case 'certificate':
      return certificateBlockReason(f);
    default:
      return null;
  }
}

/** Does the welcome step still need a (new) server check of the token? */
export function tokenNeedsCheck(f: Pick<WizardForm, 'tokenRequired' | 'token' | 'verifiedToken'>): boolean {
  return f.tokenRequired && f.verifiedToken !== f.token.trim();
}

/** Body of POST /api/v1/setup/complete. */
export function completeBody(f: WizardForm): Record<string, string> {
  const domain = normalizeHost(f.domain);
  return {
    domain,
    hostname: normalizeHost(f.hostname),
    email: `${f.localPart.trim().toLowerCase()}@${domain}`,
    password: f.password,
    ...(f.organizationName.trim() ? { organizationName: f.organizationName.trim() } : {}),
    ...(f.adminName.trim() ? { displayName: f.adminName.trim() } : {}),
    ...(f.tokenRequired ? { setupToken: f.token.trim() } : {}),
  };
}

// ── Resume after a reload (post-commit steps only) ────────────────────────────

export const RESUME_KEY = 'coremail:setup-wizard';

export interface ResumeState {
  step: 'secrets' | 'certificate' | 'done';
  domain: string;
  hostname: string;
  email: string;
  /** The secrets step was part of this run (keeps "Schritt x von n" stable). */
  withSecrets?: boolean;
  /** The secrets checkbox was ticked (kept across a reload of the secrets step). */
  secretsConfirmed?: boolean;
  /** 10.6: the certificate step was part of this run. */
  withCertificate?: boolean;
}

/**
 * Parses the sessionStorage marker; null when absent or malformed. Holds no
 * secrets. A marker of 10.4.0/10.4.1 (steps "dns" / "certificate") resumes at
 * the summary — those steps no longer exist. 10.6: a "certificate" marker with
 * `withCertificate` is the new certificate step and resumes there.
 */
export function parseResume(raw: string | null | undefined): ResumeState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const withCertificate = v['withCertificate'] === true;
    const legacy = v['step'] === 'dns' || (v['step'] === 'certificate' && !withCertificate);
    const step = legacy ? 'done' : v['step'];
    if (step !== 'secrets' && step !== 'certificate' && step !== 'done') return null;
    const str = (k: string) => (typeof v[k] === 'string' ? v[k] as string : '');
    return {
      step, domain: str('domain'), hostname: str('hostname'), email: str('email'),
      ...(v['withSecrets'] === true ? { withSecrets: true } : {}),
      ...(v['secretsConfirmed'] === true ? { secretsConfirmed: true } : {}),
      ...(withCertificate ? { withCertificate: true } : {}),
    };
  } catch {
    return null;
  }
}

/** sessionStorage access (per tab; may be unavailable — never throws). */
export function loadResume(): ResumeState | null {
  try { return parseResume(sessionStorage.getItem(RESUME_KEY)); } catch { return null; }
}

export function saveResume(state: ResumeState): void {
  try { sessionStorage.setItem(RESUME_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

export function clearResume(): void {
  try { sessionStorage.removeItem(RESUME_KEY); } catch { /* storage unavailable */ }
}
