import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, ShieldCheck, AlertTriangle, KeyRound, Loader2 } from 'lucide-react';
import { login, type MfaMethod } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import { api } from '../api/client.js';
import type { UserProfile } from '../api/types.js';
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
import { passkeyLoginOptions, passkeyLoginVerify, passkeySignInAvailable, signalPasskeyState } from '../api/passkeys.js';

export function LoginPage() {
  const navigate = useNavigate();
  const t = useT();
  const { setTokens, setProfile } = useAuthStore();

  // Step 1: Credentials
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Step 2: MFA
  const [step, setStep] = useState<'credentials' | 'mfa'>('credentials');
  const [challengeToken, setChallengeToken] = useState('');
  const [mfaMethod, setMfaMethod] = useState('totp');
  const [mfaMethods, setMfaMethods] = useState<MfaMethod[] | undefined>(undefined);

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Maintenance mode
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');

  const [selfServicePasswordReset, setSelfServicePasswordReset] = useState(true);

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

  // Fetch maintenance status + public settings on load (no auth required)
  useEffect(() => {
    fetch('/api/v1/maintenance')
      .then((r) => r.json())
      .then((d: { maintenanceMode: boolean; maintenanceMessage: string }) => {
        setMaintenanceMode(d.maintenanceMode ?? false);
        setMaintenanceMessage(d.maintenanceMessage ?? '');
      })
      .catch(() => { /* ignore — no banner on network error */ });

    fetch('/api/v1/admin/settings/public')
      .then((r) => r.json())
      .then((d: { selfServicePasswordReset?: boolean }) => {
        setSelfServicePasswordReset(d.selfServicePasswordReset !== false);
      })
      .catch(() => undefined);
  }, []);

  // ── Passkey sign-in (10.6) ───────────────────────────────────────────────────
  const finishPasskey = useCallback(async (flowId: string, rpId: string, assertion: Record<string, unknown>) => {
    try {
      const tokens = await passkeyLoginVerify(flowId, assertion);
      await finalizeLogin(tokens.accessToken, tokens.refreshToken);
      signalPasskeyState();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      // the browser may offer this passkey again — tell it the server does not know it (§5.1.10)
      if (code === 'PASSKEY_UNKNOWN') signalUnknownCredential(rpId, String(assertion['id'] ?? ''));
      setError(t(passkeyErrorKey(code) as TranslationKey));
    }
    // finalizeLogin is stable for the page's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  // Conditional mediation: the passkeys appear in the e-mail field's autofill.
  // Renewed before the 300 s challenge expires; aborted by the password submit
  // and the explicit button. Never a modal prompt on page load (WCAG 3.3.8).
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
        // conditional requests end silently when the user picks nothing
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
      setConditionalRound((r) => r + 1); // offer the autofill again
    }
  };

  // ── Step 1: Email + password ─────────────────────────────────────────────────
  const handleSubmitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    stopConditional();
    setError('');
    setLoading(true);
    try {
      const result = await login(email, password);
      if ('mfaRequired' in result) {
        setChallengeToken(result.challengeToken);
        setMfaMethod(result.method);
        setMfaMethods(result.methods);
        setStep('mfa');
      } else {
        const { accessToken, refreshToken } = result as { accessToken: string; refreshToken: string };
        await finalizeLogin(accessToken, refreshToken);
      }
    } catch (err: unknown) {
      // Handle maintenance mode error explicitly
      const msg = err instanceof Error ? err.message : '';
      if (msg.startsWith('maintenance:')) {
        setError(msg.replace('maintenance:', '').trim());
      } else {
        setError(msg || t('auth_login_failed'));
      }
    } finally {
      setLoading(false);
    }
  };


  const finalizeLogin = async (accessToken: string, refreshToken: string) => {
    setTokens(accessToken, refreshToken);
    const profile = await api.get<UserProfile>('/user/profile');
    setProfile(profile.id, profile.email, profile.displayName, profile.role);

    // v5.6.0: OAuth2 consent flow completely removed — login goes directly to /mail.
    navigate('/mail');
  };


  return (
    <AuthShell>

      {/* ── Maintenance mode banner (above the login card) ── */}
      {maintenanceMode && (
        <div className="fixed top-0 inset-x-0 z-50 bg-warning text-white px-4 py-3 flex items-start gap-3 shadow-lg">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">{t('auth_maintenance_title')}</span>
            <span className="text-sm">
              {maintenanceMessage || t('auth_maintenance_default')}
            </span>
            <span className="ml-2 text-xs opacity-80">{t('auth_maintenance_admins_only')}</span>
          </div>
        </div>
      )}

      <div className={`bg-surface rounded-lg shadow-2xl p-8 w-full max-w-sm border border-transparent${maintenanceMode ? ' mt-14' : ''}`}>
        {/* Logo, product name, login text (branding) */}
        <AuthBrandHeader
          withLoginText={step === 'credentials'}
          subtitle={step === 'mfa' ? t('auth_two_factor') : 'Mail Web Access'}
          icon={
            <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
              {step === 'mfa'
                ? <ShieldCheck size={22} className="text-white" aria-hidden="true" />
                : <Mail size={22} className="text-white" aria-hidden="true" />
              }
            </div>
          }
        />

        {/* ── STEP 1: Credentials ── */}
        {step === 'credentials' && (
          <form onSubmit={handleSubmitCredentials} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-fg-muted mb-1">{t('auth_email')}</label>
              <div className="relative">
                <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input pl-9"
                  placeholder={t('auth_email_placeholder')}
                  required
                  // 10.6: "webauthn" lets the browser offer passkeys in the autofill (conditional mediation)
                  autoComplete={passkeyAvailable ? 'username webauthn' : 'email'}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-fg-muted mb-1">{t('auth_password')}</label>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pl-9"
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                />
              </div>
            </div>

            {error && (
              <div role="alert" className="bg-danger-bg border border-danger-line rounded px-3 py-2 text-sm text-danger-fg">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading || passkeyBusy} className="btn-primary w-full justify-center py-2 disabled:opacity-60">
              {loading ? t('auth_signing_in') : t('auth_sign_in')}
            </button>

            {/* 10.6: explicit passkey sign-in (this device, a security key or another device via QR code) */}
            {passkeyAvailable && (
              <>
                <div className="flex items-center gap-2 text-xs text-fg-subtle" aria-hidden="true">
                  <span className="flex-1 border-t border-line" />{t('pk_or')}<span className="flex-1 border-t border-line" />
                </div>
                <button
                  type="button"
                  onClick={() => { void handlePasskeyButton(); }}
                  disabled={loading || passkeyBusy}
                  aria-describedby="passkey-signin-hint"
                  className="btn-secondary w-full justify-center py-2 inline-flex items-center gap-2 disabled:opacity-60"
                >
                  {passkeyBusy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <KeyRound size={15} aria-hidden="true" />}
                  {t('pk_sign_in')}
                </button>
                <p id="passkey-signin-hint" className="text-[11px] text-fg-subtle text-center">{t('pk_sign_in_hint')}</p>
                {passkeyBusy && <p role="status" className="sr-only">{t('pk_signing_in')}</p>}
              </>
            )}

            {selfServicePasswordReset && (
              <div className="text-center pt-1">
                <Link to="/forgot-password" className="text-xs text-accent-fg hover:underline">
                  {t('auth_forgot_password')}
                </Link>
              </div>
            )}
          </form>
        )}

        {/* ── SSO (OIDC) providers — v6.1 ── */}
        {step === 'credentials' && <SsoButtons target="mwa" />}

        {/* ── STEP 2: MFA (TOTP, backup code or security key) ── */}
        {step === 'mfa' && (
          <MfaChallengeForm
            challengeToken={challengeToken}
            method={mfaMethod}
            methods={mfaMethods}
            email={email}
            onSuccess={(tokens) => finalizeLogin(tokens.accessToken, tokens.refreshToken)}
            onBack={(reason) => { setStep('credentials'); setError(reason ?? ''); }}
          />
        )}
      </div>
    </AuthShell>
  );
}
