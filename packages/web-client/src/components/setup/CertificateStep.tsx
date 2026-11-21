/**
 * Setup wizard step "Zertifikat" (10.6, pages/SetupPage.tsx, lib/setupCertificate.ts):
 * names of the order, contact e-mail for Let's Encrypt, the CA's terms of
 * service, the pre-flight checks with their status and — on failure — the
 * reason in plain words (the server's technical message under "Technische Details").
 * Module-level components only.
 */
import { Fragment, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { useT, fmt } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';
import type { WizardForm } from '../../lib/setupWizard.js';
import {
  blockingChecks, safeTermsUrl,
  type CertErrorReason, type CertPhase, type CertResult, type CertificateStepInfo, type CheckId, type CheckStatus,
  type PreflightCheck, type PreflightReport,
} from '../../lib/setupCertificate.js';
import { Alert, Field, INPUT_CLASS } from './WizardParts.js';

const CHECK_LABEL: Record<CheckId, TranslationKey> = {
  dns: 'wiz_cert_check_dns',
  ipv6: 'wiz_cert_check_ipv6',
  'server-ip': 'wiz_cert_check_server_ip',
  caa: 'wiz_cert_check_caa',
  local: 'wiz_cert_check_local',
  public: 'wiz_cert_check_public',
};

/** Plain explanation of a check that is not ok. */
const CHECK_WHY: Partial<Record<CheckId, TranslationKey>> = {
  dns: 'wiz_cert_why_dns',
  ipv6: 'wiz_cert_why_ipv6',
  'server-ip': 'wiz_cert_why_server_ip',
  caa: 'wiz_cert_why_caa',
  local: 'wiz_cert_why_local',
  public: 'wiz_cert_why_public',
};

const STATUS_TEXT: Record<CheckStatus, TranslationKey> = {
  ok: 'wiz_cert_status_ok', warn: 'wiz_cert_status_warn', error: 'wiz_cert_status_error', skip: 'wiz_cert_status_skip',
};

/** ACME error codes (api-gateway lib/acme-errors.ts) → plain explanation. */
const CODE_TEXT: Record<string, TranslationKey> = {
  connection: 'wiz_cert_code_connection',
  unauthorized: 'wiz_cert_code_unauthorized',
  dns: 'wiz_cert_code_dns',
  caa: 'wiz_cert_code_caa',
  'rate-limited': 'wiz_cert_code_rate_limited',
  'rejected-identifier': 'wiz_cert_code_rejected_identifier',
  tls: 'wiz_cert_code_tls',
  account: 'wiz_cert_code_account',
  'local-serving': 'wiz_cert_code_local_serving',
  network: 'wiz_cert_code_network',
  server: 'wiz_cert_code_server',
  timeout: 'wiz_cert_code_timeout',
  interrupted: 'wiz_cert_code_interrupted',
  busy: 'wiz_cert_code_busy',
  unknown: 'wiz_cert_code_unknown',
};

export function codeText(code: string | null | undefined): TranslationKey {
  return (code && CODE_TEXT[code]) || 'wiz_cert_code_unknown';
}

const ERROR_TEXT: Record<CertErrorReason, TranslationKey> = {
  'rate-limited': 'wiz_cert_error_rate',
  'window-closed': 'wiz_cert_error_window',
  'local-hostname': 'wiz_cert_error_local',
  busy: 'wiz_cert_error_busy',
  input: 'wiz_cert_error_failed',
  failed: 'wiz_cert_error_failed',
};

const PHASE_TEXT: Partial<Record<CertPhase, TranslationKey>> = {
  preflight: 'wiz_cert_phase_preflight',
  ordering: 'wiz_cert_phase_ordering',
  waiting: 'wiz_cert_phase_waiting',
  activating: 'wiz_cert_phase_activating',
};

export function isCertRunning(p: CertPhase): boolean {
  return p === 'preflight' || p === 'ordering' || p === 'waiting' || p === 'activating';
}

function StatusIcon({ status }: { status: CheckStatus }) {
  const cls = 'shrink-0 mt-px';
  if (status === 'ok') return <CheckCircle2 size={15} className={`${cls} text-success-fg`} aria-hidden="true" />;
  if (status === 'warn') return <AlertTriangle size={15} className={`${cls} text-warning-fg`} aria-hidden="true" />;
  if (status === 'error') return <XCircle size={15} className={`${cls} text-danger-fg`} aria-hidden="true" />;
  return <MinusCircle size={15} className={`${cls} text-fg-subtle`} aria-hidden="true" />;
}

function CheckRow({ domain, label, status, why }: { domain: string; label: string; status: CheckStatus; why: string | null }) {
  const t = useT();
  return (
    <li className="flex items-start gap-2 text-sm">
      <StatusIcon status={status} />
      <span className="min-w-0">
        <span className="text-fg">{label}</span>
        <span className="sr-only"> ({domain}): {t(STATUS_TEXT[status])}</span>
        {why && <span className="block text-xs text-fg-muted break-words">{why}</span>}
      </span>
    </li>
  );
}

function whyOf(t: (k: TranslationKey) => string, domain: string, c: PreflightCheck): string | null {
  if (c.status === 'ok' || c.status === 'skip') return null;
  const k = CHECK_WHY[c.id];
  return k ? fmt(t(k), { domain }) : null;
}

function ChecksList({ report }: { report: PreflightReport }) {
  const t = useT();
  return (
    <div className="space-y-3">
      {report.domains.map((d) => (
        <div key={d.domain}>
          <h4 className="text-xs font-semibold text-fg-muted mb-1 break-words">{fmt(t('wiz_cert_checks'), { domain: d.domain })}</h4>
          <ul className="space-y-1">
            {d.checks.map((c) => (
              <CheckRow key={c.id} domain={d.domain} label={t(CHECK_LABEL[c.id])} status={c.status} why={whyOf(t, d.domain, c)} />
            ))}
          </ul>
        </div>
      ))}
      <ul>
        <CheckRow
          domain={report.domains.map((d) => d.domain).join(', ')}
          label={t('wiz_cert_check_external')}
          status={report.external.status}
          why={report.external.status === 'error' ? t(codeText(report.external.code)) : null}
        />
      </ul>
    </div>
  );
}

function TechnicalDetails({ lines }: { lines: string[] }) {
  const t = useT();
  if (lines.length === 0) return null;
  return (
    <details className="mt-1.5">
      <summary className="cursor-pointer underline underline-offset-2 text-xs">{t('wiz_cert_details')}</summary>
      <ul className="mt-1 space-y-0.5 text-xs">
        {lines.map((l) => <li key={l} className="break-words">{l}</li>)}
      </ul>
    </details>
  );
}

function Failure({ result }: { result: CertResult }) {
  const t = useT();
  let body: ReactNode = null;
  let retryHint = true;
  if (result.kind === 'preflight-failed') {
    const blocking = blockingChecks(result.report);
    const ext = result.report.external;
    const reasons = [
      ...blocking.map(({ domain, check }) => whyOf(t, domain, check) ?? check.message),
      ...(ext.status === 'error' ? [t(codeText(ext.code))] : []),
    ].filter((v, i, a) => a.indexOf(v) === i);
    const tech = [
      ...blocking.map(({ domain, check }) => `${domain}: ${check.message}`),
      ...(ext.status === 'error' && ext.message ? [ext.message] : []),
    ];
    body = (
      <>
        <p className="font-medium">{t('wiz_cert_failed_preflight')}</p>
        <ul className="list-disc pl-5 mt-1 space-y-0.5">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        <TechnicalDetails lines={tech} />
      </>
    );
  } else if (result.kind === 'issuance-failed') {
    body = (
      <>
        <p className="font-medium">{t('wiz_cert_failed_issue')}</p>
        <p className="mt-1">{t(codeText(result.code))}</p>
        <TechnicalDetails lines={result.message ? [result.message] : []} />
      </>
    );
  } else if (result.kind === 'timeout') {
    body = <p>{t('wiz_cert_timeout')}</p>;
    retryHint = false;
  } else if (result.kind === 'error') {
    body = (
      <>
        <p>{t(ERROR_TEXT[result.reason])}</p>
        {result.reason === 'failed' && <TechnicalDetails lines={result.message ? [result.message] : []} />}
      </>
    );
    retryHint = result.reason === 'failed' || result.reason === 'busy';
  }
  if (!body) return null;
  return (
    <Alert tone="danger">
      {body}
      {retryHint && <p className="mt-1.5">{t('wiz_cert_failed_next')}</p>}
    </Alert>
  );
}

export function CertificateStep({ info, loading, form, invalidField, phase, report, result, onChange }: {
  info: CertificateStepInfo | null;
  loading: boolean;
  form: WizardForm;
  invalidField: string | null;
  phase: CertPhase;
  report: PreflightReport | null;
  result: CertResult | null;
  onChange: (p: Partial<WizardForm>) => void;
}) {
  const t = useT();
  if (loading || !info) {
    return <p className="text-sm text-fg-muted animate-pulse" role="status">{t('wiz_cert_loading')}</p>;
  }
  const running = isCertRunning(phase);
  const done = phase === 'done';
  const locked = running || done;
  const phaseKey = PHASE_TEXT[phase];
  const skipped = info.sans.filter((s) => !s.resolvesHere && !info.domains.includes(s.name));
  const inlineLink = 'underline underline-offset-2 text-accent-fg hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg rounded';
  const termsParts = t('wiz_cert_terms').split(/(\{terms\})/);
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{fmt(t('wiz_cert_intro'), { host: info.hostname ?? '' })}</p>
      <div className="text-sm">
        <p className="text-fg-muted">{t('wiz_cert_names')}</p>
        <ul className="list-disc pl-5 mt-1 text-fg">
          {info.domains.map((d) => <li key={d} className="break-words">{d}</li>)}
        </ul>
        {skipped.map((s) => (
          <p key={s.name} className="text-xs text-fg-subtle mt-1 break-words">{fmt(t('wiz_cert_name_skipped'), { name: s.name })}</p>
        ))}
      </div>
      <Field id="wiz-acme-email" label={t('wiz_cert_email_label')} hint={t('wiz_cert_email_hint')}>
        <input
          id="wiz-acme-email" type="email" autoComplete="email" spellCheck={false} required maxLength={254}
          value={form.acmeEmail} disabled={locked}
          aria-invalid={invalidField === 'wiz-acme-email'} aria-describedby="wiz-acme-email-hint"
          onChange={(e) => onChange({ acmeEmail: e.target.value })}
          className={`${INPUT_CLASS} disabled:opacity-60`}
        />
      </Field>
      <label htmlFor="wiz-acme-terms" className="flex items-start gap-2 text-sm text-fg cursor-pointer">
        <input
          id="wiz-acme-terms" type="checkbox" checked={form.acmeTermsAccepted} disabled={locked}
          aria-invalid={invalidField === 'wiz-acme-terms'}
          onChange={(e) => onChange({ acmeTermsAccepted: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-current text-accent-fg"
        />
        <span>
          {termsParts.map((part, i) => (
            <Fragment key={i}>
              {part === '{terms}' ? (
                <a href={safeTermsUrl(info.termsOfServiceUrl)} target="_blank" rel="noopener noreferrer" className={inlineLink}>
                  {t('wiz_cert_terms_link')}<span className="sr-only"> {t('wiz_new_tab')}</span>
                </a>
              ) : part}
            </Fragment>
          ))}
        </span>
      </label>

      <div aria-live="polite">
        {running && phaseKey && (
          <p className="text-sm text-fg-muted flex items-center gap-1.5">
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />{t(phaseKey)}
          </p>
        )}
        {done && <Alert tone="success">{t('wiz_cert_done')}</Alert>}
      </div>
      {report && !done && <ChecksList report={report} />}
      {phase === 'failed' && result && <Failure result={result} />}
      {!done && <p className="text-xs text-fg-subtle">{t('wiz_cert_later_hint')}</p>}
    </div>
  );
}
