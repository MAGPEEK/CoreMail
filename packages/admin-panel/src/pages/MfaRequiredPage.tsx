import { ShieldAlert, ExternalLink, LogOut, RefreshCw } from 'lucide-react';
import { logoutSession } from '../api/client.js';
import { useT } from '../i18n/useT.js';

/**
 * v3.18.19 D5: Mandatory 2FA setup page.
 * Shown when the API returns a 403 with code=MFA_REQUIRED — i.e.
 * when requireMfaForAdmins=true and the admin has no MFA enabled (10.5: the
 * default of fresh installations) — or MFA_ENROLMENT_REQUIRED ("MFA für alle
 * Benutzer erzwingen", grace period over).
 *
 * This page links to the webmail's Settings → Security so the user can enable
 * 2FA there (BCP has no MFA setup UI of its own; the webmail stays usable for
 * that). After activation "Erneut prüfen" leads back to /bcp/, which asks for a
 * sign-in with the second factor.
 */
export function MfaRequiredPage() {
  const t = useT();
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-2 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-lg w-full p-8 border border-warning-line">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-full bg-warning-bg flex items-center justify-center shrink-0">
            <ShieldAlert size={24} className="text-warning-fg" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-fg">
              {t('mfa_req_title')}
            </h1>
            <p className="text-sm text-fg-muted mt-2">
              {t('mfa_req_text')}
            </p>
            <p className="text-sm text-fg-muted mt-2">
              {t('mfa_req_webmail_note')}
            </p>

            <div className="mt-5 p-4 bg-surface-2 rounded border border-line">
              <h2 className="text-sm font-medium text-fg mb-2">
                {t('mfa_req_howto')}
              </h2>
              <ol className="text-sm text-fg-muted space-y-1 list-decimal pl-5">
                <li>{t('mfa_req_step_open')}</li>
                <li>{t('mfa_req_step_settings')}</li>
                <li>{t('mfa_req_step_setup')}</li>
                <li>{t('mfa_req_step_recheck')}</li>
              </ol>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <a
                href="/settings#security"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded transition-colors"
              >
                <ExternalLink size={14} />
                {t('mfa_req_step_open')}
              </a>
              <button
                onClick={() => { window.location.href = '/bcp/'; }}
                className="inline-flex items-center gap-2 px-4 py-2 border border-line-strong text-fg-muted text-sm rounded hover:bg-surface-2 transition-colors"
              >
                <RefreshCw size={14} />
                {t('mfa_req_recheck')}
              </button>
              <button
                onClick={() => {
                  void logoutSession().finally(() => { window.location.href = '/bcp/login'; });
                }}
                className="inline-flex items-center gap-2 px-4 py-2 border border-line-strong text-fg-muted text-sm rounded hover:bg-surface-2 transition-colors ml-auto"
              >
                <LogOut size={14} />
                {t('topbar_sign_out')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
