import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { fmt, useT } from '../i18n/useT.js';
import { BANNER_CARD_CLASS } from '../lib/paneLayout.js';

/**
 * 10.5: banner of the app frame during the grace period of "MFA für alle
 * Benutzer erzwingen" — days left, deadline and a link to Settings → Sicherheit.
 */
export function MfaGraceBanner({ daysLeft, deadline }: { daysLeft: number; deadline: Date }) {
  const t = useT();
  const days = daysLeft === 0 ? t('mfa_enforce_days_zero')
    : daysLeft === 1 ? t('mfa_enforce_days_one')
      : fmt(t('mfa_enforce_days_many'), { n: daysLeft });
  const date = deadline.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
  return (
    <div role="status" className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm bg-warning-bg text-warning-fg ${BANNER_CARD_CLASS}`}>
      <ShieldAlert size={16} aria-hidden="true" className="shrink-0" />
      <span className="flex-1 min-w-0">{fmt(t('mfa_enforce_banner'), { date, days })}</span>
      <Link to="/settings#security" className="font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg rounded">
        {t('mfa_enforce_banner_action')}
      </Link>
    </div>
  );
}
