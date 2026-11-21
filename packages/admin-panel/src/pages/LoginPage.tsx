import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, Shield, ShieldCheck, KeyRound, Loader2 } from 'lucide-react';
import { loginAdmin, setToken, type MfaMethod } from '../api/client.js';
import { MfaChallengeForm } from '../components/MfaChallengeForm.js';
import { SsoButtons } from '../components/SsoButtons.js';
import { AuthShell, AuthBrandHeader } from '../components/AuthShell.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { ApiError } from '../lib/errors.js';
import {
  conditionalMediationAvailable, signalUnknownCredential, webauthnAuthenticate, webauthnFailure, webauthnSupported,
} from '../lib/webauthn.js';
import { conditionalRenewDelayMs, passkeyBrowserErrorKey, passkeyErrorKey } from '../lib/passkeys.js';
import { passkeyLoginOptions, passkeyLoginVerify, passkeySignInAvailable } from '../api/passkeys.js';

// Reasons passed by the API client when it sends the admin back to the login page
const REASON_KEY: Record<string, TranslationKey> = {
  revoked: 'auth_reason_revoked',
  mfa:     'auth_reason_mfa',
};

export function LoginPage() {
  const navigate = useNavigate();
  const t = useT();
  const [searchParams] = useSearchParams();

  // Step 1: Credentials
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');

  // Step 2: MFA
  const [step, setStep]                     = useState<'credentials' | 'mfa'>('credentials');
  const [challengeToken, setChallengeToken] = useState('');
  const [mfaMethod, setMfaMethod]           = useState('totp');
  const [mfaMethods, setMfaMethods]         = useState<MfaMethod[] | undefined>(undefined);

  const [error, setError]     = useState(() => {
    const key = REASON_KEY[searchParams.get('reason') ?? ''];
    return key ? t(key) : '';
  });
  const [loading, setLoading] = useState(false);

  // 10.6: passkeys — conditional mediation (autofill) + explicit button
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [conditionalRound, setConditionalRound] = useState(0);
  const conditionalRef = useRef<AbortController | null>(null);
  const stopConditional = () => { conditionalRef.current?.abort(); conditionalRef.current = null; };
  useEffect(() => {
    if (!webauthnSupported()) return;
    void passkeySignInAvailable().then(setPasskeyAvailable);
  }, []);

  const finishPasskey = useCallback(async (flowId: string, rpId: string, assertion: Record<string, unknown>) => {
    try {
      setToken(await passkeyLoginVerify(flowId, assertion));
      navigate('/dashboard');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === 'PASSKEY_UNKNOWN') signalUnknownCredential(rpId, String(assertion['id'] ?? ''));
      setError(t(passkeyErrorKey(code) as TranslationKey));
    }
  }, [navigate, t]);

  // Passkeys in the e-mail autofill; renewed before the 300 s challenge expires,
  // aborted by the password submit and the button. No modal prompt on page load.
  useEffect(() => {
    if (!passkeyAvailable || step !== 'credentials') return;
    const ctrl = new AbortController();
    conditionalRef.current = ctrl;
    let renew: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      if (!(await conditionalMediationAvailable()) || ctrl.signal.aborted) return;
      try {
        const opts = await passkeyLoginOptions(ctrl.signal);
        renew = setTimeout(() => { ctrl.abort(); setConditionalRound((r) => r + 1); }, conditionalRenewDelayMs());
        const assertion = await webauthnAuthenticate(opts.publicKey, { mediation: 'conditional', signal: ctrl.signal });
        clearTimeout(renew);
        setPasskeyBusy(true);
        await finishPasskey(opts.flowId, String(opts.publicKey['rpId'] ?? ''), assertion);
      } catch (err) {
        if (ctrl.signal.aborted || webauthnFailure(err) === 'aborted') return;
        if (webauthnFailure(err) !== 'cancelled') setError(t(passkeyBrowserErrorKey(webauthnFailure(err)) as TranslationKey));
      } finally {
        setPasskeyBusy(false);
      }
    })();
    return () => { clearTimeout(renew); ctrl.abort(); };
  }, [passkeyAvailable, step, conditionalRound, finishPasskey, t]);

  const handlePasskeyButton = async () => {
    stopConditional();
    setError('');
    setPasskeyBusy(true);
    try {
      const opts = await passkeyLoginOptions();
      let assertion: Record<string, unknown>;
      try {
        assertion = await webauthnAuthenticate(opts.publicKey);
      } catch (err) {
        setError(t(passkeyBrowserErrorKey(webauthnFailure(err)) as TranslationKey));
        return;
      }
      await finishPasskey(opts.flowId, String(opts.publicKey['rpId'] ?? ''), assertion);
    } catch (err) {
      setError(t(passkeyErrorKey(err instanceof ApiError ? err.code : undefined) as TranslationKey));
    } finally {
      setPasskeyBusy(false);
      setConditionalRound((r) => r + 1);
    }
  };

  // ── Step 1: Email + password ─────────────────────────────────────────────────
  const handleSubmitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    stopConditional();
    setError('');
    setLoading(true);
    try {
      const result = await loginAdmin(email, password);
      if ('mfaRequired' in result) {
        setChallengeToken(result.challengeToken);
        setMfaMethod(result.method);
        setMfaMethods(result.methods);
        setStep('mfa');
      } else {
        setToken(result.accessToken);
        navigate('/dashboard');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('auth_login_failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <div className="bg-surface rounded-lg shadow-2xl p-8 w-full max-w-sm">
        {/* Logo, product name, login text (branding) */}
        <AuthBrandHeader
          nameSuffix=" BCP"
          withLoginText={step === 'credentials'}
          subtitle={step === 'mfa' ? t('auth_two_factor') : 'Backend Control Panel'}
          icon={
            <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
              {step === 'mfa'
                ? <ShieldCheck size={22} className="text-white" aria-hidden="true" />
                : <Shield size={22} className="text-white" aria-hidden="true" />
              }
            </div>
          }
        />

        {/* ── STEP 1: Credentials ── */}
        {step === 'credentials' && (
          <form onSubmit={handleSubmitCredentials} className="space-y-4">
            <div>
              <label htmlFor="bcp-email" className="block text-sm font-medium text-fg-muted mb-1">{t('auth_admin_email')}</label>
              <div className="relative">
                <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
                <input id="bcp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  className="input pl-9" placeholder="admin@domain.com" required autoComplete={passkeyAvailable ? 'username webauthn' : 'email'} />
              </div>
            </div>
            <div>
              <label htmlFor="bcp-password" className="block text-sm font-medium text-fg-muted mb-1">{t('auth_password')}</label>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
                <input id="bcp-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  className="input pl-9" placeholder="••••••••" required autoComplete="current-password" />
              </div>
            </div>
            {error && (
              <div role="alert" className="bg-danger-bg border border-danger-line rounded px-3 py-2 text-sm text-danger-fg">{error}</div>
            )}
            <button type="submit" disabled={loading || passkeyBusy}
              className="btn-primary w-full justify-center py-2 disabled:opacity-60">
              {loading ? t('auth_signing_in') : t('auth_sign_in')}
            </button>
            {/* 10.6: explicit passkey sign-in (this device, a security key or another device via QR code) */}
            {passkeyAvailable && (
              <>
                <div className="flex items-center gap-2 text-xs text-fg-subtle" aria-hidden="true">
                  <span className="flex-1 border-t border-line" />{t('pk_or')}<span className="flex-1 border-t border-line" />
                </div>
                <button type="button" onClick={() => { void handlePasskeyButton(); }} disabled={loading || passkeyBusy}
                  aria-describedby="bcp-passkey-hint"
                  className="btn-secondary w-full justify-center py-2 inline-flex items-center gap-2 disabled:opacity-60">
                  {passkeyBusy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <KeyRound size={15} aria-hidden="true" />}
                  {t('pk_sign_in')}
                </button>
                <p id="bcp-passkey-hint" className="text-[11px] text-fg-subtle text-center">{t('pk_sign_in_hint')}</p>
                {passkeyBusy && <p role="status" className="sr-only">{t('pk_signing_in')}</p>}
              </>
            )}
          </form>
        )}

        {/* ── SSO (OIDC) providers — v6.1 ── */}
        {step === 'credentials' && <SsoButtons target="bcp" />}

        {/* ── STEP 2: MFA (TOTP, backup code or security key) ── */}
        {step === 'mfa' && (
          <MfaChallengeForm
            challengeToken={challengeToken}
            method={mfaMethod}
            methods={mfaMethods}
            email={email}
            onSuccess={(accessToken) => { setToken(accessToken); navigate('/dashboard'); }}
            onBack={(reason) => { setStep('credentials'); setError(reason ?? ''); }}
          />
        )}
      </div>
    </AuthShell>
  );
}
