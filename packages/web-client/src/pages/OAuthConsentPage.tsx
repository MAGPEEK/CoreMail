import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldCheck, X, Check, Loader2 } from 'lucide-react';
import { useAuthStore } from '../store/auth.js';

/**
 * v3.18.22 D1: OAuth2-Consent-Seite.
 *
 * Wird vom MWA-LoginPage nach erfolgreichem Login aufgerufen, wenn der User
 * sich aus einem OAuth2-Authorize-Flow heraus angemeldet hat (URL-Query
 * enthält oauth2=1&client_id=...).
 *
 * Flow:
 *  1. Komponente liest OAuth-Parameter aus URL (client_id, redirect_uri, scope,
 *     state, code_challenge, nonce)
 *  2. Initialer POST an /auth/oauth2/authorize/complete ohne consentConfirmed
 *  3. Backend antwortet entweder:
 *     - `{ requiresConsent: true, client, requestedScopes, ... }` → UI zeigen
 *     - `{ redirect: "..." }` → bereits genehmigt, direkt weiterleiten
 *  4. User klickt „Erlauben" → zweiter POST mit consentConfirmed=true
 *  5. Backend liefert `redirect`-URL mit Authorization Code → wir machen
 *     window.location.assign() (volle Navigation zum Client)
 *  6. User klickt „Ablehnen" → Redirect zur Client redirect_uri mit
 *     `error=access_denied`
 */

interface ConsentInfo {
  client: { clientId: string; name: string; description?: string; trusted: boolean };
  requestedScopes: string[];
  alreadyGrantedScopes: string[];
  newScopes: string[];
}

// User-lesbare Scope-Beschreibungen (technische Strings → deutsche Texte)
const SCOPE_LABELS: Record<string, string> = {
  'openid':              'Identität (User-ID)',
  'profile':             'Profilinformationen (Name)',
  'email':               'E-Mail-Adresse',
  'offline_access':      'Dauerhafter Zugriff (Refresh-Token)',
  'mail.read':           'E-Mails lesen',
  'mail.send':           'E-Mails senden in deinem Namen',
  'mail.modify':         'E-Mails verschieben, löschen oder als gelesen markieren',
  'calendar.read':       'Kalender und Termine lesen',
  'calendar.write':      'Termine erstellen, ändern oder löschen',
  'contacts.read':       'Kontakte lesen',
  'contacts.write':      'Kontakte erstellen oder ändern',
};

function scopeLabel(s: string): string {
  return SCOPE_LABELS[s] ?? s;
}

