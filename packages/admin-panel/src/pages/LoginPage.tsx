import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, Shield, ShieldCheck } from 'lucide-react';
import { loginAdmin, setToken, type MfaMethod } from '../api/client.js';
import { MfaChallengeForm } from '../components/MfaChallengeForm.js';
import { SsoButtons } from '../components/SsoButtons.js';
import { AuthShell, AuthBrandHeader } from '../components/AuthShell.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';

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
  const [rememberDays, setRememberDays]     = useState(0); // 10.6: "Gerät merken" offered by the server

  const [error, setError]     = useState(() => {
    const key = REASON_KEY[searchParams.get('reason') ?? ''];
    return key ? t(key) : '';
  });
  const [loading, setLoading] = useState(false);

  // ── Step 1: Email + password ─────────────────────────────────────────────────
  const handleSubmitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await loginAdmin(email, password);
      if ('mfaRequired' in result) {
        setChallengeToken(result.challengeToken);
        setMfaMethod(result.method);
        setMfaMethods(result.methods);
        setRememberDays(result.rememberDevice?.days ?? 0);
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
                  className="input pl-9" placeholder="admin@domain.com" required autoComplete="email" />
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
            <button type="submit" disabled={loading}
              className="btn-primary w-full justify-center py-2 disabled:opacity-60">
              {loading ? t('auth_signing_in') : t('auth_sign_in')}
            </button>
          </form>
        )}

        {/* ── SSO (OIDC) providers — v6.1 ── */}
        {step === 'credentials' && <SsoButtons target="bcp" />}

        {/* ── STEP 2: MFA (TOTP, backup code or security key) ── */}
        {step === 'mfa' && (
          <MfaChallengeForm
            challengeToken={challengeToken}
            rememberDays={rememberDays}
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
