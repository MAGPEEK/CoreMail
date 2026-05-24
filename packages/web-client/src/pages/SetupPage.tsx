import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

export function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<'form' | 'done'>('form');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [domain, setDomain]           = useState('');
  const [email, setEmail]             = useState('');
  const [emailEdited, setEmailEdited] = useState(false);
  const [password, setPassword]       = useState('');
  const [confirm, setConfirm]         = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError('Passwörter stimmen nicht überein.');
      return;
    }
    if (password.length < 8) {
      setError('Passwort muss mindestens 8 Zeichen haben.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/v1/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, email, password }),
      });
      const data = await res.json() as { error?: string; success?: boolean };
      if (!res.ok) {
        setError(data.error ?? 'Setup fehlgeschlagen.');
        return;
      }
      setStep('done');
    } catch {
      setError('Netzwerkfehler. Bitte versuche es erneut.');
    } finally {
      setLoading(false);
    }
  };

  if (step === 'done') {
    return (
      <div className="min-h-screen bg-[#0078D4] flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md text-center">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-2xl font-semibold text-gray-800 mb-2">Setup abgeschlossen!</h2>
          <p className="text-gray-500 mb-6">
            Dein Administrator-Konto wurde erstellt. Du kannst dich jetzt anmelden.
          </p>
          <button
            onClick={() => navigate('/login')}
            className="w-full bg-[#0078D4] hover:bg-[#106EBE] text-white font-medium py-2 px-4 rounded transition-colors"
          >
            Zur Anmeldung
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0078D4] flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="bg-[#0078D4] px-8 py-6">
          <div className="flex items-center gap-3 mb-1">
            <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
            </svg>
            <span className="text-white text-xl font-semibold">CoreMail</span>
          </div>
          <p className="text-blue-100 text-sm">Erstkonfiguration</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-8 py-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">Willkommen bei CoreMail</h2>
            <p className="text-sm text-gray-500 mt-1">
              Richte deinen Administrator-Account ein, um loszulegen.
            </p>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded">
              {error}
            </div>
          )}

          {/* Domain */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Mail-Domain
            </label>
            <input
              type="text"
              required
              placeholder="z.B. firma.de"
              value={domain}
              onChange={(e) => {
                const val = e.target.value.toLowerCase();
                setDomain(val);
                if (!emailEdited) {
                  setEmail(val ? `admin@${val}` : '');
                }
              }}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0078D4] focus:border-transparent"
            />
            <p className="text-xs text-gray-400 mt-1">
              Die Haupt-Domain deines Mailservers (ohne https://)
            </p>
          </div>

          {/* E-Mail */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Administrator-E-Mail
            </label>
            <input
              type="email"
              required
              placeholder="admin@firma.de"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setEmailEdited(true); }}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0078D4] focus:border-transparent"
            />
          </div>

          {/* Passwort */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Passwort
            </label>
            <input
              type="password"
              required
              placeholder="Mindestens 8 Zeichen"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0078D4] focus:border-transparent"
            />
          </div>

          {/* Passwort bestätigen */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Passwort bestätigen
            </label>
            <input
              type="password"
              required
              placeholder="Passwort wiederholen"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0078D4] focus:border-transparent"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#0078D4] hover:bg-[#106EBE] disabled:bg-blue-300 text-white font-medium py-2 px-4 rounded transition-colors mt-2"
          >
            {loading ? 'Wird eingerichtet…' : 'Setup abschließen'}
          </button>
        </form>
      </div>
    </div>
  );
}