export function OAuthConsentPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const userId = useAuthStore((s) => s.userId);

  const [phase, setPhase] = useState<'loading' | 'consent' | 'submitting' | 'error'>('loading');
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const clientId            = params.get('client_id') ?? '';
  const redirectUri         = params.get('redirect_uri') ?? '';
  const scope               = params.get('scope') ?? '';
  const state               = params.get('state') ?? '';
  const codeChallenge       = params.get('code_challenge') ?? '';
  const codeChallengeMethod = params.get('code_challenge_method') ?? '';
  const nonce               = params.get('nonce') ?? '';

  // Initial: prüfen ob Consent nötig oder schon vorhanden
  useEffect(() => {
    if (!userId || !clientId || !redirectUri) {
      setErrorMsg('Ungültige OAuth2-Anfrage');
      setPhase('error');
      return;
    }
    void (async () => {
      try {
        const res = await fetch('/auth/oauth2/authorize/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId, clientId, redirectUri, scope, state,
            codeChallenge, codeChallengeMethod, nonce,
          }),
        });
        if (!res.ok) {
          setErrorMsg(`OAuth-Fehler: HTTP ${res.status}`);
          setPhase('error');
          return;
        }
        const body = await res.json() as ConsentInfo & { redirect?: string; requiresConsent?: boolean };
        if (body.redirect) {
          // Bereits genehmigt → direkt zum Client zurück
          window.location.assign(body.redirect);
          return;
        }
        if (body.requiresConsent) {
          setInfo({
            client: body.client,
            requestedScopes: body.requestedScopes ?? [],
            alreadyGrantedScopes: body.alreadyGrantedScopes ?? [],
            newScopes: body.newScopes ?? [],
          });
          setPhase('consent');
          return;
        }
        setErrorMsg('Unerwartete Antwort vom Auth-Server');
        setPhase('error');
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Verbindungsfehler');
        setPhase('error');
      }
    })();
  }, [userId, clientId, redirectUri, scope, state, codeChallenge, codeChallengeMethod, nonce]);

  const handleGrant = async () => {
    setPhase('submitting');
    try {
      const res = await fetch('/auth/oauth2/authorize/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId, clientId, redirectUri, scope, state,
          codeChallenge, codeChallengeMethod, nonce,
          consentConfirmed: true,
        }),
      });
      if (!res.ok) {
        setErrorMsg(`OAuth-Fehler: HTTP ${res.status}`);
        setPhase('error');
        return;
      }
      const body = await res.json() as { redirect?: string };
      if (body.redirect) {
        window.location.assign(body.redirect);
        return;
      }
      setErrorMsg('Keine Redirect-URL erhalten');
      setPhase('error');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Verbindungsfehler');
      setPhase('error');
    }
  };

  const handleDeny = () => {
    // RFC 6749 §4.1.2.1 — error=access_denied im Redirect zurück
    const errParams = new URLSearchParams({
      error: 'access_denied',
      error_description: 'User denied the authorization request',
      ...(state ? { state } : {}),
    });
    window.location.assign(`${redirectUri}?${errParams.toString()}`);
  };

  if (phase === 'loading' || phase === 'submitting') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <Loader2 size={32} className="animate-spin mx-auto text-accent" />
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-3">
            {phase === 'submitting' ? 'Anfrage wird bestätigt …' : 'Verbinden …'}
          </p>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
        <div className="bg-white dark:bg-gray-800 border border-red-200 dark:border-red-500/30 rounded-lg shadow-xl max-w-md w-full p-6 text-center">
          <X size={32} className="mx-auto text-red-500" />
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-3">Fehler</h1>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">{errorMsg}</p>
          <button
            onClick={() => navigate('/mail')}
            className="mt-4 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90"
          >
            Zum Webmail
          </button>
        </div>
      </div>
    );
  }

  // phase === 'consent'
  if (!info) return null;
  const isNewClient = info.alreadyGrantedScopes.length === 0;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 border border-gray-200 dark:border-gray-700">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
            <ShieldCheck size={24} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Zugriff erlauben?
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
              <strong>{info.client.name}</strong> möchte auf dein CoreMail-Konto zugreifen.
            </p>
            {info.client.description && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{info.client.description}</p>
            )}
          </div>
        </div>

        <div className="mt-5">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
            {isNewClient ? 'Diese App möchte:' : 'Zusätzliche Berechtigungen:'}
          </p>
          <ul className="space-y-1.5 border border-gray-200 dark:border-gray-700 rounded p-3">
            {(isNewClient ? info.requestedScopes : info.newScopes).map((s) => (
              <li key={s} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
                <Check size={14} className="text-green-600 mt-0.5 shrink-0" />
                <span>{scopeLabel(s)}</span>
              </li>
            ))}
          </ul>
          {!isNewClient && info.alreadyGrantedScopes.length > 0 && (
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
              Bereits erteilt: {info.alreadyGrantedScopes.map(scopeLabel).join(', ')}
            </p>
          )}
        </div>

        <div className="mt-5 p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded text-xs text-amber-700 dark:text-amber-300">
          Du kannst diesen Zugriff jederzeit in den Einstellungen → Sicherheit
          → Verbundene Apps widerrufen.
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={handleDeny}
            className="flex-1 px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Ablehnen
          </button>
          <button
            onClick={handleGrant}
            className="flex-1 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 flex items-center justify-center gap-1.5"
          >
            <Check size={14} />
            Erlauben
          </button>
        </div>
      </div>
    </div>
  );
}
