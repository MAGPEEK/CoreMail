/**
 * First-run setup wizard (10.4, docs/setup-wizard.md).
 *
 *   welcome (setup token, checked with POST /setup/verify-token)
 *   → domain + host name + organisation
 *   → admin account (MFA only offered)
 *   → [back up secrets — only when the installation generated them]
 *   ⟨POST /setup/complete, then sign-in with the new admin (normal /auth/login)⟩
 *   → DNS (BCP domain DNS check with the admin session)
 *   → certificate (Let's Encrypt / reverse proxy / later)
 *   → done (summary + links)
 *
 * Step logic lives in lib/setupWizard.ts. After the commit the steps before it
 * are closed; a reload resumes at the post-commit step from a per-tab marker
 * (sessionStorage, no secrets) as long as the admin session is valid.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Mail, ExternalLink, ShieldCheck, Server, MonitorSmartphone } from 'lucide-react';
import { useBranding } from '../hooks/useBranding.js';
import { useT, fmt } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { api, ensureSession, login } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import type { UserProfile } from '../api/types.js';
import { AuthShell } from '../components/AuthShell.js';
import {
  wizardSteps, commitStep, nextStep, previousStep, isPreCommit, blockReason, tokenNeedsCheck, completeBody,
  defaultHostname, normalizeHost, showTokenFileHint, secretsFilePath, backupCommands, requiredDnsOk,
  letsEncryptAllowed, loadResume, saveResume, clearResume,
  type BlockReason, type CertificateChoice, type SetupStatus, type WizardForm, type WizardStepId,
} from '../lib/setupWizard.js';
import { Alert, CopyValue, Field, INPUT_CLASS, PasswordMeter, STEP_LABEL, WizardProgress } from '../components/setup/WizardParts.js';
import { DnsStep, type DnsReport } from '../components/setup/DnsStep.js';
import { CertificateStep } from '../components/setup/CertificateStep.js';

const REASON_TEXT: Record<BlockReason, TranslationKey> = {
  token: 'wiz_err_token',
  domain: 'wiz_err_domain',
  hostname: 'wiz_err_hostname',
  organization: 'wiz_err_organization',
  localPart: 'wiz_err_local',
  passwordLength: 'wiz_err_password_length',
  passwordMismatch: 'wiz_err_password_mismatch',
  secrets: 'wiz_err_secrets',
};

/** Which field an error belongs to (aria-invalid + focus). */
const REASON_FIELD: Record<BlockReason, string> = {
  token: 'wiz-token', domain: 'wiz-domain', hostname: 'wiz-hostname', organization: 'wiz-org',
  localPart: 'wiz-local', passwordLength: 'wiz-password', passwordMismatch: 'wiz-confirm', secrets: 'wiz-secrets-ok',
};

const EMPTY_FORM: WizardForm = {
  tokenRequired: true, token: '', verifiedToken: null, domain: '', hostname: '', organizationName: '',
  adminName: '', localPart: 'admin', password: '', confirm: '', secretsConfirmed: false,
};

const BUTTON_PRIMARY =
  'bg-accent hover:bg-accent-hover disabled:opacity-60 text-white font-medium py-2 px-4 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg focus-visible:ring-offset-2';
const BUTTON_SECONDARY =
  'border border-line-strong text-fg-muted hover:bg-surface-2 font-medium py-2 px-4 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg';

interface Summary {
  domain: string;
  hostname: string;
  email: string;
  dnsOk: boolean | null;
  certificate: CertificateChoice | null;
  certificateIssued: boolean;
  sessionMissing: boolean;
}

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
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{t('wiz_domain_intro')}</p>
      <Field id="wiz-domain" label={t('wiz_domain_label')} hint={t('wiz_domain_hint')}>
        <input
          id="wiz-domain" type="text" inputMode="url" autoComplete="off" spellCheck={false} required
          placeholder={t('wiz_domain_placeholder')} value={form.domain}
          aria-invalid={invalidField === 'wiz-domain'} aria-describedby="wiz-domain-hint"
          onChange={(e) => onDomain(e.target.value)} className={INPUT_CLASS}
        />
      </Field>
      <Field id="wiz-hostname" label={t('wiz_hostname_label')} hint={t('wiz_hostname_hint')}>
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

