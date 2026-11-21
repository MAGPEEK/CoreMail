/**
 * First-run setup wizard (10.4, docs/setup-wizard.md).
 *
 *   welcome (setup token, checked with POST /setup/verify-token)
 *   → domain + host name + organisation
 *   → admin account (MFA explained: 10.5 fresh installations require it for
 *     the BCP — enrolled in the webmail after the wizard, Settings → Security)
 *   ⟨POST /setup/complete, then sign-in with the new admin (normal /auth/login)⟩
 *   → [back up secrets — download, only when the installation generated them]
 *   → [certificate — Let's Encrypt, only for a public host name (10.6)]
 *   → done (summary + links; POST /setup/finish closes the secrets download)
 *
 * 10.4.2: no DNS step — DNS is set up in the BCP (Domains). 10.6: a public
 * host name gets the certificate step (components/setup/CertificateStep.tsx,
 * lib/setupCertificate.ts); a local one keeps the self-signed certificate and
 * the BCP dashboard card. Step logic lives in lib/setupWizard.ts. After the
 * commit the steps before it are closed; a reload resumes at the post-commit
 * step from a per-tab marker (sessionStorage, no secrets) as long as the admin
 * session is valid.
 */
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Mail, ExternalLink, ShieldCheck, Server, MonitorSmartphone, Download, AlertTriangle, Loader2 } from 'lucide-react';
import { useBranding } from '../hooks/useBranding.js';
import { useT, fmt } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { api, apiFetch, ensureSession, login, saveBlob } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import type { UserProfile } from '../api/types.js';
import { AuthShell } from '../components/AuthShell.js';
import {
  wizardSteps, commitStep, nextStep, previousStep, isPreCommit, blockReason, tokenNeedsCheck, completeBody,
  defaultHostname, normalizeHost, showTokenFileHint, secretsFilePath, insecureConnection, downloadFilename,
  SECRETS_DOWNLOAD_PATH, loadResume, saveResume, clearResume, INITIAL_FORM, isLocalDomain, showCertificateStep,
  type BlockReason, type SetupStatus, type WizardForm, type WizardStepId,
} from '../lib/setupWizard.js';
import {
  CERT_STATUS_PATH, resumeState, runSetupCertificate, waitForCertificate,
  type CertPhase, type CertResult, type CertificateStepInfo, type PreflightReport,
} from '../lib/setupCertificate.js';
import { Alert, Field, INPUT_CLASS, PasswordMeter, STEP_LABEL, WizardProgress } from '../components/setup/WizardParts.js';
import { CertificateStep, isCertRunning } from '../components/setup/CertificateStep.js';

const REASON_TEXT: Record<BlockReason, TranslationKey> = {
  token: 'wiz_err_token',
  domain: 'wiz_err_domain',
  hostname: 'wiz_err_hostname',
  organization: 'wiz_err_organization',
  localPart: 'wiz_err_local',
  passwordLength: 'wiz_err_password_length',
  passwordMismatch: 'wiz_err_password_mismatch',
  secrets: 'wiz_err_secrets',
  acmeEmail: 'wiz_err_acme_email',
  acmeTerms: 'wiz_err_acme_terms',
};

/** Which field an error belongs to (aria-invalid + focus). */
const REASON_FIELD: Record<BlockReason, string> = {
  token: 'wiz-token', domain: 'wiz-domain', hostname: 'wiz-hostname', organization: 'wiz-org',
  localPart: 'wiz-local', passwordLength: 'wiz-password', passwordMismatch: 'wiz-confirm', secrets: 'wiz-secrets-ok',
  acmeEmail: 'wiz-acme-email', acmeTerms: 'wiz-acme-terms',
};

const BUTTON_PRIMARY =
  'bg-accent hover:bg-accent-hover disabled:opacity-60 text-white font-medium py-2 px-4 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg focus-visible:ring-offset-2';
const BUTTON_SECONDARY =
  'border border-line-strong text-fg-muted hover:bg-surface-2 font-medium py-2 px-4 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg';

