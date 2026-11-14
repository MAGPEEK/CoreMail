import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, Shield, ShieldCheck } from 'lucide-react';
import { loginAdmin, setToken, type MfaMethod } from '../api/client.js';
import { MfaChallengeForm } from '../components/MfaChallengeForm.js';

// Reasons passed by the API client when it sends the admin back to the login page
const REASON_TEXT: Record<string, string> = {
  revoked: 'Ihre Sitzung wurde beendet. Bitte melden Sie sich erneut an.',
  mfa:     'Für diesen Bereich ist eine Anmeldung mit zweitem Faktor erforderlich.',
};
import { SsoButtons } from '../components/SsoButtons.js';

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Step 1: Credentials
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');

  // Step 2: MFA
  const [step, setStep]                     = useState<'credentials' | 'mfa'>('credentials');
  const [challengeToken, setChallengeToken] = useState('');
  const [mfaMethod, setMfaMethod]           = useState('totp');
  const [mfaMethods, setMfaMethods]         = useState<MfaMethod[] | undefined>(undefined);

  const [error, setError]     = useState(() => REASON_TEXT[searchParams.get('reason') ?? ''] ?? '');
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
        setStep('mfa');
      } else {
        setToken(result.accessToken);
        navigate('/dashboard');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="bg-white rounded-lg shadow-2xl p-8 w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
            {step === 'mfa'
              ? <ShieldCheck size={22} className="text-white" />
              : <Shield size={22} className="text-white" />
            }
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">CoreMail BCP</h1>
            <p className="text-xs text-gray-500">
              {step === 'mfa' ? 'Zwei-Faktor-Authentifizierung' : 'Backend Control Panel'}
            </p>
          </div>
        </div>

        {/* ── STEP 1: Credentials ── */}
        {step === 'credentials' && (
          <form onSubmit={handleSubmitCredentials} className="space-y-4">
            <div>
              <label htmlFor="bcp-email" className="block text-sm font-medium text-gray-700 mb-1">Administrator-E-Mail</label>
              <div className="relative">
                <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input id="bcp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  className="input pl-9" placeholder="admin@domain.com" required autoComplete="email" />
              </div>
            </div>
            <div>
              <label htmlFor="bcp-password" className="block text-sm font-medium text-gray-700 mb-1">Passwort</label>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input id="bcp-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  className="input pl-9" placeholder="••••••••" required autoComplete="current-password" />
              </div>
            </div>
            {error && (
              <div role="alert" className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">{error}</div>
            )}
            <button type="submit" disabled={loading}
              className="btn-primary w-full justify-center py-2 disabled:opacity-60">
              {loading ? 'Anmelden...' : 'Anmelden'}
            </button>
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
    </div>
  );
}
