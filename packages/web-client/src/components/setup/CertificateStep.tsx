/**
 * Setup wizard, step "Zertifikat" (10.4). Three choices:
 *  - Let's Encrypt (only when the A and MX checks of the DNS step passed): the
 *    BCP flow — acme-suggestions → preflight → letsencrypt → poll the
 *    certificate. Ordered without mail services, so the issued certificate for
 *    the public host name takes over SMTP/IMAP/POP3 and HTTPS automatically
 *    (afterAcmeIssued, the server still uses the self-signed default).
 *  - reverse proxy: nothing is activated; the choice is recorded.
 *  - later: recorded; the BCP dashboard shows a dismissible hint.
 * Every choice is stored with PUT /api/v1/admin/setup-state/certificate-choice.
 */
import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { api } from '../../api/client.js';
import { useT, fmt } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';
import {
  acmeDomains, phaseForCertStatus, type CertificateChoice, type IssuancePhase,
} from '../../lib/setupWizard.js';
import { Alert } from './WizardParts.js';

interface PreflightCheck { id: string; status: 'ok' | 'warn' | 'error' | 'skip'; message: string }
interface PreflightReport {
  ok: boolean;
  domains: Array<{ domain: string; checks: PreflightCheck[] }>;
  external: { status: string; message: string };
}

const POLL_MS = 3_000;
const POLL_LIMIT_MS = 5 * 60_000;