interface Summary {
  domain: string;
  hostname: string;
  email: string;
  sessionMissing: boolean;
}

type DownloadState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; filename: string }
  | { kind: 'error'; reason: 'gone' | 'failed' | 'session' };

// ── Step bodies (module level) ────────────────────────────────────────────────

function WelcomeStep({ form, status, invalid, onChange }: {
  form: WizardForm; status: SetupStatus | null; invalid: boolean; onChange: (p: Partial<WizardForm>) => void;
}) {
  const t = useT();
  const { productName } = useBranding();
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{fmt(t('wiz_welcome_intro'), { name: productName })}</p>
      {form.tokenRequired && (
        <Field
          id="wiz-token" label={t('wiz_token_label')}
          hint={showTokenFileHint(status) ? t('wiz_token_hint_file') : (
            <>
              {t('wiz_token_hint_log')}{' '}
              <code className="bg-surface-2 px-1 rounded break-all">docker logs coremail 2&gt;&amp;1 | grep -i &quot;setup token&quot;</code>
              {' '}{t('wiz_token_hint_env')}
            </>
          )}
        >
          <input
            id="wiz-token" type="text" autoComplete="off" spellCheck={false} required
            placeholder={t('wiz_token_placeholder')} value={form.token}
            aria-invalid={invalid} aria-describedby="wiz-token-hint"
            onChange={(e) => onChange({ token: e.target.value })}
            className={`${INPUT_CLASS} font-mono`}
          />
        </Field>
      )}
    </div>
  );
}

function DomainStep({ form, invalidField, onDomain, onHostname, onChange }: {
  form: WizardForm; invalidField: string | null;
  onDomain: (v: string) => void; onHostname: (v: string) => void; onChange: (p: Partial<WizardForm>) => void;
}) {
  const t = useT();
  const { productName } = useBranding();
  const localHost = isLocalDomain(form.hostname);
  return (
    <div className="space-y-4">
      {/* 10.5: local domain first — the real domain is added later in the BCP */}
      <Alert tone="info">{fmt(t('wiz_domain_local_first'), { name: productName })}</Alert>
      <p className="text-sm text-fg-muted">{t('wiz_domain_intro')}</p>
      <Field id="wiz-domain" label={t('wiz_domain_label')} hint={t('wiz_domain_hint')}>
        <input
          id="wiz-domain" type="text" inputMode="url" autoComplete="off" spellCheck={false} required
          placeholder={t('wiz_domain_placeholder')} value={form.domain}
          aria-invalid={invalidField === 'wiz-domain'} aria-describedby="wiz-domain-hint"
          onChange={(e) => onDomain(e.target.value)} className={INPUT_CLASS}
        />
      </Field>
      <Field id="wiz-hostname" label={t('wiz_hostname_label')} hint={t(localHost ? 'wiz_hostname_hint_local' : 'wiz_hostname_hint')}>
        <input
          id="wiz-hostname" type="text" inputMode="url" autoComplete="off" spellCheck={false} required
          value={form.hostname}
          aria-invalid={invalidField === 'wiz-hostname'} aria-describedby="wiz-hostname-hint"
          onChange={(e) => onHostname(e.target.value)} className={INPUT_CLASS}
        />
      </Field>
      <Field id="wiz-org" label={t('wiz_org_label')} hint={t('wiz_org_hint')}>
        <input
          id="wiz-org" type="text" autoComplete="organization" maxLength={200} value={form.organizationName}
          aria-invalid={invalidField === 'wiz-org'} aria-describedby="wiz-org-hint"
          onChange={(e) => onChange({ organizationName: e.target.value })} className={INPUT_CLASS}
        />
      </Field>
    </div>
  );
}

