import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Mail, ArrowLeft, CheckCircle, KeyRound } from 'lucide-react';
import { api } from '../api/client.js';

export function ForgotPasswordPage() {
  const [email, setEmail]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [sent, setSent]         = useState(false);
  const [error, setError]       = useState('');
  const [orgName, setOrgName]   = useState('CoreMail');
  const [allowed, setAllowed]   = useState(true);

  // Öffentliche Einstellungen laden (Feature-Flag + Org-Name)
  useEffect(() => {
    fetch('/api/v1/admin/settings/public')
      .then((r) => r.json())
      .then((d: { orgName?: string; selfServicePasswordReset?: boolean }) => {
        if (d.orgName) setOrgName(d.orgName);
        if (d.selfServicePasswordReset === false) setAllowed(false);
      })
      .catch(() => { /* Fallback-Werte bleiben */ });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err: unknown) {
      // Auch bei Fehler: generische Meldung (kein User-Enumeration)
      setError(err instanceof Error ? err.message : 'Fehler. Bitte versuchen Sie es erneut.');
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
            <p className="text-xs text-gray-500">Passwort zurücksetzen</p>
          </div>
        </div>

        {!allowed ? (
          <div className="text-center space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
              Die selbstständige Passwort-Zurücksetzung ist deaktiviert.<br />
              Bitte wenden Sie sich an Ihren Administrator.
            </div>
            <Link to="/login" className="flex items-center justify-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 py-1">
              <ArrowLeft size={13} /> Zurück zur Anmeldung
            </Link>
          </div>
        ) : sent ? (
          /* Erfolgs-Ansicht */
          <div className="text-center space-y-4">
            <CheckCircle size={48} className="mx-auto text-green-500" />
            <h2 className="font-semibold text-gray-900">E-Mail gesendet</h2>
            <p className="text-sm text-gray-600">
              Falls <strong>{email}</strong> einem aktiven Konto entspricht, haben Sie in Kürze eine E-Mail mit einem Reset-Link erhalten.
              Der Link ist <strong>15 Minuten</strong> gültig.
            </p>
            <p className="text-xs text-gray-400">
              Keine E-Mail erhalten? Prüfen Sie Ihren Spam-Ordner oder wenden Sie sich an Ihren Administrator.
            </p>
            <Link to="/login" className="flex items-center justify-center gap-1.5 text-sm text-accent hover:underline py-1">
              <ArrowLeft size={13} /> Zurück zur Anmeldung
            </Link>
          </div>
        ) : (
          /* Formular */
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-gray-600">
              Geben Sie Ihre E-Mail-Adresse ein. Falls ein Konto existiert, erhalten Sie einen Link zum Zurücksetzen Ihres Passworts.
            </p>
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
                  autoFocus
                />
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email}
              className="btn-primary w-full justify-center py-2 disabled:opacity-60"
            >
              {loading ? 'Wird gesendet...' : 'Reset-Link anfordern'}
            </button>

            <Link
              to="/login"
              className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 py-1"
            >
              <ArrowLeft size={13} /> Zurück zur Anmeldung
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
