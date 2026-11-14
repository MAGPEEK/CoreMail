import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, ShieldCheck, AlertTriangle } from 'lucide-react';
import { login, type MfaMethod } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import { api } from '../api/client.js';
import type { UserProfile } from '../api/types.js';
import { MfaChallengeForm } from '../components/MfaChallengeForm.js';

export function LoginPage() {
  const navigate = useNavigate();
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
        setError(msg || 'Anmeldung fehlgeschlagen');
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-accent to-blue-800">

      {/* ── Maintenance mode banner (above the login card) ── */}
      {maintenanceMode && (
        <div className="fixed top-0 inset-x-0 z-50 bg-amber-500 text-white px-4 py-3 flex items-start gap-3 shadow-lg">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">Wartungsmodus aktiv — </span>
            <span className="text-sm">
              {maintenanceMessage || 'Der Server befindet sich derzeit in Wartung. Bitte versuchen Sie es später erneut.'}
            </span>
            <span className="ml-2 text-xs opacity-80">(Nur Administratoren können sich anmelden.)</span>
          </div>
        </div>
      )}

      <div className={`bg-white dark:bg-gray-900 rounded-lg shadow-2xl p-8 w-full max-w-sm border border-transparent dark:border-gray-700${maintenanceMode ? ' mt-14' : ''}`}>
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
            {step === 'mfa'
              ? <ShieldCheck size={22} className="text-white" />
              : <Mail size={22} className="text-white" />
            }
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">CoreMail</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {step === 'mfa' ? 'Zwei-Faktor-Authentifizierung' : 'Mail Web Access'}
            </p>
          </div>
        </div>

        {/* ── STEP 1: Credentials ── */}
        {step === 'credentials' && (
          <form onSubmit={handleSubmitCredentials} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">E-Mail-Adresse</label>
              <div className="relative">
                <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input pl-9"
                  placeholder="benutzer@domain.com"
                  required
                  autoComplete="email"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Passwort</label>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
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
              <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-2 disabled:opacity-60">
              {loading ? 'Anmelden...' : 'Anmelden'}
            </button>

            {selfServicePasswordReset && (
              <div className="text-center pt-1">
                <Link to="/forgot-password" className="text-xs text-accent hover:underline">
                  Passwort vergessen?
                </Link>
              </div>
            )}
          </form>
        )}

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
    </div>
  );
}
