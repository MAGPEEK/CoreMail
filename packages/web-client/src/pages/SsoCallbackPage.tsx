import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { api, verifyMfa } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import type { UserProfile } from '../api/types.js';

/**
 * v6.1: landing page after the OIDC callback (/sso/callback?code=…).
 * Trades the one-time code for tokens via POST /auth/sso/exchange (bound to
 * the HttpOnly SSO cookie — tokens never travel in a URL). If the provider
 * requires CoreMail MFA, asks for the TOTP / backup code.
 */
export function SsoCallbackPage() {
  const navigate = useNavigate();
  const { setTokens, setProfile } = useAuthStore();
  const [error, setError] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const started = useRef(false);

  const finalize = async (accessToken: string, refreshToken: string) => {
    setTokens(accessToken, refreshToken);
    const profile = await api.get<UserProfile>('/user/profile');
    setProfile(profile.id, profile.email, profile.displayName, profile.role);
    navigate('/mail', { replace: true });
  };

  useEffect(() => {
    if (started.current) return; // StrictMode double effect — the code is single use
    started.current = true;
    const oneTime = new URLSearchParams(window.location.search).get('code') ?? '';
    window.history.replaceState(null, '', '/sso/callback'); // drop the code from the address bar/history
    void (async () => {
      try {
        const res = await fetch('/auth/sso/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ code: oneTime }),
        });
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (!res.ok) {
          setError(body['error'] === 'maintenance' ? String(body['message'] ?? 'Wartungsmodus aktiv') : String(body['error'] ?? 'SSO-Anmeldung fehlgeschlagen'));
          return;
        }
        if (body['mfaRequired']) { setChallengeToken(String(body['challengeToken'])); return; }
        await finalize(String(body['accessToken']), String(body['refreshToken']));
      } catch {
        setError('SSO-Anmeldung fehlgeschlagen');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const t = await verifyMfa(challengeToken, code.trim());
      await finalize(t.accessToken, t.refreshToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ungültiger Code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-accent to-blue-800">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-2xl p-8 w-full max-w-sm space-y-4">
        <h1 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <ShieldCheck size={18} /> Single Sign-On
        </h1>
        {challengeToken ? (
          <form onSubmit={submitMfa} className="space-y-3">
            <p className="text-sm text-gray-600">Bitte den Code aus Ihrer Authenticator-App oder einen Backup-Code eingeben.</p>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="one-time-code" />
            {error && <div className="text-sm text-red-700">{error}</div>}
            <button type="submit" disabled={loading || code.trim().length < 6} className="btn-primary w-full justify-center py-2 disabled:opacity-60">
              {loading ? 'Prüfen...' : 'Bestätigen'}
            </button>
          </form>
        ) : error ? (
          <>
            <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">{error}</div>
            <Link to="/login" className="text-sm text-accent hover:underline">Zurück zur Anmeldung</Link>
          </>
        ) : (
          <p className="text-sm text-gray-500 animate-pulse">Anmeldung wird abgeschlossen…</p>
        )}
      </div>
    </div>
  );
}
