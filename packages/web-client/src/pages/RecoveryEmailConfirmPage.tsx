/**
 * 10.6: confirmation link of a recovery address (mailed to that address —
 * opened wherever it is read, so no session is needed). The token is read once
 * and removed from the address bar; POST /auth/recovery-email/confirm.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle, MailCheck, XCircle } from 'lucide-react';
import { AuthShell, AuthBrandHeader } from '../components/AuthShell.js';
import { useT } from '../i18n/useT.js';

export function RecoveryEmailConfirmPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const [token] = useState(() => searchParams.get('token') ?? '');
  const [state, setState] = useState<'checking' | 'done' | 'failed'>('checking');
  const sent = useRef(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('token')) {
      url.searchParams.delete('token');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
    // Single-use token: send it exactly once (React strict mode runs effects twice).
    if (sent.current) return;
    sent.current = true;
    if (!token) { setState('failed'); return; }
    fetch('/auth/recovery-email/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((r) => setState(r.ok ? 'done' : 'failed'))
      .catch(() => setState('failed'));
  }, [token]);

  return (
    <AuthShell>
      <div className="bg-surface rounded-lg shadow-2xl p-8 w-full max-w-sm">
        <AuthBrandHeader
          subtitle={t('sspr_confirm_title')}
          icon={
            <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
              <MailCheck size={22} className="text-white" aria-hidden="true" />
            </div>
          }
        />
        <div className="text-center space-y-4" role="status" aria-live="polite">
          {state === 'checking' && (
            <>
              <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" aria-hidden="true" />
              <p className="text-sm text-fg-subtle">{t('sspr_confirm_checking')}</p>
            </>
          )}
          {state === 'done' && (
            <>
              <CheckCircle size={48} className="mx-auto text-success-fg" aria-hidden="true" />
              <p className="text-sm text-fg-muted">{t('sspr_confirm_done')}</p>
            </>
          )}
          {state === 'failed' && (
            <>
              <XCircle size={48} className="mx-auto text-danger-fg" aria-hidden="true" />
              <p className="text-sm text-fg-muted">{t('sspr_confirm_failed')}</p>
            </>
          )}
          {state !== 'checking' && (
            <Link to="/login" className="flex items-center justify-center gap-1.5 text-sm text-fg-subtle hover:text-fg-muted py-1">
              <ArrowLeft size={13} aria-hidden="true" /> {t('sspr_back_to_login')}
            </Link>
          )}
        </div>
      </div>
    </AuthShell>
  );
}
