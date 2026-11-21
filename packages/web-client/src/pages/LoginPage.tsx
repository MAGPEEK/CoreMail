import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, ShieldCheck, AlertTriangle } from 'lucide-react';
import { login, type MfaMethod } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import { api } from '../api/client.js';
import type { UserProfile } from '../api/types.js';
import { MfaChallengeForm } from '../components/MfaChallengeForm.js';
import { SsoButtons } from '../components/SsoButtons.js';
import { AuthShell, AuthBrandHeader } from '../components/AuthShell.js';
import { useT } from '../i18n/useT.js';

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
  const [rememberDays, setRememberDays] = useState(0); // 10.6: "Gerät merken" offered by the server

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Maintenance mode
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');

  const [selfServicePasswordReset, setSelfServicePasswordReset] = useState(true);

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

  // ── Step 1: Email + password ─────────────────────────────────────────────────
  const handleSubmitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(email, password);
      if ('mfaRequired' in result) {
        setChallengeToken(result.challengeToken);
        setMfaMethod(result.method);
        setMfaMethods(result.methods);
        setRememberDays(result.rememberDevice?.days ?? 0);
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
                  autoComplete="email"
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
              <div className="bg-danger-bg border border-danger-line rounded px-3 py-2 text-sm text-danger-fg">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-2 disabled:opacity-60">
              {loading ? t('auth_signing_in') : t('auth_sign_in')}
            </button>

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
            rememberDays={rememberDays}
            email={email}
            onSuccess={(tokens) => finalizeLogin(tokens.accessToken, tokens.refreshToken)}
            onBack={(reason) => { setStep('credentials'); setError(reason ?? ''); }}
          />
        )}
      </div>
    </AuthShell>
  );
}