function SecretsStep({ form, status, invalid, onChange }: {
  form: WizardForm; status: SetupStatus | null; invalid: boolean; onChange: (p: Partial<WizardForm>) => void;
}) {
  const t = useT();
  const file = secretsFilePath(status);
  const cmds = backupCommands(file, t('wiz_secrets_target'));
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{t('wiz_secrets_intro')}</p>
      <CopyValue value={file} label={t('wiz_step_secrets')} />
      <Alert tone="warning">{t('wiz_secrets_warning')}</Alert>
      <div className="space-y-2">
        <p className="text-sm text-fg-muted">{t('wiz_secrets_copy_label')}</p>
        <CopyValue value={cmds.copy} label="cp" />
        <p className="text-sm text-fg-muted">{t('wiz_secrets_archive_label')}</p>
        <CopyValue value={cmds.archive} label="tar" />
      </div>
      <p className="text-xs text-fg-subtle">{t('wiz_secrets_offsite')} {t('wiz_secrets_no_values')}</p>
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

function DoneStep({ summary }: { summary: Summary }) {
  const t = useT();
  const dns = summary.dnsOk === null ? t('wiz_summary_dns_unknown') : summary.dnsOk ? t('wiz_summary_dns_ok') : t('wiz_summary_dns_open');
  const cert = summary.certificate === 'letsencrypt'
    ? (summary.certificateIssued ? t('wiz_summary_cert_le') : t('wiz_summary_cert_le_pending'))
    : summary.certificate === 'proxy' ? t('wiz_summary_cert_proxy')
      : summary.certificate === 'later' ? t('wiz_summary_cert_later') : t('wiz_summary_cert_none');
  const rows: Array<[string, string]> = [
    [t('wiz_summary_domain'), summary.domain],
    [t('wiz_summary_hostname'), summary.hostname],
    [t('wiz_summary_admin'), summary.email],
    [t('wiz_summary_dns'), dns],
    [t('wiz_summary_cert'), cert],
  ];
  const linkCls = 'flex items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-sm text-fg hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg';
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
  const [form, setForm] = useState<WizardForm>(EMPTY_FORM);
  const [hostnameEdited, setHostnameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const [alreadyDone, setAlreadyDone] = useState(false);
  const [dnsReport, setDnsReport] = useState<DnsReport | null>(null);
  const [dnsLoading, setDnsLoading] = useState(false);
  const [dnsError, setDnsError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary>({
    domain: '', hostname: '', email: '', dnsOk: null, certificate: null, certificateIssued: false, sessionMissing: false,
  });
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const firstRender = useRef(true);

  const steps = wizardSteps({ secretsGenerated: withSecrets });

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
            setWithSecrets(resume.withSecrets === true);
            setCommitted(true);
            setSummary((p) => ({
              ...p, domain: resume.domain, hostname: resume.hostname, email: resume.email,
              certificate: resume.certificateChoice ?? null,
            }));
            setStep(resume.step);
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
    if (!committed || step === 'welcome' || isPreCommit(step)) return;
    saveResume({
      step: step as 'dns' | 'certificate' | 'done',
      domain: summary.domain, hostname: summary.hostname, email: summary.email, withSecrets,
      ...(summary.certificate ? { certificateChoice: summary.certificate } : {}),
    });
  }, [committed, step, summary, withSecrets]);

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

  // ── DNS check (admin session) ───────────────────────────────────────────────
  const checkDns = useCallback(async () => {
    setDnsLoading(true);
    setDnsError(null);
    try {
      const list = await api.get<{ domains: Array<{ id: string; name: string; primary?: boolean }> }>('/admin/domains?limit=50');
      const d = list.domains.find((x) => x.name === summary.domain) ?? list.domains.find((x) => x.primary) ?? list.domains[0];
      if (!d) throw new Error('Domain not found');
      const report = await api.get<DnsReport>(`/admin/domains/${encodeURIComponent(d.id)}/dns-check`);
      setDnsReport(report);
      setSummary((p) => ({ ...p, dnsOk: requiredDnsOk(report.records) }));
    } catch (err) {
      setDnsError(err instanceof Error ? err.message : t('wiz_err_network'));
    } finally {
      setDnsLoading(false);
    }
  }, [summary.domain, t]);

  useEffect(() => {
    if ((step === 'dns' || step === 'certificate') && committed && !dnsReport && !dnsLoading && !dnsError && !summary.sessionMissing) void checkDns();
  }, [step, committed, dnsReport, dnsLoading, dnsError, summary.sessionMissing, checkDns]);

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
    const base: Summary = {
      domain: data.domain ?? body['domain'] ?? '', hostname: data.hostname ?? body['hostname'] ?? '', email,
      dnsOk: null, certificate: null, certificateIssued: false, sessionMissing: false,
    };
    // Sign in with the new admin account (same path as the login page): the
    // DNS and certificate steps use the admin API with this session.
    let signedIn = false;
    try {
      const r = await login(email, form.password);
      if ('accessToken' in r) {
        setTokens(r.accessToken, r.refreshToken);
        const profile = await api.get<UserProfile>('/user/profile');
        setProfile(profile.id, profile.email, profile.displayName, profile.role);
        signedIn = true;
      }
    } catch { /* setup is done; the remaining steps need the BCP */ }
    // the password and the token are not kept after the commit
    setForm((f) => ({ ...f, password: '', confirm: '', token: '', verifiedToken: null }));
    setCommitted(true);
    setSummary({ ...base, sessionMissing: !signedIn });
    setStep(signedIn ? 'dns' : 'done');
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // the certificate and the done step act through their own buttons
    if (busy || step === 'certificate' || step === 'done') return;
    const reason = blockReason(step, form);
    if (reason) {
      setError(t(REASON_TEXT[reason]));
      setInvalidField(REASON_FIELD[reason]);
      document.getElementById(REASON_FIELD[reason])?.focus();
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

  const onCertificateFinished = (choice: CertificateChoice, issued: boolean) => {
    setSummary((p) => ({ ...p, certificate: choice, certificateIssued: issued }));
    go('done');
  };

  if (!ready) {
    return (
      <AuthShell>
        <div className="text-white text-sm animate-pulse" role="status">{t('wiz_loading')}</div>
      </AuthShell>
    );
  }

  const back = previousStep(steps, step, committed);
  const isCommitStep = !committed && step === commitStep(steps);
  const title = step === 'welcome' ? fmt(t('wiz_welcome_title'), { name: productName }) : t(STEP_LABEL[step]);
  const hasFormFooter = step !== 'certificate' && step !== 'done';

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
          {step === 'secrets' && <SecretsStep form={form} status={status} invalid={invalidField === 'wiz-secrets-ok'} onChange={patch} />}
          {step === 'dns' && (
            <DnsStep
              domain={summary.domain} hostname={summary.hostname} report={dnsReport}
              loading={dnsLoading} error={dnsError} onRecheck={() => void checkDns()}
            />
          )}
          {step === 'certificate' && (
            <CertificateStep
              hostname={summary.hostname} email={summary.email}
              leAllowed={letsEncryptAllowed(dnsReport?.records)} onFinished={onCertificateFinished}
            />
          )}
          {step === 'done' && <DoneStep summary={summary} />}

          {isCommitStep && <p className="text-xs text-fg-subtle mt-4">{t('wiz_commit_hint')}</p>}

          {(hasFormFooter || back) && (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
              <div>
                {back && (
                  <button type="button" onClick={() => go(back)} disabled={busy} className={BUTTON_SECONDARY}>
                    {t('wiz_back')}
                  </button>
                )}
              </div>
              {hasFormFooter && (
                <button type="submit" disabled={busy || alreadyDone} className={BUTTON_PRIMARY}>
                  {busy
                    ? (step === 'welcome' ? t('wiz_token_checking') : isCommitStep ? t('wiz_committing') : t('wiz_next'))
                    : isCommitStep ? t('wiz_commit')
                      : step === 'dns' && !requiredDnsOk(dnsReport?.records) ? t('wiz_later')
                        : t('wiz_next')}
                </button>
              )}
            </div>
          )}
        </form>
      </main>
    </AuthShell>
  );
}
