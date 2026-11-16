import { ShieldAlert, ExternalLink, LogOut, RefreshCw } from 'lucide-react';
import { logoutSession } from '../api/client.js';

/**
 * v3.18.19 D5: Mandatory 2FA setup page.
 * Shown when the API returns a 403 with code=MFA_REQUIRED — i.e.
 * when requireMfaForAdmins=true and the admin has no MFA enabled.
 *
 * This page redirects to the MWA (/owa/) so the user can enable 2FA there
 * under Settings → Security (BCP has no
 * MFA setup UI of its own). After activation the user can return to /bcp/.
 */
export function MfaRequiredPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-2 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-lg w-full p-8 border border-warning-line">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-full bg-warning-bg flex items-center justify-center shrink-0">
            <ShieldAlert size={24} className="text-warning-fg" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-fg">
              Zwei-Faktor-Authentifizierung erforderlich
            </h1>
            <p className="text-sm text-fg-muted mt-2">
              Dein Konto hat Administrator-Rechte. Aus Sicherheitsgründen ist
              die Aktivierung der Zwei-Faktor-Authentifizierung (2FA)
              verpflichtend, bevor du das Admin-Panel weiter nutzen kannst.
            </p>

            <div className="mt-5 p-4 bg-surface-2 rounded border border-line">
              <h2 className="text-sm font-medium text-fg mb-2">
                So aktivierst du 2FA:
              </h2>
              <ol className="text-sm text-fg-muted space-y-1 list-decimal pl-5">
                <li>Webmail öffnen</li>
                <li>Einstellungen → Sicherheit → Zwei-Faktor-Authentifizierung</li>
                <li>Authenticator-App (TOTP) oder Sicherheitsschlüssel einrichten</li>
                <li>Hier „Erneut prüfen“ wählen und sich mit dem zweiten Faktor neu anmelden</li>
              </ol>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <a
                href="/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded transition-colors"
              >
                <ExternalLink size={14} />
                Webmail öffnen
              </a>
              <button
                onClick={() => { window.location.href = '/bcp/'; }}
                className="inline-flex items-center gap-2 px-4 py-2 border border-line-strong text-fg-muted text-sm rounded hover:bg-surface-2 transition-colors"
              >
                <RefreshCw size={14} />
                Erneut prüfen
              </button>
              <button
                onClick={() => {
                  void logoutSession().finally(() => { window.location.href = '/bcp/login'; });
                }}
                className="inline-flex items-center gap-2 px-4 py-2 border border-line-strong text-fg-muted text-sm rounded hover:bg-surface-2 transition-colors ml-auto"
              >
                <LogOut size={14} />
                Abmelden
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
