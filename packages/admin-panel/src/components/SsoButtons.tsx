import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';

/**
 * v6.1: "Sign in with <IdP>" buttons for the login page (OIDC SSO).
 * Providers come from the public GET /auth/sso/providers; the button is a
 * plain navigation to /auth/sso/<id>/start (server-side redirect to the IdP).
 * Also shows `?sso_error=<reason>` set by the callback redirect.
 */
export const SSO_ERROR_TEXT: Record<string, string> = {
  invalid_state: 'Die SSO-Anmeldung ist abgelaufen oder ungültig. Bitte erneut versuchen.',
  provider_unavailable: 'Der Identitätsanbieter ist derzeit nicht erreichbar.',
  idp_error: 'Der Identitätsanbieter hat die Anmeldung abgebrochen oder abgelehnt.',
  token_invalid: 'Die Antwort des Identitätsanbieters war ungültig.',
  email_missing: 'Der Identitätsanbieter hat keine E-Mail-Adresse übermittelt.',
  email_unverified: 'Die E-Mail-Adresse ist beim Identitätsanbieter nicht verifiziert.',
  domain_not_allowed: 'Diese E-Mail-Domain ist für die SSO-Anmeldung nicht freigegeben.',
  account_inactive: 'Dieses Konto ist deaktiviert.',
  account_not_linked: 'Für diese Adresse besteht ein Konto, das nicht für SSO freigegeben ist.',
  account_mismatch: 'Dieses Konto ist mit einer anderen Identität verknüpft.',
  no_account: 'Für diese Adresse existiert kein Konto.',
  maintenance: 'Der Server befindet sich im Wartungsmodus.',
};

interface Provider { id: string; name: string }

export function SsoButtons({ target }: { target: 'mwa' | 'bcp' }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const ssoError = new URLSearchParams(window.location.search).get('sso_error');

  useEffect(() => {
    fetch('/auth/sso/providers')
      .then((r) => (r.ok ? r.json() : []))
      .then((d: Provider[]) => setProviders(Array.isArray(d) ? d : []))
      .catch(() => setProviders([]));
  }, []);

  if (providers.length === 0 && !ssoError) return null;

  return (
    <div className="mt-4 space-y-2">
      {ssoError && (
        <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">
          {SSO_ERROR_TEXT[ssoError] ?? 'Die SSO-Anmeldung ist fehlgeschlagen.'}
        </div>
      )}
      {providers.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className="flex-1 border-t border-gray-200 dark:border-gray-700" />oder<span className="flex-1 border-t border-gray-200 dark:border-gray-700" />
          </div>
          {providers.map((p) => (
            <a
              key={p.id}
              href={`/auth/sso/${encodeURIComponent(p.id)}/start?target=${target}`}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200"
            >
              <KeyRound size={14} /> Anmelden mit {p.name}
            </a>
          ))}
        </>
      )}
    </div>
  );
}
