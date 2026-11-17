import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';

/**
 * v6.1: "Sign in with <IdP>" buttons for the login page (OIDC SSO).
 * Providers come from the public GET /auth/sso/providers; the button is a
 * plain navigation to /auth/sso/<id>/start (server-side redirect to the IdP).
 * Also shows `?sso_error=<reason>` set by the callback redirect.
 */
export const SSO_ERROR_KEY: Record<string, TranslationKey> = {
  invalid_state: 'auth_sso_err_invalid_state',
  provider_unavailable: 'auth_sso_err_provider_unavailable',
  idp_error: 'auth_sso_err_idp_error',
  token_invalid: 'auth_sso_err_token_invalid',
  email_missing: 'auth_sso_err_email_missing',
  email_unverified: 'auth_sso_err_email_unverified',
  domain_not_allowed: 'auth_sso_err_domain_not_allowed',
  account_inactive: 'auth_sso_err_account_inactive',
  account_not_linked: 'auth_sso_err_account_not_linked',
  account_mismatch: 'auth_sso_err_account_mismatch',
  no_account: 'auth_sso_err_no_account',
  maintenance: 'auth_sso_err_maintenance',
};

interface Provider { id: string; name: string }

export function SsoButtons({ target }: { target: 'mwa' | 'bcp' }) {
  const t = useT();
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
        <div className="bg-danger-bg border border-danger-line rounded px-3 py-2 text-sm text-danger-fg">
          {t(SSO_ERROR_KEY[ssoError] ?? 'auth_sso_err_failed')}
        </div>
      )}
      {providers.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-xs text-fg-subtle">
            <span className="flex-1 border-t border-line" />{t('auth_sso_or')}<span className="flex-1 border-t border-line" />
          </div>
          {providers.map((p) => (
            <a
              key={p.id}
              href={`/auth/sso/${encodeURIComponent(p.id)}/start?target=${target}`}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm border border-line-strong rounded hover:bg-surface-2 text-fg-muted"
            >
              <KeyRound size={14} /> {t('auth_sso_sign_in_with')} {p.name}
            </a>
          ))}
        </>
      )}
    </div>
  );
}
