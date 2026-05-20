import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { Lock, CheckCircle, XCircle, Eye, EyeOff, KeyRound, ArrowLeft } from 'lucide-react';
import { api } from '../api/client.js';

function PasswordStrengthBar({ password, minLen }: { password: string; minLen: number }) {
  const len = password.length;
  let score = 0;
  if (len >= minLen)  score++;
  if (len >= 12)      score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  const labels  = ['', 'Sehr schwach', 'Schwach', 'Mittel', 'Stark', 'Sehr stark'];
  const colors  = ['', 'bg-red-500', 'bg-orange-400', 'bg-yellow-400', 'bg-green-400', 'bg-green-600'];
  const widths  = ['', 'w-1/5', 'w-2/5', 'w-3/5', 'w-4/5', 'w-full'];

  if (!password) return null;
  return (
    <div className="mt-1 space-y-1">
      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${colors[score]} ${widths[score]}`} />
      </div>
      {score > 0 && <p className="text-xs text-gray-500">{labels[score]}</p>}
    </div>
  );
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';

  const [tokenValid, setTokenValid]   = useState<boolean | null>(null); // null = lädt
  const [password, setPassword]       = useState('');
  const [confirm, setConfirm]         = useState('');
  const [showPw, setShowPw]           = useState(false);
  const [loading, setLoading]         = useState(false);
  const [success, setSuccess]         = useState(false);
  const [error, setError]             = useState('');
  const [minLen, setMinLen]           = useState(8);
  const [orgName, setOrgName]         = useState('CoreMail');

  useEffect(() => {
    // Einstellungen laden
    fetch('/api/v1/admin/settings/public')
      .then((r) => r.json())
      .then((d: { orgName?: string }) => { if (d.orgName) setOrgName(d.orgName); })
      .catch(() => undefined);

    // Passwort-Mindestlänge aus Admin-Settings
    fetch('/api/v1/admin/settings')
      .then((r) => r.json())
      .then((d: { minPasswordLength?: number }) => { if (d.minPasswordLength) setMinLen(d.minPasswordLength); })
      .catch(() => undefined);

    // Token-Gültigkeit prüfen
    if (!token) { setTokenValid(false); return; }
    fetch(`/api/v1/auth/reset-password/verify?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d: { valid?: boolean }) => setTokenValid(d.valid ?? false))
      .catch(() => setTokenValid(false));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < minLen) {
      setError(`Das Passwort muss mindestens ${minLen} Zeichen lang sein.`);
      return;
    }
    if (password !== confirm) {
      setError('Die Passwörter stimmen nicht überein.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, newPassword: password });
      setSuccess(true);
      setTimeout(() => navigate('/login'), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Fehler beim Zurücksetzen. Bitte fordern Sie einen neuen Link an.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-accent to-blue-800">
      <div className="bg-white rounded-lg shadow-2xl p-8 w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
            <KeyRound size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">{orgName}</h1>
            <p className="text-xs text-gray-500">Neues Passwort setzen</p>
          </div>
        </div>

        {/* Lädt Token-Prüfung */}
        {tokenValid === null && (
          <div className="text-center py-8">
            <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-gray-500 mt-3">Link wird überprüft…</p>
          </div>
        )}

        {/* Token ungültig */}
        {tokenValid === false && (
          <div className="text-center space-y-4">
            <XCircle size={48} className="mx-auto text-red-500" />
            <h2 className="font-semibold text-gray-900">Link ungültig oder abgelaufen</h2>
            <p className="text-sm text-gray-600">
              Dieser Reset-Link ist nicht mehr gültig (Ablaufzeit: 15 Minuten) oder wurde bereits verwendet.
            </p>
            <Link to="/forgot-password" className="btn-primary w-full justify-center py-2 text-sm">
              Neuen Link anfordern
            </Link>
            <Link to="/login" className="flex items-center justify-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 py-1">
              <ArrowLeft size={13} /> Zurück zur Anmeldung
            </Link>
          </div>
        )}

        {/* Erfolg */}
        {success && (
          <div className="text-center space-y-4">
            <CheckCircle size={48} className="mx-auto text-green-500" />
            <h2 className="font-semibold text-gray-900">Passwort geändert</h2>
            <p className="text-sm text-gray-600">
              Ihr Passwort wurde erfolgreich zurückgesetzt. Sie werden zur Anmeldung weitergeleitet…
            </p>
          </div>
        )}

        {/* Formular */}
        {tokenValid === true && !success && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-gray-600">
              Geben Sie Ihr neues Passwort ein. Mindestlänge: <strong>{minLen} Zeichen</strong>.
            </p>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Neues Passwort</label>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pl-9 pr-9"
                  placeholder={`Mindestens ${minLen} Zeichen`}
                  required
                  autoFocus
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <PasswordStrengthBar password={password} minLen={minLen} />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Passwort bestätigen</label>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type={showPw ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="input pl-9"
                  placeholder="Passwort wiederholen"
                  required
                  autoComplete="new-password"
                />
              </div>
              {confirm && password !== confirm && (
                <p className="text-xs text-red-500 mt-1">Passwörter stimmen nicht überein</p>
              )}
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || password.length < minLen || password !== confirm}
              className="btn-primary w-full justify-center py-2 disabled:opacity-60"
            >
              {loading ? 'Wird gespeichert…' : 'Passwort setzen'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