function AdminStep({ form, invalidField, onChange }: {
  form: WizardForm; invalidField: string | null; onChange: (p: Partial<WizardForm>) => void;
}) {
  const t = useT();
  const domain = normalizeHost(form.domain);
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{t('wiz_admin_intro')}</p>
      <Field id="wiz-name" label={t('wiz_admin_name')}>
        <input
          id="wiz-name" type="text" autoComplete="name" maxLength={200} value={form.adminName}
          placeholder={t('wiz_admin_name_placeholder')}
          onChange={(e) => onChange({ adminName: e.target.value })} className={INPUT_CLASS}
        />
      </Field>
      <Field id="wiz-local" label={t('wiz_admin_address')} hint={fmt(t('wiz_admin_address_hint'), { domain })}>
        <div className="flex items-stretch">
          <input
            id="wiz-local" type="text" autoComplete="username" spellCheck={false} required value={form.localPart}
            aria-invalid={invalidField === 'wiz-local'} aria-describedby="wiz-local-hint wiz-local-domain"
            onChange={(e) => onChange({ localPart: e.target.value })}
            className={`${INPUT_CLASS} rounded-r-none min-w-0`}
          />
          <span id="wiz-local-domain" className="inline-flex items-center rounded-r border border-l-0 border-line-strong bg-surface-2 px-3 text-sm text-fg-muted max-w-[60%] truncate">
            @{domain}
          </span>
        </div>
      </Field>
      {/* 10.5: mail from outside cannot reach a .local (private) address */}
      {isLocalDomain(domain) && <Alert tone="info">{fmt(t('wiz_admin_local_hint'), { domain })}</Alert>}
      <Field id="wiz-password" label={t('wiz_password')} hint={t('wiz_password_hint')}>
        <input
          id="wiz-password" type="password" autoComplete="new-password" required value={form.password}
          aria-invalid={invalidField === 'wiz-password'} aria-describedby="wiz-password-hint wiz-password-meter"
          onChange={(e) => onChange({ password: e.target.value })} className={INPUT_CLASS}
        />
        <PasswordMeter password={form.password} id="wiz-password-meter" />
      </Field>
      <Field id="wiz-confirm" label={t('wiz_password_confirm')}>
        <input
          id="wiz-confirm" type="password" autoComplete="new-password" required value={form.confirm}
          aria-invalid={invalidField === 'wiz-confirm'}
          onChange={(e) => onChange({ confirm: e.target.value })} className={INPUT_CLASS}
        />
      </Field>
      <div className="rounded-lg border border-info-line bg-info-bg p-3 text-sm text-info-fg">
        <p className="flex items-center gap-1.5 font-medium"><ShieldCheck size={16} aria-hidden="true" />{t('wiz_mfa_title')}</p>
        <p className="mt-1">{t('wiz_mfa_note')}</p>
        <details className="mt-1">
          <summary className="cursor-pointer underline underline-offset-2">{t('wiz_mfa_later')}</summary>
          <p className="mt-1">{t('wiz_mfa_later_where')}</p>
        </details>
      </div>
    </div>
  );
}

const DOWNLOAD_ERROR: Record<'gone' | 'failed' | 'session', TranslationKey> = {
  gone: 'wiz_secrets_download_gone',
  failed: 'wiz_secrets_download_failed',
  session: 'wiz_secrets_download_session',
};

