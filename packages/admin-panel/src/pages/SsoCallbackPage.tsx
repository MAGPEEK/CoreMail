import { useEffect, useRef, useState } from 'react';
import { MfaChallengeForm } from '../components/MfaChallengeForm.js';
import { useNavigate, Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { setToken, setRefreshToken, exchangeSsoCode, type MfaMethod } from '../api/client.js';

/**
 * v6.1: BCP landing page after the OIDC callback (/bcp/sso/callback?code=…).
 * Trades the one-time code for tokens via POST /auth/sso/exchange (bound to
 * the HttpOnly SSO cookie — tokens never travel in a URL). If the provider
 * requires CoreMail MFA, asks for the TOTP / backup code.
 */
export function SsoCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [mfaMethod, setMfaMethod] = useState('totp');
  const [mfaMethods, setMfaMethods] = useState<MfaMethod[] | undefined>(undefined);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode double effect — the code is single use
    started.current = true;
    const oneTime = new URLSearchParams(window.location.search).get('code') ?? '';
    window.history.replaceState(null, '', '/bcp/sso/callback');
    if (!oneTime) { setError('SSO-Anmeldung abgebrochen oder abgelaufen — bitte erneut versuchen'); return; }
    void (async () => {
      try {
        const { ok, body } = await exchangeSsoCode(oneTime);
        if (!ok) {
          setError(body['error'] === 'maintenance' ? String(body['message'] ?? 'Wartungsmodus aktiv') : String(body['error'] ?? 'SSO-Anmeldung fehlgeschlagen'));
          return;
        }
        if (body['mfaRequired']) {
          // 9.1.x: all second factors of the account (security key too), like the password login
          setMfaMethod(String(body['method'] ?? 'totp'));
          setMfaMethods(Array.isArray(body['methods']) ? body['methods'] as MfaMethod[] : undefined);
          setChallengeToken(String(body['challengeToken']));
          return;
        }
        if (typeof body['refreshToken'] === 'string') setRefreshToken(body['refreshToken']);
        setToken(String(body['accessToken']));
        navigate('/dashboard', { replace: true });
      } catch {
        setError('SSO-Anmeldung fehlgeschlagen');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas">
      <div className="bg-surface rounded-lg shadow-2xl p-8 w-full max-w-sm space-y-4">
        <h1 className="text-lg font-bold text-fg flex items-center gap-2">
          <ShieldCheck size={18} /> Single Sign-On
        </h1>
        {challengeToken ? (
          <MfaChallengeForm
            challengeToken={challengeToken}
            method={mfaMethod}
            methods={mfaMethods}
            email=""
            onSuccess={(accessToken) => { setToken(accessToken); navigate('/dashboard', { replace: true }); }}
            onBack={(reason) => { setChallengeToken(''); setError(reason ?? 'SSO-Anmeldung abgebrochen'); }}
          />
        ) : error ? (
          <>
            <div role="alert" className="bg-danger-bg border border-danger-line rounded px-3 py-2 text-sm text-danger-fg">{error}</div>
            <Link to="/login" className="text-sm text-accent-fg hover:underline">Zurück zur Anmeldung</Link>
          </>
        ) : (
          <p className="text-sm text-fg-subtle animate-pulse">Anmeldung wird abgeschlossen…</p>
        )}
      </div>
    </div>
  );
}
