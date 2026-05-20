import { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, ShieldCheck, ArrowLeft, AlertTriangle } from 'lucide-react';
import { login, verifyMfa } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import { api } from '../api/client.js';
import type { UserProfile } from '../api/types.js';

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
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
  const digitRefs = useRef<(HTMLInputElement | null)[]>([]);

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Wartungsmodus
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');

  const [selfServicePasswordReset, setSelfServicePasswordReset] = useState(true);

  // Wartungsstatus + öffentliche Einstellungen beim Laden abrufen (kein Auth nötig)
  useEffect(() => {
    fetch('/api/v1/maintenance')
      .then((r) => r.json())
      .then((d: { maintenanceMode: boolean; maintenanceMessage: string }) => {
        setMaintenanceMode(d.maintenanceMode ?? false);
        setMaintenanceMessage(d.maintenanceMessage ?? '');
      })
      .catch(() => { /* ignorieren — kein Banner bei Netzwerkfehler */ });

    fetch('/api/v1/admin/settings/public')
      .then((r) => r.json())
      .then((d: { selfServicePasswordReset?: boolean }) => {
        setSelfServicePasswordReset(d.selfServicePasswordReset !== false);
      })
      .catch(() => undefined);
  }, []);

  // Auto-focus first digit when entering MFA step
  useEffect(() => {
    if (step === 'mfa') {
      setTimeout(() => digitRefs.current[0]?.focus(), 50);
    }
  }, [step]);

  // ── Step 1: E-Mail + Passwort ────────────────────────────────────────────────
  const handleSubmitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(email, password);
      if ('mfaRequired' in result) {
        setChallengeToken(result.challengeToken);
        setMfaMethod(result.method);
        setStep('mfa');
      } else {
        const { accessToken, refreshToken } = result as { accessToken: string; refreshToken: string };
        await finalizeLogin(accessToken, refreshToken);
      }
    } catch (err: unknown) {
      // Wartungsmodus-Fehler explizit behandeln
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

  // ── Step 2: MFA-Code ─────────────────────────────────────────────────────────
  const handleSubmitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = otpDigits.join('');
    if (code.length < 6) { setError('Bitte alle 6 Ziffern eingeben'); return; }
    setError('');
    setLoading(true);
    try {
      const tokens = await verifyMfa(challengeToken, code);
      await finalizeLogin(tokens.accessToken, tokens.refreshToken);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ungültiger Code');
      setOtpDigits(['', '', '', '', '', '']);
      setTimeout(() => digitRefs.current[0]?.focus(), 50);
    } finally {
      setLoading(false);
    }
  };

  const finalizeLogin = async (accessToken: string, refreshToken: string) => {
    setTokens(accessToken, refreshToken);
    const profile = await api.get<UserProfile>('/user/profile');
    setProfile(profile.id, profile.email, profile.displayName, profile.role);
    navigate('/mail');
  };

  // ── OTP digit input helpers ──────────────────────────────────────────────────
  const handleDigitChange = (i: number, val: string) => {
    const digit = val.replace(/\D/g, '').slice(-1);
    const next = [...otpDigits];
    next[i] = digit;
    setOtpDigits(next);
    if (digit && i < 5) digitRefs.current[i + 1]?.focus();
  };

  const handleDigitKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[i] && i > 0) {
      digitRefs.current[i - 1]?.focus();
    }
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-accent to-blue-800">

      {/* ── Wartungsmodus-Banner (über der Login-Card) ── */}
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

      <div className={`bg-white rounded-lg shadow-2xl p-8 w-full max-w-sm${maintenanceMode ? ' mt-14' : ''}`}>
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
            {step === 'mfa'
              ? <ShieldCheck size={22} className="text-white" />
              : <Mail size={22} className="text-white" />
            }
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">CoreMail</h1>
            <p className="text-xs text-gray-500">
              {step === 'mfa' ? 'Zwei-Faktor-Authentifizierung' : 'Mail Web Access'}
            </p>
          </div>
        </div>

        {/* ── SCHRITT 1: Anmeldedaten ── */}
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

            {/* 6-Digit OTP input */}
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

            <button
              type="submit"
              disabled={loading || otpDigits.join('').length < 6}
              className="btn-primary w-full justify-center py-2 disabled:opacity-60"
            >
              {loading ? 'Prüfen...' : 'Bestätigen'}
            </button>

            <button
              type="button"
              onClick={() => { setStep('credentials'); setError(''); setOtpDigits(['', '', '', '', '', '']); }}
              className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 py-1"
            >
              <ArrowLeft size={13} /> Zurück zur Anmeldung
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