function SecretsStep({ form, status, insecure, sessionMissing, download, invalid, onDownload, onChange }: {
  form: WizardForm; status: SetupStatus | null; insecure: boolean; sessionMissing: boolean; download: DownloadState;
  invalid: boolean; onDownload: () => void; onChange: (p: Partial<WizardForm>) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{t('wiz_secrets_intro')}</p>
      <Alert tone="warning">{t('wiz_secrets_warning')}</Alert>
      {!sessionMissing && (
        <div className="space-y-1.5">
          <button
            type="button" onClick={onDownload} disabled={download.kind === 'busy'}
            className={`${BUTTON_SECONDARY} inline-flex items-center gap-2 disabled:opacity-60`}
          >
            {download.kind === 'busy'
              ? <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              : <Download size={16} aria-hidden="true" />}
            {t('wiz_secrets_download')}
          </button>
          {insecure && (
            <p className="flex items-start gap-1.5 text-xs text-warning-fg">
              <AlertTriangle size={14} className="shrink-0 mt-px" aria-hidden="true" />{t('wiz_secrets_insecure')}
            </p>
          )}
          <div aria-live="polite">
            {download.kind === 'done' && (
              <p className="text-xs text-success-fg">{fmt(t('wiz_secrets_downloaded'), { file: download.filename })}</p>
            )}
          </div>
          {download.kind === 'error' && <Alert tone="danger">{t(DOWNLOAD_ERROR[download.reason])}</Alert>}
        </div>
      )}
      {sessionMissing && <Alert tone="info">{t('wiz_secrets_download_session')}</Alert>}
      <p className="text-xs text-fg-subtle">{t('wiz_secrets_offsite')}</p>
      <p className="text-xs text-fg-subtle">
        {fmt(t('wiz_secrets_location'), { file: secretsFilePath(status) })}
      </p>
      <label htmlFor="wiz-secrets-ok" className="flex items-start gap-2 text-sm text-fg cursor-pointer">
        <input
          id="wiz-secrets-ok" type="checkbox" checked={form.secretsConfirmed} aria-invalid={invalid}
          onChange={(e) => onChange({ secretsConfirmed: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-current text-accent-fg"
        />
        <span>{t('wiz_secrets_confirm')}</span>
      </label>
    </div>
  );
}

/** Renders `{key}` placeholders of a translated sentence as the given nodes. */
function withLinks(text: string, links: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return <Fragment key={i}>{m && m[1]! in links ? links[m[1]!] : part}</Fragment>;
  });
}

function DoneStep({ summary, certificateIssued }: { summary: Summary; certificateIssued: boolean }) {
  const t = useT();
  const rows: Array<[string, string]> = [
    [t('wiz_summary_domain'), summary.domain],
    [t('wiz_summary_hostname'), summary.hostname],
    [t('wiz_summary_admin'), summary.email],
    ...(certificateIssued ? [[t('wiz_summary_certificate'), t('wiz_summary_certificate_le')] as [string, string]] : []),
  ];
  const linkCls = 'flex items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-sm text-fg hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg';
  const inlineLink = 'underline underline-offset-2 text-accent-fg hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg rounded';
  const leave = () => clearResume();
  return (
    <div className="space-y-5">
      <p className="text-sm text-fg-muted">{t('wiz_done_intro')}</p>
      {summary.sessionMissing && <Alert tone="warning">{t('wiz_session_missing')}</Alert>}
      <dl aria-label={t('wiz_summary_label')} className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-subtle">{k}</dt>
            <dd className="text-fg break-words mb-1 sm:mb-0">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-fg-muted">
        {withLinks(t('wiz_done_bcp_dns_cert'), {
          domains: <a href="/bcp/domains" target="_blank" rel="noopener" className={inlineLink}>{t('wiz_done_bcp_domains')}<span className="sr-only"> {t('wiz_new_tab')}</span></a>,
          certificates: <a href="/bcp/certificates" target="_blank" rel="noopener" className={inlineLink}>{t('wiz_done_bcp_certificates')}<span className="sr-only"> {t('wiz_new_tab')}</span></a>,
        })}
      </p>
      {/* 10.5: fresh installations start with MFA mandatory for admins */}
      <Alert tone="info">{t('wiz_done_mfa_required')}</Alert>
      <div>
        <h3 className="text-sm font-semibold text-fg mb-2">{t('wiz_next_steps')}</h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          <li>
            <a href="/mail" onClick={leave} className={linkCls}>
              <Mail size={16} aria-hidden="true" className="text-accent-fg" />{t('wiz_open_webmail')}
            </a>
          </li>
          <li>
            <a href="/bcp/" target="_blank" rel="noopener" className={linkCls}>
              <Server size={16} aria-hidden="true" className="text-accent-fg" />{t('wiz_open_bcp')}
              <ExternalLink size={13} aria-hidden="true" className="ml-auto text-fg-subtle" />
              <span className="sr-only">{t('wiz_new_tab')}</span>
            </a>
          </li>
          <li>
            <a href="/settings#externalClients" onClick={leave} className={linkCls}>
              <MonitorSmartphone size={16} aria-hidden="true" className="text-accent-fg" />{t('wiz_open_clients')}
            </a>
          </li>
          <li>
            <a href="/settings#security" onClick={leave} className={linkCls}>
              <ShieldCheck size={16} aria-hidden="true" className="text-accent-fg" />{t('wiz_open_mfa')}
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SetupPage() {
  const t = useT();
  const { productName } = useBranding();
  const { setTokens, setProfile } = useAuthStore();

  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [withSecrets, setWithSecrets] = useState(false);
  const [step, setStep] = useState<WizardStepId>('welcome');
  const [committed, setCommitted] = useState(false);
  const [form, setForm] = useState<WizardForm>(INITIAL_FORM);
  const [hostnameEdited, setHostnameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const [alreadyDone, setAlreadyDone] = useState(false);
  const [download, setDownload] = useState<DownloadState>({ kind: 'idle' });
  const [summary, setSummary] = useState<Summary>({ domain: '', hostname: '', email: '', sessionMissing: false });
  // 10.6: certificate step (public host names only)
  const [certStep, setCertStep] = useState(false);
  const [certInfo, setCertInfo] = useState<CertificateStepInfo | null>(null);
  const [certPhase, setCertPhase] = useState<CertPhase>('idle');
  const [certReport, setCertReport] = useState<PreflightReport | null>(null);
  const [certResult, setCertResult] = useState<CertResult | null>(null);
  const certRun = useRef(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const firstRender = useRef(true);
  const finishSent = useRef(false);

  // Before the commit the typed host name decides; after it the stored decision (needs the admin session).
  const withCertificate = committed ? certStep : showCertificateStep(form.hostname);
  const steps = wizardSteps({ secretsGenerated: withSecrets, certificate: withCertificate });

  // ── Start: status, or resume after a reload ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let s: SetupStatus | null = null;
      try {
        s = await (await fetch('/api/v1/setup/status')).json() as SetupStatus;
      } catch { /* network error: show the first step, the server answers on submit */ }
      if (cancelled) return;
      if (s && s.setupRequired === false) {
        const resume = loadResume();
        if (resume) {
          await ensureSession();
          if (cancelled) return;
          if (useAuthStore.getState().accessToken) {
            setStatus(s);
            setWithSecrets(resume.withSecrets === true);
            setCertStep(resume.withCertificate === true);
            setCommitted(true);
            setSummary((p) => ({ ...p, domain: resume.domain, hostname: resume.hostname, email: resume.email }));
            if (resume.secretsConfirmed) setForm((f) => ({ ...f, secretsConfirmed: true }));
            setStep(
              (resume.step === 'secrets' && resume.withSecrets !== true) || (resume.step === 'certificate' && resume.withCertificate !== true)
                ? 'done' : resume.step,
            );
            setReady(true);
            return;
          }
        }
        clearResume();
        window.location.href = '/login';
        return;
      }
      clearResume();
      setStatus(s);
      setWithSecrets(s?.secretsGenerated === true);
      setForm((f) => ({ ...f, tokenRequired: s?.setupTokenRequired !== false }));
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Focus the step heading on every step change (screen readers announce it).
  useEffect(() => {
    if (!ready) return;
    if (firstRender.current) { firstRender.current = false; return; }
    headingRef.current?.focus();
  }, [step, ready]);

  // Keep the resume marker current after the commit.
  useEffect(() => {
    if (!committed || isPreCommit(step)) return;
    saveResume({
      step: step as 'secrets' | 'certificate' | 'done',
      domain: summary.domain, hostname: summary.hostname, email: summary.email, withSecrets,
      ...(form.secretsConfirmed ? { secretsConfirmed: true } : {}),
      ...(certStep ? { withCertificate: true } : {}),
    });
  }, [committed, step, summary, withSecrets, form.secretsConfirmed, certStep]);

  // 10.6: entering the certificate step loads the names, the contact default
  // and the order a reload left running; a host name the server does not see
  // as public skips the step.
  useEffect(() => {
    if (step !== 'certificate' || certInfo) return;
    let cancelled = false;
    void (async () => {
      let info: CertificateStepInfo;
      try {
        info = await api.get<CertificateStepInfo>(CERT_STATUS_PATH);
      } catch (err) {
        if (cancelled) return;
        const status = (err as { status?: number }).status;
        setCertInfo({ eligible: true, hostname: summary.hostname, domains: [], sans: [], contactEmail: null, termsOfServiceUrl: '', certificate: null });
        setCertPhase('failed');
        setCertResult({ kind: 'error', reason: status === 404 ? 'window-closed' : status === 429 ? 'rate-limited' : 'failed', message: null });
        return;
      }
      if (cancelled) return;
      if (!info.eligible) { setCertStep(false); setStep('done'); return; }
      setCertInfo(info);
      setForm((f) => (f.acmeEmail ? f : { ...f, acmeEmail: info.contactEmail ?? summary.email }));
      const state = resumeState(info.certificate);
      if (state === 'done') { setCertPhase('done'); return; }
      if (state === 'failed' && info.certificate) {
        setCertPhase('failed');
        setCertResult({ kind: 'issuance-failed', code: info.certificate.lastErrorCode, message: info.certificate.lastError, certificateId: info.certificate.id });
        return;
      }
      if (state === 'running') {
        const run = ++certRun.current;
        const r = await waitForCertificate(api, {
          email: info.contactEmail ?? summary.email,
          onPhase: (p) => { if (certRun.current === run) setCertPhase(p); },
          alive: () => certRun.current === run,
        });
        if (certRun.current === run) setCertResult(r);
      }
    })();
    return () => { cancelled = true; };
  }, [step, certInfo, summary.hostname, summary.email]);

  // Leaving the certificate step stops polling (the order itself keeps running on the server).
  useEffect(() => {
    if (step !== 'certificate') certRun.current++;
  }, [step]);

  // Reaching the summary closes the secrets download on the server (once).
  useEffect(() => {
    if (step !== 'done' || !committed || summary.sessionMissing || finishSent.current) return;
    finishSent.current = true;
    void apiFetch('/api/v1/setup/finish', { method: 'POST', body: '{}' }, 'application/json').catch(() => undefined);
  }, [step, committed, summary.sessionMissing]);

  const patch = useCallback((p: Partial<WizardForm>) => {
    setForm((f) => ({ ...f, ...p }));
    setError(null);
    setInvalidField(null);
  }, []);

  const onDomain = useCallback((v: string) => {
    setForm((f) => ({ ...f, domain: v, ...(hostnameEdited ? {} : { hostname: defaultHostname(v) }) }));
    setError(null);
    setInvalidField(null);
  }, [hostnameEdited]);

  const onHostname = useCallback((v: string) => {
    setHostnameEdited(true);
    patch({ hostname: v });
  }, [patch]);

  // ── Secrets download (admin session) ────────────────────────────────────────
  const downloadSecrets = useCallback(async () => {
    setDownload({ kind: 'busy' });
    try {
      const res = await apiFetch(SECRETS_DOWNLOAD_PATH);
      if (!res.ok) {
        setDownload({ kind: 'error', reason: res.status === 404 ? 'gone' : res.status === 401 || res.status === 403 ? 'session' : 'failed' });
        return;
      }
      const filename = downloadFilename(res.headers.get('Content-Disposition'), summary.hostname);
      saveBlob(await res.blob(), filename);
      setDownload({ kind: 'done', filename });
    } catch {
      setDownload({ kind: 'error', reason: 'failed' });
    }
  }, [summary.hostname]);

  // ── Navigation ──────────────────────────────────────────────────────────────
  const go = (s: WizardStepId | null) => {
    if (!s) return;
    setError(null);
    setInvalidField(null);
    setStep(s);
  };

  const verifyToken = async (): Promise<boolean> => {
    const token = form.token.trim();
    const res = await fetch('/api/v1/setup/verify-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken: token }),
    });
    if (res.ok) { setForm((f) => ({ ...f, verifiedToken: token })); return true; }
    if (res.status === 409) { setAlreadyDone(true); setError(t('wiz_err_already_done')); return false; }
    if (res.status === 429) { setError(t('wiz_err_rate_limited')); return false; }
    setError(t('wiz_token_invalid'));
    setInvalidField('wiz-token');
    return false;
  };

  const commit = async () => {
    const body = completeBody(form);
    const res = await fetch('/api/v1/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as { error?: string; code?: string; hostname?: string; domain?: string };
    if (!res.ok) {
      if (res.status === 409) { setAlreadyDone(true); setError(t('wiz_err_already_done')); return; }
      if (res.status === 429) { setError(t('wiz_err_rate_limited')); return; }
      if (data.code === 'SETUP_TOKEN_INVALID') {
        setForm((f) => ({ ...f, verifiedToken: null }));
        setStep('welcome');
        setError(t('wiz_token_invalid'));
        setInvalidField('wiz-token');
        return;
      }
      setError(data.error ?? t('wiz_err_failed'));
      return;
    }
    const email = body['email'] ?? '';
    // Sign in with the new admin account (same path as the login page): the
    // secrets download and the finish marker use this session.
    let signedIn = false;
    try {
      const r = await login(email, form.password);
      if ('accessToken' in r) {
        setTokens(r.accessToken, r.refreshToken);
        const profile = await api.get<UserProfile>('/user/profile');
        setProfile(profile.id, profile.email, profile.displayName, profile.role);
        signedIn = true;
      }
    } catch { /* setup is done; the summary points to the sign-in page */ }
    // the password and the token are not kept after the commit
    setForm((f) => ({ ...f, password: '', confirm: '', token: '', verifiedToken: null }));
    // 10.6: the certificate step needs the admin session (setup-window routes).
    const hostname = data.hostname ?? body['hostname'] ?? '';
    const certOn = signedIn && showCertificateStep(hostname);
    setCertStep(certOn);
    setCommitted(true);
    setSummary({
      domain: data.domain ?? body['domain'] ?? '', hostname, email,
      sessionMissing: !signedIn,
    });
    go(nextStep(wizardSteps({ secretsGenerated: withSecrets, certificate: certOn }), step));
  };

  // ── Certificate (10.6) ──────────────────────────────────────────────────────
  const requestCertificate = async () => {
    const run = ++certRun.current;
    const alive = () => certRun.current === run;
    setCertResult(null);
    setCertReport(null);
    const r = await runSetupCertificate(api, {
      email: form.acmeEmail,
      onPhase: (p) => { if (alive()) setCertPhase(p); },
      onReport: (rep) => { if (alive()) setCertReport(rep); },
      alive,
    });
    if (alive()) setCertResult(r);
  };

  const certLater = () => {
    certRun.current++;
    go(nextStep(steps, 'certificate'));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || step === 'done') return;
    const reason = blockReason(step, form);
    if (reason) {
      setError(t(REASON_TEXT[reason]));
      setInvalidField(REASON_FIELD[reason]);
      document.getElementById(REASON_FIELD[reason])?.focus();
      return;
    }
    if (step === 'certificate') {
      if (certPhase === 'done') go(nextStep(steps, step));
      else if (!isCertRunning(certPhase) && certInfo) void requestCertificate();
      return;
    }
    setBusy(true);
    try {
      if (step === 'welcome' && tokenNeedsCheck(form) && !(await verifyToken())) return;
      if (!committed && step === commitStep(steps)) { await commit(); return; }
      go(nextStep(steps, step));
    } catch {
      setError(t('wiz_err_network'));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return (
      <AuthShell>
        <div className="text-white text-sm animate-pulse" role="status">{t('wiz_loading')}</div>
      </AuthShell>
    );
  }

  const back = previousStep(steps, step, committed);
  const certRunning = isCertRunning(certPhase);
  const isCommitStep = !committed && step === commitStep(steps);
  const title = step === 'welcome' ? fmt(t('wiz_welcome_title'), { name: productName }) : t(STEP_LABEL[step]);
  const hasFormFooter = step !== 'done';
  const insecure = insecureConnection(status?.secureConnection, window.location.protocol);

  return (
    <AuthShell>
      <main className="bg-surface rounded-lg shadow-2xl w-full max-w-2xl overflow-hidden">
        <header className="bg-accent px-4 py-4 sm:px-8 sm:py-5">
          <div className="flex items-center gap-3">
            <Mail size={24} className="text-white" aria-hidden="true" />
            <span className="text-white text-lg font-semibold">{productName}</span>
          </div>
          <p className="text-white text-sm mt-0.5">{t('wiz_title')}</p>
        </header>

        <form onSubmit={(e) => void onSubmit(e)} noValidate className="px-4 py-5 sm:px-8 sm:py-6">
          <WizardProgress steps={steps} current={step} />
          <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-fg mb-3 focus:outline-none">{title}</h2>

          {error && (
            <div className="mb-4">
              <Alert tone="danger">
                {error}
                {alreadyDone && (
                  <>{' '}<a href="/login" className="underline font-medium">{t('wiz_to_login')}</a></>
                )}
              </Alert>
            </div>
          )}

          {step === 'welcome' && <WelcomeStep form={form} status={status} invalid={invalidField === 'wiz-token'} onChange={patch} />}
          {step === 'domain' && (
            <DomainStep form={form} invalidField={invalidField} onDomain={onDomain} onHostname={onHostname} onChange={patch} />
          )}
          {step === 'admin' && <AdminStep form={form} invalidField={invalidField} onChange={patch} />}
          {step === 'secrets' && (
            <SecretsStep
              form={form} status={status} insecure={insecure} sessionMissing={summary.sessionMissing} download={download}
              invalid={invalidField === 'wiz-secrets-ok'} onDownload={() => void downloadSecrets()} onChange={patch}
            />
          )}
          {step === 'certificate' && (
            <CertificateStep
              info={certInfo} loading={!certInfo} form={form} invalidField={invalidField}
              phase={certPhase} report={certReport} result={certResult} onChange={patch}
            />
          )}
          {step === 'done' && <DoneStep summary={summary} certificateIssued={certStep && certPhase === 'done'} />}

          {isCommitStep && <p className="text-xs text-fg-subtle mt-4">{t('wiz_commit_hint')}</p>}

          {(hasFormFooter || back) && (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                {back && (
                  <button type="button" onClick={() => go(back)} disabled={busy || certRunning} className={BUTTON_SECONDARY}>
                    {t('wiz_back')}
                  </button>
                )}
                {step === 'certificate' && certPhase !== 'done' && (
                  <button type="button" onClick={certLater} disabled={certPhase === 'ordering'} className={BUTTON_SECONDARY}>
                    {t('wiz_cert_later')}
                  </button>
                )}
              </div>
              {hasFormFooter && step === 'certificate' ? (
                <button type="submit" disabled={certRunning || !certInfo} className={`${BUTTON_PRIMARY} inline-flex items-center gap-2`}>
                  {certRunning && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                  {certPhase === 'done' ? t('wiz_next')
                    : certRunning ? t('wiz_cert_requesting')
                      : certPhase === 'failed' ? t('wiz_cert_retry') : t('wiz_cert_request')}
                </button>
              ) : hasFormFooter && (
                <button type="submit" disabled={busy || alreadyDone} className={BUTTON_PRIMARY}>
                  {busy
                    ? (step === 'welcome' ? t('wiz_token_checking') : isCommitStep ? t('wiz_committing') : t('wiz_next'))
                    : isCommitStep ? t('wiz_commit') : t('wiz_next')}
                </button>
              )}
            </div>
          )}
        </form>
      </main>
    </AuthShell>
  );
}
