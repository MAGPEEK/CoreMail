import { ExternalLink, Tag, Clock, GitBranch, BookOpen, Shield, Github, HardDriveDownload } from 'lucide-react';

const VERSION        = '2.1.37';
const BUILD_DATE     = '2026-05-17';
const GITHUB_URL     = 'https://github.com/MAGPEEK/CoreMail';
const CHANGELOG_URL  = `${GITHUB_URL}/blob/main/CHANGELOG.md`;
const DOCKERHUB_URL  = 'https://hub.docker.com/r/magpeek/coremail-app';

const HIGHLIGHTS = [
  { version: '2.1.37', date: '2026-05-17', title: 'RFC 6749 OAuth 2.0 vollständige Implementierung',
    notes: 'Client Credentials Grant (§4.4), Password Grant (§4.3), Client HTTP-Basic-Auth (§2.3.1), Token Introspection (RFC 7662), OIDC ID Token bei openid-Scope, CORS auf allen OAuth-Endpunkten, Scope-Validierung (§3.3), Consent-Tracking mit OAuthConsent-Modell, pkceRequired-Flag für Public Clients (SPAs/native Apps), BASE_URL aus DB, nonce-Parameter, Token-Rotation bei Refresh.' },
  { version: '2.1.36', date: '2026-05-17', title: 'Hostname aus Admin-Panel (DB) + RFC 8314/6409/1730/1939 Ports',
    notes: 'MAIL_HOSTNAME aus .env entfernt — Hostname wird primär im Admin-Panel (Server-Einstellungen) konfiguriert und in der Datenbank gespeichert. Gilt global für SMTP-EHLO-Banner, IMAP- und POP3-Begrüßung. Live-Update via Redis settings:reload Channel — kein Neustart nötig. Received:-Header bei Submission (RFC 6409 §6.1). Compose-Dateien bereinigt.' },
  { version: '2.1.35', date: '2026-05-17', title: 'SMTP: RFC 5321-konformer State Machine (Postfix-Architektur)',
    notes: 'smtp-server npm-Paket ersetzt durch eigene TCP-Implementierung. SmtpSession-Klasse: EHLO/HELO, AUTH PLAIN + LOGIN (RFC 4954), STARTTLS (RFC 3207), MAIL FROM/RCPT TO/DATA mit Dot-Stuffing, RSET/NOOP/VRFY/QUIT, Timeout-Management (RFC §4.5.3.2), Max-Line-Length 1000 Zeichen. Postfix-Architektur: Inbound (Port 25, kein Auth) + Submission (Port 465/587, Auth Pflicht, Anti-Spoofing).' },
  { version: '2.1.34', date: '2026-05-17', title: 'SMTP AUTH: 535 Authentication not implemented behoben',
    notes: 'Neuer Submission-Server (Ports 465/587) mit vollständigem onAuth-Handler: prüft Passwort gegen User.passwordHash (bcrypt + pepper) und App-Passwörter. Anti-Spoofing: FROM-Adresse muss mit authentifiziertem User übereinstimmen (oder Shared-Mailbox-Berechtigung SEND_AS/FULL_ACCESS). Port 25 (Inbound) bleibt authOptional für externe MTAs. Lokale Empfänger werden direkt zugestellt, externe über Outbound-Queue.' },
  { version: '2.1.33', date: '2026-05-17', title: 'Setup: E-Mail-Feld folgt Domain automatisch',
    notes: 'Erstkonfiguration: Administrator-E-Mail wird beim Tippen der Domain durchgehend als „admin@<domain>" synchronisiert (emailEdited-Flag verhindert Überschreiben nach manueller Änderung). Bisherige Logik (!email.includes(\'@\')) brach nach dem ersten Zeichen ab.' },
  { version: '2.1.32', date: '2026-05-17', title: 'Postgres Startup-Fix (Synology) + definitiver Port-Close',
    notes: 'entrypoint: prisma db push Retry-Schleife (60×5s) statt einmaligem Versuch mit ignoriertem Fehler. Port-Close: vollständig synchron — server.close() gibt OS-Port via _handle.close() synchron frei + _handle direkt schließen als Nuklear-Option. Kein Warten auf Callback mehr.' },
  { version: '2.1.31', date: '2026-05-17', title: 'Port-Close Root-Cause-Fix: Socket-Tracking + Reload-Mutex',
    notes: 'net.Server.closeAllConnections() existiert nicht auf net.Server (nur http.Server) — optionales Chaining war ein stiller No-Op. Fix: Sockets manuell in Set<net.Socket> tracken, beim Schließen socket.destroy() auf alle Verbindungen. Reload-Mutex (scheduleReload) verhindert parallele Reload-Aufrufe durch Redis-Signal + 10-s-Poll.' },
  { version: '2.1.30', date: '2026-05-17', title: 'Listener-Reload bei DELETE/PUT/POST + Standards-Button',
    notes: 'DELETE und PUT/POST sendeten kein Redis-Reload-Signal → Ports blieben nach Löschen/Bearbeiten bis zum 10-s-Poll offen. Fix: publishReload() nach jeder DB-Operation. Neuer „Standards"-Button stellt Default-Ports (SMTP 25/465/587, IMAP 143/993, POP3 110/995) sofort wieder her inkl. sofortigem Redis-Signal. Übersicht-Hinweis auf dynamisch aktualisiert.' },
  { version: '2.1.29', date: '2026-05-17', title: 'Services Port-Toggle: Startup liest DB-Zustand',
    notes: 'Startup-Code startete Ports immer hardcodiert — Interval-Poll schloss sie danach wieder weil DB active=false. Fix: Startup liest jetzt zuerst DB-Zustand (reloadListeners). Nur beim allerersten Start werden Defaults geseedet. POP3-Server auf main()-Pattern umgestellt. Geister-Eintrag IMAP Port 994 entfernt.' },
  { version: '2.1.28', date: '2026-05-17', title: 'Postfach anlegen: nur aktive Domains',
    notes: 'Domain-Dropdown beim Anlegen neuer Postfächer zeigt nur noch aktive Domains. Deaktivierte Domains werden ausgeblendet. Hinweistext wenn alle Domains deaktiviert sind.' },
  { version: '2.1.27', date: '2026-05-17', title: 'SMTP/IMAP/POP3 Port-Toggle zuverlässig',
    notes: 'server.close() und closeAllConnections() werden jetzt gleichzeitig aufgerufen statt hintereinander. Port wird sofort aus der Map entfernt (verhindert Doppel-Close bei parallelen Reload-Aufrufen). Timeout nach 3 s als Harter Fallback. Zusätzlich 10-Sekunden-Poll als Fallback falls Redis-Signal verloren geht.' },
  { version: '2.1.26', date: '2026-05-17', title: 'bcryptjs statischer Import + smtp-server Property-Fix',
    notes: 'bcryptjs: dynamischer import() gibt { default: module } zurück (CJS in ESM) → bcrypt.hash is not a function. Fix: statischer import statt dynamic. SMTP Port-Toggle: smtp-server nutzt intern .server (nicht ._server) → closeAllConnections() wurde nie aufgerufen → Port blieb aktiv. Property-Name korrigiert.' },
  { version: '2.1.25', date: '2026-05-17', title: 'bcrypt-Fix + Port-Toggle sofortig wirksam',
    notes: 'bcrypt fehlte als Runtime-Dependency → Postfach anlegen/Login schlug mit "Cannot find package bcrypt" fehl. Auf bcryptjs (pure JS, kein native build) gewechselt. Port-Toggle: server.close() wartete auf bestehende Verbindungen → Port blieb laut netstat aktiv. Jetzt closeAllConnections() vor close() für SMTP/IMAP/POP3.' },
  { version: '2.1.24', date: '2026-05-17', title: 'Postfach-Erstellung Fix + Services Port-Toggle',
    notes: 'Postfach anlegen hatte kein try-catch — Prisma-Fehler hingen in Express v4. Services Port-Toggle sendete jetzt ein Redis-Signal an SMTP/IMAP/POP3-Server, die den Port sofort schließen/öffnen ohne Neustart.' },
  { version: '2.1.23', date: '2026-05-17', title: 'BCP Server-Seite bereinigt',
    notes: 'Mail-Protokolle (IMAP/POP3/SMTP Host, Port, TLS) aus BCP → Server → Virtuelle Verzeichnisse entfernt — gehört zu Services. Organisationsname entfernt — doppeltes Feld.' },
  { version: '2.1.22', date: '2026-05-17', title: 'ECP Theme-Unabhängigkeit + MFA TOTP für OWA',
    notes: 'ECP: Akzentfarbe immer Microsoft-Blau (unabhängig vom OWA-Theme), eigener coremail-ecp-theme Key, kein Cross-Tab-Sync mit OWA. OWA: Zweistufige Anmeldung mit TOTP (RFC 6238), vollständige 2FA-Verwaltung in Einstellungen (QR-Code, Backup-Codes, Deaktivieren). Neuer GET /auth/mfa/status Endpunkt.' },
  { version: '2.1.21', date: '2026-05-17', title: 'ECP TopBar: Angemeldeter User + Theme-Toggle',
    notes: 'Neue TopBar im Admin-Panel: zeigt angemeldeten Benutzer (E-Mail, Rolle) mit Avatar-Dropdown und Abmelden-Button. Theme-Umschalter (System/Hell/Dunkel) direkt in der TopBar. Sidebar-Header und alter Logout-Button entfernt.' },
  { version: '2.1.20', date: '2026-05-17', title: 'Toggle-Fix, Dark Mode ECP, SMTP & Routing',
    notes: 'Schutzfilter-Toggle korrigiert (Knob-Position + Dark-Mode-weiß). Dark Mode im Admin-Panel (ECP) via ThemeApplier + CSS-Overrides. Rspamd-Auth-Fix (secure_ip). Navigation: SMTP-Konfiguration → SMTP & Routing.' },
  { version: '2.1.19', date: '2026-05-17', title: 'Observability-Stack entfernt',
    notes: 'Grafana, Prometheus, Alertmanager, Tempo, Loki und OTEL Collector aus dem Docker-Stack entfernt. docker-compose.yml bereinigt. Synology-Compose (docker-compose.synology.yml) auf 2.1.19 aktualisiert und um rspamd + clamav ergänzt.' },
  { version: '2.0.19', date: '2026-05-16', title: 'Passwort ändern & Design-Einstellungen',
    notes: 'OWA: Passwort-Änderungsformular mit Stärkemeter. Design-Einstellungen mit Hell/Dunkel/System-Farbschema und 6 Akzentfarben (sofortige Anwendung). Persistenz via localStorage. Dark-Mode via Tailwind-Klasse, Accent-Farbe via CSS-Variable.' },
  { version: '1.9.19', date: '2026-05-16', title: 'SSO & LDAP / Active Directory',
    notes: 'ECP-Verwaltung für OIDC/OAuth2-Provider (Azure AD, Google, Keycloak, Authentik, Okta) mit Schnellauswahl und Discovery-URL-Test. SAML 2.0 Referenz. LDAP/AD-Verbindungsverwaltung mit Attributzuordnung, Sync-Steuerung und Verbindungstest. Info ganz unten in der Navigation.' },
  { version: '1.8.19', date: '2026-05-16', title: 'Message Queue Management',
    notes: 'Vollständige SMTP-Queue-Verwaltung mit Sub-Navigation: Übersicht (5 Stat-Cards), Ausgehend, Wiederholung (Retry), Dead Letter (Einzelrestart/Alle wiederholen), Einstellungen (Retention, Backoff, Auto-Flush). BullMQ-native API.' },
  { version: '1.7.19', date: '2026-05-16', title: 'Quarantine Detail-View',
    notes: 'Vollständige Quarantäne-Verwaltung mit Detail-Slide-over, MIME-Vorschau aus MinIO, Massen-Selektion, Bereinigung nach Alter, Nummernpagination.' },
  { version: '1.6.19', date: '2026-05-16', title: 'SMTP-Infrastruktur-Konfiguration',
    notes: 'Neue ECP-Seite: Erlaubte ESMTP-Befehle, lokale Zustellung, SMTP-Banner-Override, Greylisting, Relay-Konfiguration, Verbindungslimits. 27 Einstellungsfelder.' },
  { version: '1.5.19', date: '2026-05-16', title: 'Rspamd 4.0 + ClamAV Integration',
    notes: 'Vollständige Sicherheits- & Filterkonfiguration: Rspamd 4.0-Schwellwerte, ClamAV-Status, DNSBL, Greylisting, Länderfilter, Anhänge-Filter.' },
];

function StatBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 min-w-[120px]">
      <span className="text-xs text-gray-500 mb-0.5">{label}</span>
      <span className="text-base font-semibold text-gray-900">{value}</span>
    </div>
  );
}


export function ComplianceInfoPage() {
  return (
    <div className="p-6 max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Shield size={20} className="text-accent" />
        <h1 className="text-xl font-semibold text-gray-900">System-Informationen</h1>
      </div>

      {/* Version card */}
      <div className="card p-5 flex items-start gap-5">
        <div className="w-14 h-14 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
          <Tag size={24} className="text-accent" />
        </div>
        <div className="flex-1">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-0.5">Aktuelle Version</p>
          <p className="text-3xl font-bold text-gray-900">v{VERSION}</p>
          <p className="text-sm text-gray-500 mt-0.5">CoreMail — Open-Source Mailserver</p>
        </div>
        <div className="flex gap-3">
          <StatBadge label="Build" value={BUILD_DATE} />
          <StatBadge label="Lizenz" value="MIT" />
        </div>
      </div>

      {/* Links */}
      <div className="card p-5 space-y-3">
        <p className="text-sm font-semibold text-gray-700">Ressourcen</p>
        <div className="grid grid-cols-2 gap-3">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50 transition-colors group"
          >
            <Github size={18} className="text-gray-600 group-hover:text-gray-900 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">GitHub Repository</p>
              <p className="text-xs text-gray-400">MAGPEEK/CoreMail</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-gray-400 group-hover:text-gray-600" />
          </a>
          <a
            href={CHANGELOG_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50 transition-colors group"
          >
            <BookOpen size={18} className="text-gray-600 group-hover:text-gray-900 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">Changelog</p>
              <p className="text-xs text-gray-400">Keep a Changelog Format</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-gray-400 group-hover:text-gray-600" />
          </a>
          <a
            href={`${GITHUB_URL}/releases`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50 transition-colors group"
          >
            <GitBranch size={18} className="text-gray-600 group-hover:text-gray-900 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">Releases</p>
              <p className="text-xs text-gray-400">GitHub Releases</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-gray-400 group-hover:text-gray-600" />
          </a>
          <a
            href={`${GITHUB_URL}/issues`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50 transition-colors group"
          >
            <Shield size={18} className="text-gray-600 group-hover:text-gray-900 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">Issues &amp; Support</p>
              <p className="text-xs text-gray-400">Bugs &amp; Feature Requests</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-gray-400 group-hover:text-gray-600" />
          </a>
          <a
            href={DOCKERHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 border border-gray-200 rounded-lg px-4 py-3 hover:bg-gray-50 transition-colors group"
          >
            <HardDriveDownload size={18} className="text-gray-600 group-hover:text-gray-900 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">Docker Hub</p>
              <p className="text-xs text-gray-400">magpeek/coremail-app</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-gray-400 group-hover:text-gray-600" />
          </a>
        </div>
      </div>

      {/* Recent changelog */}
      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-700">Letzte Versionen</p>
        <div className="space-y-4">
          {HIGHLIGHTS.map((h, i) => (
            <div key={h.version} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                  i === 0 ? 'bg-accent/15 text-accent' : 'bg-gray-100 text-gray-400'
                }`}>
                  <Tag size={12} />
                </div>
                {i < HIGHLIGHTS.length - 1 && <div className="w-px flex-1 bg-gray-200 mt-1" />}
              </div>
              <div className="pb-4">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    i === 0 ? 'bg-accent/10 text-accent' : 'bg-gray-100 text-gray-600'
                  }`}>
                    v{h.version}
                  </span>
                  <span className="text-xs text-gray-400 flex items-center gap-1">
                    <Clock size={10} />
                    {h.date}
                  </span>
                </div>
                <p className="text-sm font-medium text-gray-800">{h.title}</p>
                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{h.notes}</p>
              </div>
            </div>
          ))}
        </div>
        <a
          href={CHANGELOG_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
        >
          Vollständiger Changelog auf GitHub
          <ExternalLink size={11} />
        </a>
      </div>

      {/* Stack */}
      <div className="card p-5 space-y-3">
        <p className="text-sm font-semibold text-gray-700">Technologie-Stack</p>
        <div className="flex flex-wrap gap-2">
          {[
            'Node.js 22', 'TypeScript 5.5', 'React 19', 'Vite', 'TailwindCSS',
            'Prisma 5', 'PostgreSQL 16', 'Redis 7', 'Rspamd 4.0', 'ClamAV',
            'Docker', 'pnpm Workspaces',
          ].map(t => (
            <span key={t} className="bg-gray-100 text-gray-700 text-xs px-2.5 py-1 rounded-full font-medium">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
