/**
 * Small building blocks of the setup wizard (pages/SetupPage.tsx): progress
 * list, text field, copyable value, password meter, status badge.
 * Module-level components only (no components defined inside components).
 */
import { useState, type ReactNode } from 'react';
import { Check, CheckCircle2, Copy, AlertTriangle, XCircle } from 'lucide-react';
import { copyToClipboard } from '../../api/clipboard.js';
import { useT, fmt } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';
import { passwordScore, type WizardStepId } from '../../lib/setupWizard.js';

export const STEP_LABEL: Record<WizardStepId, TranslationKey> = {
  welcome: 'wiz_step_welcome',
  domain: 'wiz_step_domain',
  admin: 'wiz_step_admin',
  secrets: 'wiz_step_secrets',
  dns: 'wiz_step_dns',
  certificate: 'wiz_step_certificate',
  done: 'wiz_step_done',
};

export const INPUT_CLASS =
  'w-full border border-line-strong rounded px-3 py-2 text-sm bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent-fg focus:border-transparent aria-[invalid=true]:border-danger-line';

/** "Schritt x von n" plus the list of steps (current one marked for screen readers). */
export function WizardProgress({ steps, current }: { steps: readonly WizardStepId[]; current: WizardStepId }) {
  const t = useT();
  const index = Math.max(0, steps.indexOf(current));
  return (
    <div className="mb-6">
      <p className="text-xs font-medium text-fg-muted mb-2">
        {fmt(t('wiz_progress'), { index: index + 1, total: steps.length })}
      </p>
      <ol aria-label={t('wiz_steps_label')} className="flex gap-1">
        {steps.map((s, i) => (
          <li key={s} aria-current={s === current ? 'step' : undefined} className="flex-1 min-w-0">
            <span
              aria-hidden="true"
              className={`block h-1.5 rounded-full ${i < index ? 'bg-accent' : i === index ? 'bg-accent-fg' : 'bg-surface-3'}`}
            />
            <span className="sr-only">
              {t(STEP_LABEL[s])}{i < index ? ` (${t('wiz_step_done_sr')})` : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Field({ id, label, hint, error, children }: {
  id: string; label: string; hint?: ReactNode; error?: string | null; children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-fg-muted mb-1">{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="text-xs text-fg-subtle mt-1">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-xs text-danger-fg mt-1">{error}</p>}
    </div>
  );
}

/** A value in monospace with a copy button (DNS values, backup commands). */
export function CopyValue({ value, label }: { value: string; label: string }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await copyToClipboard(value);
      setState('copied');
      window.setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('failed');
    }
  };
  return (
    <div>
      <div className="flex items-start gap-2">
        <code className="flex-1 min-w-0 break-all rounded bg-surface-2 px-2 py-1.5 text-xs font-mono text-fg">{value}</code>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={fmt(t('wiz_copy_named'), { label })}
          className="shrink-0 inline-flex items-center gap-1 rounded border border-line-strong px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg"
        >
          {state === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span>{state === 'copied' ? t('wiz_copied') : t('wiz_copy')}</span>
        </button>
      </div>
      <span role="status" className="sr-only">{state === 'copied' ? t('wiz_copied') : ''}</span>
      {state === 'failed' && <p className="text-xs text-danger-fg mt-1">{t('wiz_copy_failed')}</p>}
    </div>
  );
}

const STRENGTH_KEYS: Record<1 | 2 | 3 | 4, TranslationKey> = {
  1: 'wiz_strength_1', 2: 'wiz_strength_2', 3: 'wiz_strength_3', 4: 'wiz_strength_4',
};
const STRENGTH_FILL: Record<1 | 2 | 3 | 4, string> = {
  1: 'bg-danger', 2: 'bg-warning', 3: 'bg-success', 4: 'bg-success',
};
const STRENGTH_TEXT: Record<1 | 2 | 3 | 4, string> = {
  1: 'text-danger-fg', 2: 'text-warning-fg', 3: 'text-success-fg', 4: 'text-success-fg',
};

export function PasswordMeter({ password, id }: { password: string; id: string }) {
  const t = useT();
  const score = passwordScore(password);
  return (
    <div id={id} className="mt-2" aria-live="polite">
      {score > 0 && (
        <>
          <div className="flex gap-1" aria-hidden="true">
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={`h-1.5 flex-1 rounded-full ${i <= score ? STRENGTH_FILL[score as 1 | 2 | 3 | 4] : 'bg-surface-3'}`} />
            ))}
          </div>
          <p className={`text-xs font-medium mt-1 ${STRENGTH_TEXT[score as 1 | 2 | 3 | 4]}`}>
            {fmt(t('wiz_strength'), { label: t(STRENGTH_KEYS[score as 1 | 2 | 3 | 4]) })}
          </p>
        </>
      )}
    </div>
  );
}

/** Status of a DNS record: icon + text (never colour alone). */
export function RecordStatus({ ok, mismatch }: { ok: boolean; mismatch: boolean }) {
  const t = useT();
  if (ok) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success-fg">
        <CheckCircle2 size={14} aria-hidden="true" />{t('wiz_dns_ok')}
      </span>
    );
  }
  if (mismatch) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-warning-fg">
        <AlertTriangle size={14} aria-hidden="true" />{t('wiz_dns_mismatch')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-danger-fg">
      <XCircle size={14} aria-hidden="true" />{t('wiz_dns_missing')}
    </span>
  );
}

export function Alert({ tone, children }: { tone: 'danger' | 'warning' | 'success' | 'info'; children: ReactNode }) {
  const cls = {
    danger: 'bg-danger-bg border-danger-line text-danger-fg',
    warning: 'bg-warning-bg border-warning-line text-warning-fg',
    success: 'bg-success-bg border-success-line text-success-fg',
    info: 'bg-info-bg border-info-line text-info-fg',
  }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`border text-sm px-3 py-2 rounded ${cls}`}>
      {children}
    </div>
  );
}
