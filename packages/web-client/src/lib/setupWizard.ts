/**
 * Pure logic of the first-run setup wizard (10.4, pages/SetupPage.tsx,
 * docs/setup-wizard.md): which steps show, when "Weiter" is allowed, input
 * checks, the DNS / certificate gating and the resume marker.
 *
 * Order: welcome (token) → domain → admin → [secrets] → ⟨POST /setup/complete
 * + sign-in⟩ → dns → certificate → done. The domain (and its DKIM key) exists
 * only after /setup/complete, so the DNS step shows the real records. Steps
 * before the commit can not be revisited once setup is complete.
 */

export type WizardStepId = 'welcome' | 'domain' | 'admin' | 'secrets' | 'dns' | 'certificate' | 'done';

/** What GET /api/v1/setup/status answers (fields of newer servers optional). */
export interface SetupStatus {
  setupRequired: boolean;
  setupTokenRequired?: boolean;
  /** Path of the generated secrets file on the host (null / missing: none). */
  secretsFile?: string | null;
  /** True when the installation generated the secrets (they must be backed up). */
  secretsGenerated?: boolean;
}

export interface WizardOptions {
  /** Show the "Secrets sichern" step (status.secretsGenerated). */
  secretsGenerated: boolean;
}

export function wizardSteps(opts: WizardOptions): WizardStepId[] {
  return ['welcome', 'domain', 'admin', ...(opts.secretsGenerated ? ['secrets' as const] : []), 'dns', 'certificate', 'done'];
}

/** Steps that run before POST /setup/complete. */
export const PRE_COMMIT_STEPS: readonly WizardStepId[] = ['welcome', 'domain', 'admin', 'secrets'];

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
 * steps before it are closed (the installation exists; the token is spent).
 */
export function previousStep(steps: readonly WizardStepId[], current: WizardStepId, committed: boolean): WizardStepId | null {
  const i = steps.indexOf(current);
  if (i <= 0) return null;
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

/** The secrets file to show in the backup step. */
export function secretsFilePath(status: Pick<SetupStatus, 'secretsFile'> | null | undefined): string {
  return showTokenFileHint(status) ? status!.secretsFile!.trim() : DEFAULT_SECRETS_FILE;
}

/** Quote a path for a POSIX shell when it contains anything but safe characters. */
function shellPath(p: string): string {
  return /^[\w./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Copyable backup commands for the secrets file (never contains secret values). */
export function backupCommands(file: string, target: string): { copy: string; archive: string } {
  const slash = file.lastIndexOf('/');
  const dir = slash > 0 ? file.slice(0, slash) : '.';
  return {
    copy: `cp ${shellPath(file)} ${shellPath(target)}`,
    archive: `tar czf coremail-secrets-$(date +%F).tar.gz ${shellPath(dir)}`,
  };
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
}

export type BlockReason =
  | 'token' | 'domain' | 'hostname' | 'organization' | 'localPart' | 'passwordLength' | 'passwordMismatch' | 'secrets';

/**
 * Why "Weiter" is not allowed on a pre-commit step (null = allowed). The
 * welcome step is passed by verifying the token, which the page does on
 * "Weiter" — here it only needs a non-empty token.
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

// ── DNS + certificate ─────────────────────────────────────────────────────────

export interface DnsRecordResult {
  type: string;
  name: string;
  expected: string;
  ok: boolean;
  found: string | null;
  warning?: string;
  error?: string;
}

/** The records the wizard shows: required first, then recommended. */
export const REQUIRED_DNS_KEYS = ['a', 'mx', 'spf', 'dkim'] as const;
export const RECOMMENDED_DNS_KEYS = ['dmarc', 'ptr'] as const;

export function requiredDnsOk(records: Partial<Record<string, DnsRecordResult>> | null | undefined): boolean {
  return !!records && REQUIRED_DNS_KEYS.every((k) => records[k]?.ok === true);
}

/** Let's Encrypt is offered only when the host's A record and the MX check pass. */
export function letsEncryptAllowed(records: Partial<Record<string, DnsRecordResult>> | null | undefined): boolean {
  return !!records && records['a']?.ok === true && records['mx']?.ok === true;
}

export type CertificateChoice = 'letsencrypt' | 'proxy' | 'later';

/** Names of a Let's Encrypt order: the host name plus suggested names that resolve here. */
export function acmeDomains(hostname: string, sans: ReadonlyArray<{ name: string; resolvesHere: boolean }>): string[] {
  const host = normalizeHost(hostname);
  return [host, ...sans.filter((s) => s.resolvesHere).map((s) => normalizeHost(s.name))]
    .filter((d, i, a) => d !== '' && a.indexOf(d) === i);
}

export type IssuancePhase = 'idle' | 'preflight' | 'ordering' | 'waiting' | 'done' | 'failed';

/** Certificate status from GET /admin/certificates/:id → issuance phase. */
export function phaseForCertStatus(status: string): IssuancePhase {
  if (status === 'ACTIVE' || status === 'EXPIRING') return 'done';
  if (status === 'ERROR' || status === 'EXPIRED') return 'failed';
  return 'waiting';
}

// ── Resume after a reload (post-commit steps only) ────────────────────────────

export const RESUME_KEY = 'coremail:setup-wizard';

export interface ResumeState {
  step: 'dns' | 'certificate' | 'done';
  domain: string;
  hostname: string;
  email: string;
  /** The secrets step was part of this run (keeps "Schritt x von n" stable). */
  withSecrets?: boolean;
  certificateChoice?: CertificateChoice;
}

/** Parses the sessionStorage marker; null when absent or malformed. Holds no secrets. */
export function parseResume(raw: string | null | undefined): ResumeState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const step = v['step'];
    if (step !== 'dns' && step !== 'certificate' && step !== 'done') return null;
    const str = (k: string) => (typeof v[k] === 'string' ? v[k] as string : '');
    const choice = v['certificateChoice'];
    return {
      step, domain: str('domain'), hostname: str('hostname'), email: str('email'),
      ...(v['withSecrets'] === true ? { withSecrets: true } : {}),
      ...(choice === 'letsencrypt' || choice === 'proxy' || choice === 'later' ? { certificateChoice: choice } : {}),
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
