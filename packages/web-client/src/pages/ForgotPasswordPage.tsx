/**
 * "Passwort vergessen?" — requests a reset link (10.6, docs/password-reset.md).
 * The server answers identically for every address (no enumeration); the link
 * goes to the confirmed recovery address and / or the own mailbox, as the
 * administrator's policy allows.
 */
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Mail, ArrowLeft, CheckCircle, KeyRound } from 'lucide-react';
import { api } from '../api/client.js';
import { AuthShell, AuthBrandHeader } from '../components/AuthShell.js';
import { useT, fmt } from '../i18n/useT.js';

export function ForgotPasswordPage() {
  const t = useT();
  const [email, setEmail]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [sent, setSent]         = useState(false);
  const [error, setError]       = useState('');
  const [allowed, setAllowed]   = useState(true);

  // 10.6: public availability flag (switch on and at least one method)
  useEffect(() => {
    fetch('/auth/password-reset/available')
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => { if (d.enabled === false) setAllowed(false); })
      .catch(() => { /* keep the form; the server decides */ });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err: unknown) {
      // Even on error: generic message (no user enumeration)
      setError(err instanceof Error ? err.message : t('sspr_error_generic'));
    } finally {
      setLoading(false);
    }
  };

  const back = (
    <Link to="/login" className="w-full flex items-center justify-center gap-1.5 text-sm text-fg-subtle hover:text-fg-muted py-1">
      <ArrowLeft size={13} aria-hidden="true" /> {t('sspr_back_to_login')}
    </Link>
  );

  return (
    <AuthShell>
      <div className="bg-surface rounded-lg shadow-2xl p-8 w-full max-w-sm">
        <AuthBrandHeader
          subtitle={t('sspr_forgot_title')}
          icon={
            <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
              <KeyRound size={22} className="text-white" aria-hidden="true" />
            </div>
          }
        />

        {!allowed ? (
          <div className="text-center space-y-4">
            <div role="status" className="bg-warning-bg border border-warning-line rounded-lg px-4 py-3 text-sm text-warning-fg">
              {t('sspr_disabled')}
            </div>
            {back}
          </div>
        ) : sent ? (
          <div className="text-center space-y-4" role="status" aria-live="polite">
            <CheckCircle size={48} className="mx-auto text-success-fg" aria-hidden="true" />
            <h2 className="font-semibold text-fg">{t('sspr_sent_title')}</h2>
            <p className="text-sm text-fg-muted">{fmt(t('sspr_sent_text'), { email })}</p>
            <p className="text-xs text-fg-subtle">{t('sspr_sent_hint')}</p>
            {back}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate={false}>
            <p className="text-sm text-fg-muted">{t('sspr_forgot_intro')}</p>
            <div>
              <label htmlFor="sspr-email" className="block text-sm font-medium text-fg-muted mb-1">{t('sspr_email_label')}</label>
              <div className="relative">
                <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
                <input
                  id="sspr-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input pl-9"
                  placeholder={t('sspr_email_placeholder')}
                  required
                  autoComplete="email"
                  autoFocus
                />
              </div>
            </div>

            {error && (
              <div role="alert" className="bg-danger-bg border border-danger-line rounded px-3 py-2 text-sm text-danger-fg">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email}
              className="btn-primary w-full justify-center py-2 disabled:opacity-60"
            >
              {loading ? t('sspr_sending') : t('sspr_send')}
            </button>
            {back}
          </form>
        )}
      </div>
    </AuthShell>
  );
}
