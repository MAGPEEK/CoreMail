import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock, Shield, ShieldCheck, ArrowLeft } from 'lucide-react';
import { loginAdmin, verifyMfaAdmin, setToken } from '../api/client.js';

export function LoginPage() {
  const navigate = useNavigate();

  // Step 1: Credentials
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');

  // Step 2: MFA
  const [step, setStep]                 = useState<'credentials' | 'mfa'>('credentials');
  const [challengeToken, setChallengeToken] = useState('');
  const [mfaMethod, setMfaMethod]       = useState('totp');
  const [otpDigits, setOtpDigits]       = useState(['', '', '', '', '', '']);
  const digitRefs = useRef<(HTMLInputElement | null)[]>([]);

  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (step === 'mfa') setTimeout(() => digitRefs.current[0]?.focus(), 50);
  }, [step]);

  // ── Step 1: E-Mail + Passwort ────────────────────────────────────────────────
  const handleSubmitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await loginAdmin(email, password);
      if ('mfaRequired' in result) {
        setChallengeToken(result.challengeToken);
        setMfaMethod(result.method);
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

  // ── Step 2: MFA-Code ─────────────────────────────────────────────────────────
  const handleSubmitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = otpDigits.join('');
    if (code.length < 6) { setError('Bitte alle 6 Ziffern eingeben'); return; }
    setError('');
    setLoading(true);
    try {
      const accessToken = await verifyMfaAdmin(challengeToken, code);
      setToken(accessToken);
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ungültiger Code');
      setOtpDigits(['', '', '', '', '', '']);
      setTimeout(() => digitRefs.current[0]?.focus(), 50);
    } finally {
      setLoading(false);
    }
  };

  // ── OTP-Digit-Helpers ────────────────────────────────────────────────────────
  const handleDigitChange = (i: number, val: string) => {
    const digit = val.replace(/\D/g, '').slice(-1);
    const next = [...otpDigits];
    next[i] = digit;
    setOtpDigits(next);
    if (digit && i < 5) digitRefs.current[i + 1]?.focus();
  };
  const handleDigitKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[i] && i > 0) digitRefs.current[i - 1]?.focus();
  };
  const handleDigitPaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) {
      e.preventDefault();
      setOtpDigits(pasted.split(''));
      digitRefs.current[5]?.focus();
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

        {/* ── SCHRITT 1: Anmeldedaten ── */}
        {step === 'credentials' && (
          <form onSubmit={handleSubmitCredentials} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Administrator-E-Mail</label>
              <div className="relative">
                <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  className="input pl-9" placeholder="admin@domain.com" required autoComplete="email" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Passwort</label>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  className="input pl-9" placeholder="••••••••" required autoComplete="current-password" />
              </div>
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">{error}</div>
            )}
            <button type="submit" disabled={loading}
              className="btn-primary w-full justify-center py-2 disabled:opacity-60">
              {loading ? 'Anmelden...' : 'Anmelden'}
            </button>
          </form>
        )}

        {/* ── SCHRITT 2: MFA-Code ── */}
        {step === 'mfa' && (
          <form onSubmit={handleSubmitMfa} className="space-y-5">
            <div className="text-center">
              <p className="text-sm text-gray-600">
                {mfaMethod === 'totp'
                  ? 'Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein.'
                  : 'Verwenden Sie Ihren Hardware-Key oder Backup-Code.'}
              </p>
              <p className="text-xs text-gray-400 mt-1">{email}</p>
            </div>

            {/* 6-Digit OTP */}
            <div className="flex justify-center gap-2" onPaste={handleDigitPaste}>
              {otpDigits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => { digitRefs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={(e) => handleDigitChange(i, e.target.value)}
                  onKeyDown={(e) => handleDigitKeyDown(i, e)}
                  className="w-10 h-12 text-center text-xl font-bold border-2 rounded-lg focus:outline-none focus:border-accent transition-colors"
                  style={{ borderColor: d ? 'var(--color-accent)' : undefined }}
                />
              ))}
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700 text-center">
                {error}
              </div>
            )}

            <button type="submit"
              disabled={loading || otpDigits.join('').length < 6}
              className="btn-primary w-full justify-center py-2 disabled:opacity-60">
              {loading ? 'Prüfen...' : 'Bestätigen'}
            </button>

            <button type="button"
              onClick={() => { setStep('credentials'); setError(''); setOtpDigits(['', '', '', '', '', '']); }}
              className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 py-1">
              <ArrowLeft size={13} /> Zurück zur Anmeldung
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
