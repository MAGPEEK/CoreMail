import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, ShieldAlert } from 'lucide-react';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import { adminPromptVisible, dayKey, daysLeft } from '../lib/mfaPolicy.js';

/**
 * 10.6: dismissible prompt while the admin MFA grace period runs
 * (GET /admin/mfa-status → state 'grace'). "Jetzt einrichten" opens the
 * webmail's Settings → Sicherheit (enrolment lives there); "Später" hides the
 * prompt for the rest of the day in this browser — the deadline itself never
 * moves (afterwards the admin API answers 403 MFA_REQUIRED → /bcp/mfa-required).
 */
const DISMISS_KEY = 'coremail:bcp:mfa-prompt-dismissed';

function readDismissed(): string | null {
  try { return window.localStorage.getItem(DISMISS_KEY); } catch { return null; }
}

export function AdminMfaPrompt() {
  const t = useT();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const { data } = useQuery({
    queryKey: ['admin-mfa-status'],
    queryFn: () => api.get<{ state: string; deadline?: string; canEnrol?: boolean }>('/admin/mfa-status'),
    staleTime: 5 * 60_000,
    retry: false,
    meta: { silentError: true },
  });
  const now = new Date();
  if (!adminPromptVisible(data, dismissed, now)) return null;
  const days = daysLeft(data!.deadline, now) ?? 0;
  const date = new Date(Date.parse(data!.deadline!)).toLocaleDateString();
  const later = () => {
    const key = dayKey(new Date());
    try { window.localStorage.setItem(DISMISS_KEY, key); } catch { /* storage unavailable: hide for this view only */ }
    setDismissed(key);
  };
  return (
    <div role="status" className="m-4 mb-0 flex flex-wrap items-center gap-3 px-3 py-2 rounded border border-warning-line bg-warning-bg text-warning-fg text-sm">
      <ShieldAlert size={16} className="shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-[240px]">
        <strong className="font-semibold">{t('mfap_prompt_title')}</strong>{' '}
        {t('mfap_prompt_text').replace('{days}', String(days)).replace('{date}', date)}
      </div>
      <a href="/settings#security" target="_blank" rel="noopener noreferrer" className="btn-primary text-xs">
        <ExternalLink size={13} aria-hidden="true" /> {t('mfap_prompt_now')}
      </a>
      <button type="button" onClick={later} className="btn-secondary text-xs">{t('mfap_prompt_later')}</button>
    </div>
  );
}
