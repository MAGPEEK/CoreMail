import { ShieldAlert, ExternalLink, LogOut, RefreshCw } from 'lucide-react';
import { clearToken } from '../api/client.js';

/**
 * v3.18.19 D5: Pflicht-2FA-Setup-Seite.
 * Wird aufgerufen wenn API ein 403 mit code=MFA_REQUIRED zurückgibt — also
 * wenn requireMfaForAdmins=true und der Admin keine MFA aktiviert hat.
 *
 * Diese Seite leitet auf das MWA (/owa/) weiter, damit der User dort
 * Einstellungen → Sicherheit → 2FA aktivieren kann (BCP hat selbst kein
 * eigenes MFA-Setup-UI). Nach Aktivierung kann der User zurück zu /bcp/.
 */
export function MfaRequiredPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-8 border border-amber-200 dark:border-amber-500/30">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center shrink-0">
            <ShieldAlert size={24} className="text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Zwei-Faktor-Authentifizierung erforderlich
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-2">
              Dein Konto hat Administrator-Rechte. Aus Sicherheitsgründen ist
              die Aktivierung der Zwei-Faktor-Authentifizierung (2FA)
              verpflichtend, bevor du das Admin-Panel weiter nutzen kannst.
            </p>

            <div className="mt-5 p-4 bg-gray-50 dark:bg-gray-900/50 rounded border border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
                So aktivierst du 2FA:
              </h2>
              <ol className="text-sm text-gray-600 dark:text-gray-300 space-y-1 list-decimal pl-5">
                <li>Webmail öffnen</li>
                <li>Einstellungen → Sicherheit → Zwei-Faktor-Authentifizierung</li>
                <li>TOTP-App (z. B. Authy, Google Authenticator) verbinden</li>
                <li>Hierher zurückkommen — Zugriff wird automatisch freigeschaltet</li>
              </ol>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <a
                href="/owa/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded transition-colors"
              >
                <ExternalLink size={14} />
                Webmail öffnen
              </a>
              <button
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 text-sm rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <RefreshCw size={14} />
                Erneut prüfen
              </button>
              <button
                onClick={() => {
                  clearToken();
                  window.location.href = '/bcp/login';
                }}
                className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 text-sm rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ml-auto"
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
