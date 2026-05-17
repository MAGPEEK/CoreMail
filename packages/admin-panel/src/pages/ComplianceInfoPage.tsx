import { ExternalLink, Tag, Clock, GitBranch, BookOpen, Shield, Github, Container, Copy, Check as CheckIcon } from 'lucide-react';
import { useState } from 'react';

const VERSION        = '2.1.19';
const BUILD_DATE     = '2026-05-17';
const GITHUB_URL     = 'https://github.com/MAGPEEK/CoreMail';
const CHANGELOG_URL  = `${GITHUB_URL}/blob/main/CHANGELOG.md`;
const DOCKERHUB_URL  = 'https://hub.docker.com/r/magpeek/coremail-app';
const DOCKER_IMAGE   = `magpeek/coremail-app:${VERSION}`;
const DOCKER_PULL    = `docker pull ${DOCKER_IMAGE}`;

const HIGHLIGHTS = [
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button
      onClick={copy}
      title="Kopieren"
      className="p-1.5 rounded hover:bg-gray-700 transition-colors shrink-0"
    >
      {copied
        ? <CheckIcon size={13} className="text-green-400" />
        : <Copy size={13} className="text-gray-400" />}
    </button>
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
            <Container size={18} className="text-gray-600 group-hover:text-gray-900 shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">Docker Hub</p>
              <p className="text-xs text-gray-400">magpeek/coremail-app</p>
            </div>
            <ExternalLink size={13} className="ml-auto text-gray-400 group-hover:text-gray-600" />
          </a>
        </div>
      </div>

      {/* Docker */}
      <div className="card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Container size={15} className="text-gray-500" />
          <p className="text-sm font-semibold text-gray-700">Docker</p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Image</p>
            <p className="font-mono text-xs text-gray-800">{DOCKER_IMAGE}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Plattformen</p>
            <p className="text-xs text-gray-800">linux/amd64 · linux/arm64</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Registry</p>
            <a href={DOCKERHUB_URL} target="_blank" rel="noopener noreferrer"
              className="text-xs text-accent hover:underline">
              hub.docker.com/r/magpeek/coremail-app
            </a>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-0.5">GitHub</p>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer"
              className="text-xs text-accent hover:underline">
              MAGPEEK/CoreMail
            </a>
          </div>
        </div>

        {/* Pull-Befehl */}
        <div>
          <p className="text-xs text-gray-500 mb-1.5">Pull-Befehl</p>
          <div className="flex items-center gap-2 bg-gray-900 rounded-lg px-4 py-2.5">
            <span className="font-mono text-xs text-green-400 flex-1 select-all">{DOCKER_PULL}</span>
            <CopyButton text={DOCKER_PULL} />
          </div>
        </div>

        {/* Docker-Compose-Snippet */}
        <div>
          <p className="text-xs text-gray-500 mb-1.5">docker-compose.yml (Auszug)</p>
          <div className="relative bg-gray-900 rounded-lg px-4 py-3 overflow-x-auto">
            <CopyButton text={`services:\n  coremail:\n    image: ${DOCKER_IMAGE}\n    restart: unless-stopped\n    ports:\n      - "25:25"\n      - "587:587"\n      - "993:993"\n      - "3000:3000"\n    env_file: .env`} />
            <pre className="font-mono text-xs text-gray-300 leading-relaxed pr-8">{`services:
  coremail:
    image: ${DOCKER_IMAGE}
    restart: unless-stopped
    ports:
      - "25:25"
      - "587:587"
      - "993:993"
      - "3000:3000"
    env_file: .env`}</pre>
          </div>
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
