import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Fingerprint, Loader2 } from 'lucide-react';
import { AuthShell, AuthBrandHeader } from '../components/AuthShell.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { ApiError } from '../lib/errors.js';
import { passkeyBrowserErrorKey, passkeyErrorKey, recoveryTokenFromHash } from '../lib/passkeys.js';
import { webauthnFailure, webauthnRegister, webauthnSupported } from '../lib/webauthn.js';
import { recoveryOptions, recoveryVerify } from '../api/passkeys.js';

/**
 * 10.6: `/passkey-recovery#<token>` — redeems a one-time recovery link an
 * admin issued (BCP → Postfach → Passkeys): registers a new passkey without a
 * session; the server signs out every other session. The token travels in
 * the fragment (never sent to a server log or a Referer). No WebAuthn prompt
 * on page load — the user starts it with the button (WCAG 3.3.8).
 */
export function PasskeyRecoveryPage() {
  const t = useT();
  const [token] = useState(() => recoveryTokenFromHash(window.location.hash));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const start = async () => {
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      const opts = await recoveryOptions(token);
      let response: Record<string, unknown>;
      try {
        response = await webauthnRegister(opts.publicKey);
      } catch (err) {
        setError(t(passkeyBrowserErrorKey(webauthnFailure(err)) as TranslationKey));
        return;
      }
      await recoveryVerify(token, opts.flowId, response, name.trim() || t('pk_default_name'));
      // the token is used up — keep it out of the history
      window.history.replaceState(null, '', window.location.pathname);
      setDone(true);
    } catch (err) {
      setError(t(passkeyErrorKey(err instanceof ApiError ? err.code : undefined) as TranslationKey));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <main className="bg-surface rounded-lg shadow-2xl p-8 w-full max-w-sm border border-transparent">
        <AuthBrandHeader
          subtitle={t('pk_recovery_title')}
          icon={
            <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
              <Fingerprint size={22} className="text-white" aria-hidden="true" />
            </div>
          }
        />
        {done ? (
          <div className="space-y-4">
            <p role="status" className="flex items-start gap-2 text-sm text-success-fg">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{t('pk_recovery_done')}
            </p>
            <Link to="/login" className="btn-primary w-full justify-center py-2">{t('pk_recovery_to_login')}</Link>
          </div>
        ) : !token ? (
          <p role="alert" className="text-sm text-danger-fg">{t('pk_recovery_missing')}</p>
        ) : !webauthnSupported() ? (
          <p role="alert" className="text-sm text-warning-fg">{t('pk_unsupported')}</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-fg-muted">{t('pk_recovery_text')}</p>
            <div>
              <label htmlFor="pk-recovery-name" className="block text-sm font-medium text-fg-muted mb-1">{t('pk_name_label')}</label>
              <input id="pk-recovery-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)}
                placeholder={t('pk_name_placeholder')} className="input" />
            </div>
            {error && <p role="alert" className="bg-danger-bg border border-danger-line rounded px-3 py-2 text-sm text-danger-fg">{error}</p>}
            <button type="button" onClick={() => { void start(); }} disabled={busy}
              className="btn-primary w-full justify-center py-2 inline-flex items-center gap-2 disabled:opacity-60">
              {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Fingerprint size={15} aria-hidden="true" />}
              {t('pk_recovery_start')}
            </button>
          </div>
        )}
      </main>
    </AuthShell>
  );
}