const PHASE_TEXT: Partial<Record<IssuancePhase, TranslationKey>> = {
  preflight: 'wiz_cert_phase_preflight',
  ordering: 'wiz_cert_phase_ordering',
  waiting: 'wiz_cert_phase_waiting',
  done: 'wiz_cert_phase_done',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

function ChoiceOption({ value, checked, disabled, title, desc, note, onSelect }: {
  value: CertificateChoice; checked: boolean; disabled: boolean; title: string; desc: string; note?: string | undefined;
  onSelect: (v: CertificateChoice) => void;
}) {
  const id = `wiz-cert-${value}`;
  return (
    <div className={`rounded-lg border p-3 ${checked ? 'border-accent-fg bg-surface-2' : 'border-line'} ${disabled ? 'opacity-70' : ''}`}>
      <div className="flex items-start gap-3">
        <input
          id={id} type="radio" name="wiz-cert" value={value} checked={checked} disabled={disabled}
          onChange={() => onSelect(value)}
          aria-describedby={`${id}-desc`}
          className="mt-1 accent-current text-accent-fg"
        />
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-medium text-fg">{title}</label>
          <p id={`${id}-desc`} className="text-xs text-fg-muted mt-0.5">
            {desc}{note ? <><br /><span className="text-warning-fg">{note}</span></> : null}
          </p>
        </div>
      </div>
    </div>
  );
}

export function CertificateStep({ hostname, email, leAllowed, onFinished }: {
  hostname: string;
  email: string;
  leAllowed: boolean;
  onFinished: (choice: CertificateChoice, issued: boolean) => void;
}) {
  const t = useT();
  const [choice, setChoice] = useState<CertificateChoice | null>(leAllowed ? 'letsencrypt' : null);
  const [phase, setPhase] = useState<IssuancePhase>('idle');
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const busy = phase === 'preflight' || phase === 'ordering' || phase === 'waiting';

  const saveChoice = async (c: CertificateChoice) => {
    await api.put('/admin/setup-state/certificate-choice', { choice: c });
  };

  const runLetsEncrypt = async () => {
    setProblems([]); setError(null); setTimedOut(false);
    try {
      setPhase('preflight');
      const sug = await api.get<{ publicHostname: string | null; sans?: Array<{ name: string; resolvesHere: boolean }> }>(
        '/admin/certificates/acme-suggestions');
      const domains = acmeDomains(sug.publicHostname ?? hostname, sug.sans ?? []);
      const report = await api.post<PreflightReport>('/admin/certificates/preflight', { domains, external: true });
      if (!alive.current) return;
      if (!report.ok) {
        const msgs = report.domains.flatMap((d) => d.checks.filter((c) => c.status === 'error').map((c) => c.message));
        if (report.external.status === 'error') msgs.push(report.external.message);
        setProblems(msgs.length ? msgs : [report.external.message]);
        setPhase('failed');
        return;
      }
      setPhase('ordering');
      const cert = await api.post<{ id: string }>('/admin/certificates/letsencrypt', {
        name: domains[0], domains, email, services: [], autoRenew: true,
      });
      await saveChoice('letsencrypt');
      setPhase('waiting');
      const started = Date.now();
      while (alive.current && Date.now() - started < POLL_LIMIT_MS) {
        await sleep(POLL_MS);
        if (!alive.current) return;
        const c = await api.get<{ status: string; lastError?: string | null }>(`/admin/certificates/${encodeURIComponent(cert.id)}`);
        const p = phaseForCertStatus(c.status);
        if (p === 'done') { setPhase('done'); return; }
        if (p === 'failed') { setError(c.lastError ?? null); setPhase('failed'); return; }
      }
      if (alive.current) { setTimedOut(true); setPhase('failed'); }
    } catch (err) {
      if (!alive.current) return;
      setError(errText(err, t('wiz_err_network')));
      setPhase('failed');
    }
  };

  const apply = async () => {
    if (!choice) return;
    if (choice === 'letsencrypt') { await runLetsEncrypt(); return; }
    setError(null);
    try {
      setPhase('ordering');
      await saveChoice(choice);
      onFinished(choice, false);
    } catch (err) {
      setError(errText(err, t('wiz_err_network')));
      setPhase('idle');
    }
  };

  const phaseKey = PHASE_TEXT[phase];
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{fmt(t('wiz_cert_intro'), { host: hostname })}</p>

      <fieldset disabled={busy || phase === 'done'} className="space-y-2">
        <legend className="text-sm font-medium text-fg mb-2">{t('wiz_cert_choice_label')}</legend>
        <ChoiceOption
          value="letsencrypt" checked={choice === 'letsencrypt'} disabled={!leAllowed}
          title={t('wiz_cert_le')} desc={t('wiz_cert_le_desc')}
          note={leAllowed ? undefined : t('wiz_cert_le_blocked')}
          onSelect={setChoice}
        />
        <ChoiceOption
          value="proxy" checked={choice === 'proxy'} disabled={false}
          title={t('wiz_cert_proxy')} desc={`${t('wiz_cert_proxy_desc')} ${t('wiz_cert_proxy_note')}`}
          onSelect={setChoice}
        />
        <ChoiceOption
          value="later" checked={choice === 'later'} disabled={false}
          title={t('wiz_cert_later')} desc={t('wiz_cert_later_desc')}
          onSelect={setChoice}
        />
      </fieldset>

      <div aria-live="polite">
        {busy && phaseKey && choice === 'letsencrypt' && (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />{t(phaseKey)}
          </p>
        )}
        {phase === 'done' && (
          <Alert tone="success">
            <span className="inline-flex items-center gap-1.5"><ShieldCheck size={16} aria-hidden="true" />{t('wiz_cert_phase_done')}</span>
          </Alert>
        )}
      </div>

      {phase === 'failed' && (
        <Alert tone={timedOut ? 'warning' : 'danger'}>
          {timedOut ? t('wiz_cert_timeout') : (
            <>
              <p className="font-medium">{problems.length ? t('wiz_cert_preflight_failed') : t('wiz_cert_phase_failed')}</p>
              {problems.length > 0 && (
                <ul className="list-disc pl-5 mt-1 space-y-0.5">{problems.map((m) => <li key={m}>{m}</li>)}</ul>
              )}
              {error && <p className="mt-1 break-words">{error}</p>}
            </>
          )}
        </Alert>
      )}
      {phase !== 'failed' && error && <Alert tone="danger">{error}</Alert>}

      <div className="flex flex-wrap justify-end gap-2">
        {phase === 'done' || (phase === 'failed' && timedOut) ? (
          <button
            type="button"
            onClick={() => onFinished('letsencrypt', phase === 'done')}
            className="bg-accent hover:bg-accent-hover text-white font-medium py-2 px-4 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg focus-visible:ring-offset-2"
          >
            {t('wiz_next')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void apply()}
            disabled={!choice || busy}
            className="bg-accent hover:bg-accent-hover disabled:opacity-60 text-white font-medium py-2 px-4 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg focus-visible:ring-offset-2"
          >
            {choice === 'letsencrypt'
              ? (phase === 'failed' ? t('wiz_cert_retry') : t('wiz_cert_start'))
              : t('wiz_cert_apply')}
          </button>
        )}
      </div>
    </div>
  );
}
