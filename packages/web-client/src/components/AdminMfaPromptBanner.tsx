import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { fmt, useT } from '../i18n/useT.js';
import { adminPromptView, dayKey, type MfaEnforcementInfo } from '../lib/mfaEnforcement.js';

/**
 * 10.6: dismissible prompt of the app frame for an admin account under the
 * admin MFA rule during its grace period (GET /user/mfa-enforcement → `admin`).
 * "Später" hides it for the rest of the day in this browser — the deadline never
 * moves; the webmail itself is never blocked by the admin rule.
 */
const DISMISS_KEY = 'coremail:mfa-admin-prompt-dismissed';

function readDismissed(): string | null {
  try { return window.localStorage.getItem(DISMISS_KEY); } catch { return null; }
}

export function AdminMfaPromptBanner({ info }: { info: MfaEnforcementInfo | undefined }) {
  const t = useT();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const view = adminPromptView(info, dismissed, new Date());
  if (!view) return null;
  const days = view.daysLeft === 0 ? t('mfa_enforce_days_zero')
    : view.daysLeft === 1 ? t('mfa_enforce_days_one')
      : fmt(t('mfa_enforce_days_many'), { n: view.daysLeft });
  const date = view.deadline.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const later = () => {
    const key = dayKey(new Date());
    try { window.localStorage.setItem(DISMISS_KEY, key); } catch { /* storage unavailable: hide for this view only */ }
    setDismissed(key);
  };
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm bg-warning-bg text-warning-fg border-b border-warning-line">
      <ShieldAlert size={16} aria-hidden="true" className="shrink-0" />
      <span className="flex-1 min-w-0">{fmt(t('mfa_admin_prompt'), { date, days })}</span>
      <Link to="/settings#security" className="font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg rounded">
        {t('mfa_enforce_banner_action')}
      </Link>
      <button type="button" onClick={later} className="font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg rounded">
        {t('mfa_admin_prompt_later')}
      </button>
    </div>
  );
}
