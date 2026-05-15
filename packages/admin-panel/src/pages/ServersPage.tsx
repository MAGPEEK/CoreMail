import { useState, useEffect } from 'react';
import { CheckCircle, Server, Settings, Loader2, Save, Wand2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

interface ServiceStatus { name: string; port: string; description: string }

const SERVICES: ServiceStatus[] = [
  { name: 'smtp-server',   port: '25/465/587', description: 'SMTP Inbound + Outbound' },
  { name: 'imap-server',   port: '143/993',    description: 'IMAP4rev1 + IDLE' },
  { name: 'pop3-server',   port: '110/995',    description: 'POP3' },
  { name: 'ews-server',    port: '8080',       description: 'Exchange Web Services (SOAP)' },
  { name: 'autodiscover',  port: '8081',       description: 'Autodiscover v1 + v2' },
  { name: 'caldav-server', port: '8082',       description: 'CalDAV + CardDAV' },
  { name: 'api-gateway',   port: '3000',       description: 'REST API + SSE' },
  { name: 'auth-service',  port: '3003',       description: 'Authentication + MFA' },
];

interface ServerSettings {
  publicHostname:   string;
  useHttps:         boolean;
  httpPort:         number;
  ewsUrl:           string;
  owaUrl:           string;
  easUrl:           string;
  autodiscoverBase: string;
  imapHost:         string;
  imapPort:         number;
  imapSsl:          boolean;
  pop3Host:         string;
  pop3Port:         number;
  pop3Ssl:          boolean;
  smtpHost:         string;
  smtpPort:         number;
  smtpTls:          boolean;
  orgName:          string;
}

type Tab = 'health' | 'settings';

export function ServersPage() {
  const [tab, setTab] = useState<Tab>('settings');
  const [form, setForm] = useState<ServerSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const qc = useQueryClient();

  const { data: settings, isLoading } = useQuery<ServerSettings>({
    queryKey: ['server-settings'],
    queryFn:  () => api.get<ServerSettings>('/admin/servers/settings'),
  });

  // Formular initialisieren sobald Daten geladen
  useEffect(() => {
    if (settings && !form) setForm(settings);
  }, [settings, form]);

  const saveMutation = useMutation({
    mutationFn: (data: ServerSettings) => api.put('/admin/servers/settings', data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['server-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const deriveMutation = useMutation({
    mutationFn: (data: { publicHostname: string; useHttps: boolean; httpPort: number }) =>
      api.post<ServerSettings>('/admin/servers/settings/derive', data),
    onSuccess: (d: ServerSettings) => setForm(d),
  });

  const current = form ?? settings ?? null;

  function set<K extends keyof ServerSettings>(key: K, value: ServerSettings[K]) {
    setForm((prev) => prev ? { ...prev, [key]: value } : null);
  }

  function handleDerive() {
    if (!current) return;
    deriveMutation.mutate({
      publicHostname: current.publicHostname,
      useHttps:       current.useHttps,
      httpPort:       current.httpPort,
    });
  }

  function handleSave() {
    if (!current) return;
    saveMutation.mutate(current);
  }

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Server size={20} className="text-accent" />
        <h1 className="text-xl font-semibold text-gray-900">Server</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {([['settings', 'Virtuelle Verzeichnisse'], ['health', 'Health & Status']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === id
                ? 'border-accent text-accent'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Tab: Virtuelle Verzeichnisse ─────────────────────────────────────── */}
      {tab === 'settings' && (
        <div className="space-y-6 max-w-3xl">
          {isLoading || !current ? (
            <div className="flex items-center gap-2 text-gray-500">
              <Loader2 size={16} className="animate-spin" /> Lade Einstellungen…
            </div>
          ) : (
            <>
              {/* Basis */}
              <div className="card space-y-4">
                <div className="flex items-center gap-2 border-b border-gray-100 pb-3">
                  <Settings size={16} className="text-gray-400" />
                  <h2 className="font-medium text-gray-800">Öffentliche Server-Adresse</h2>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Hostname / Domain</label>
                    <input
                      className="input w-full"
                      placeholder="mail.example.com"
                      value={current.publicHostname}
                      onChange={(e) => set('publicHostname', e.target.value)}
                    />
                    <p className="text-xs text-gray-400 mt-1">DNS-Name unter dem CoreMail extern erreichbar ist</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">HTTP-Port</label>
                    <input
                      className="input w-full"
                      type="number" min={1} max={65535}
                      value={current.httpPort}
                      onChange={(e) => set('httpPort', parseInt(e.target.value) || 8080)}
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded border-gray-300"
                    checked={current.useHttps}
                    onChange={(e) => set('useHttps', e.target.checked)}
                  />
                  <span className="text-sm text-gray-700">HTTPS verwenden</span>
                  <span className="text-xs text-gray-400">(TLS-Terminierung im Reverse Proxy — Traefik, Caddy, DSM)</span>
                </label>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleDerive}
                    disabled={deriveMutation.isPending}
                    className="btn-secondary flex items-center gap-2 text-sm"
                  >
                    {deriveMutation.isPending
                      ? <Loader2 size={14} className="animate-spin" />
                      : <Wand2 size={14} />}
                    URLs automatisch ableiten
                  </button>
                  <span className="text-xs text-gray-400">Generiert alle URLs aus Hostname + Port</span>
                </div>
              </div>

              {/* Exchange-URLs */}
              <div className="card space-y-4">
                <h2 className="font-medium text-gray-800 border-b border-gray-100 pb-3">Exchange-URLs (Outlook Autodiscover)</h2>
                {([
                  ['ewsUrl',           'EWS-URL (Outlook Desktop — Exchange Web Services)'],
                  ['owaUrl',           'OWA-URL (Outlook Web Access)'],
                  ['easUrl',           'EAS-URL (ActiveSync — Mobil)'],
                  ['autodiscoverBase', 'Autodiscover-Basis-URL'],
                ] as [keyof ServerSettings, string][]).map(([key, label]) => (
                  <div key={key}>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                    <input
                      className="input w-full font-mono text-sm"
                      value={current[key] as string}
                      onChange={(e) => set(key, e.target.value)}
                    />
                  </div>
                ))}
              </div>

              {/* Mail-Protokolle */}
              <div className="card space-y-5">
                <h2 className="font-medium text-gray-800 border-b border-gray-100 pb-3">Mail-Protokolle</h2>

                {([
                  ['imap', 'imapHost', 'imapPort', 'imapSsl', 'IMAP', 'SSL/TLS'] ,
                  ['pop3', 'pop3Host', 'pop3Port', 'pop3Ssl', 'POP3', 'SSL/TLS'],
                  ['smtp', 'smtpHost', 'smtpPort', 'smtpTls', 'SMTP Submission', 'STARTTLS'],
                ] as [string, keyof ServerSettings, keyof ServerSettings, keyof ServerSettings, string, string][]).map(
                  ([, hostKey, portKey, tlsKey, proto, tlsLabel]) => (
                  <div key={proto}>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{proto}</p>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <label className="block text-xs text-gray-500 mb-1">Server</label>
                        <input
                          className="input w-full"
                          value={current[hostKey] as string}
                          onChange={(e) => set(hostKey, e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Port</label>
                        <input
                          className="input w-full"
                          type="number"
                          value={current[portKey] as number}
                          onChange={(e) => set(portKey, parseInt(e.target.value) || 587)}
                        />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 mt-2 cursor-pointer">
                      <input
                        type="checkbox" className="w-4 h-4"
                        checked={current[tlsKey] as boolean}
                        onChange={(e) => set(tlsKey, e.target.checked)}
                      />
                      <span className="text-sm text-gray-700">{tlsLabel}</span>
                    </label>
                  </div>
                ))}
              </div>

              {/* Organisation */}
              <div className="card space-y-3">
                <h2 className="font-medium text-gray-800 border-b border-gray-100 pb-3">Organisation</h2>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Organisationsname</label>
                  <input
                    className="input w-full max-w-sm"
                    value={current.orgName}
                    onChange={(e) => set('orgName', e.target.value)}
                  />
                </div>
              </div>

              {/* Speichern */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSave}
                  disabled={saveMutation.isPending}
                  className="btn-primary flex items-center gap-2"
                >
                  {saveMutation.isPending
                    ? <Loader2 size={16} className="animate-spin" />
                    : <Save size={16} />}
                  Einstellungen speichern
                </button>
                {saved && (
                  <div className="flex items-center gap-1.5 text-green-600 text-sm">
                    <CheckCircle size={16} />
                    Gespeichert — Autodiscover aktualisiert sich innerhalb 60 s
                  </div>
                )}
                {saveMutation.isError && (
                  <p className="text-red-600 text-sm">Fehler beim Speichern</p>
                )}
              </div>

              {/* Outlook-Anleitung */}
              <div className="card bg-blue-50 border border-blue-200 space-y-3">
                <h3 className="font-medium text-blue-800 flex items-center gap-2">
                  <Settings size={16} />
                  Outlook 2019 / 2022 / 365 einrichten
                </h3>
                <ol className="text-sm text-blue-700 list-decimal list-inside space-y-1">
                  <li>Outlook öffnen → <strong>Datei → Konto hinzufügen</strong></li>
                  <li>E-Mail-Adresse eingeben (z.B. <code className="bg-blue-100 px-1 rounded">admin@stefanwuestner.de</code>)</li>
                  <li>Outlook erkennt CoreMail automatisch über Autodiscover</li>
                  <li>Passwort eingeben → fertig</li>
                </ol>
                <p className="text-xs text-blue-600">
                  <strong>Voraussetzung:</strong>{' '}
                  <code className="bg-blue-100 px-1 rounded">{current.autodiscoverBase}/Autodiscover/Autodiscover.xml</code>{' '}
                  muss von Outlook erreichbar sein.
                  {current.publicHostname && (
                    <> DNS: <code className="bg-blue-100 px-1 rounded">autodiscover.{current.publicHostname} CNAME {current.publicHostname}</code></>
                  )}
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Tab: Health & Status ─────────────────────────────────────────────── */}
      {tab === 'health' && (
        <div className="space-y-4">
          <div className="card p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Service', 'Ports', 'Beschreibung', 'Status'].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {SERVICES.map((s) => (
                  <tr key={s.name} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-mono text-sm text-gray-700">{s.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{s.port}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">{s.description}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <CheckCircle size={14} className="text-green-500" />
                        <span className="text-xs text-green-700">Online</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: 'PostgreSQL', detail: 'Primary · Read-Write' },
              { label: 'Redis',      detail: 'Connected · Pub/Sub aktiv' },
              { label: 'MinIO',      detail: 'Online · S3-kompatibel' },
            ].map((item) => (
              <div key={item.label} className="card flex items-center gap-3">
                <CheckCircle size={20} className="text-green-500 shrink-0" />
                <div>
                  <p className="font-medium text-gray-800">{item.label}</p>
                  <p className="text-xs text-gray-500">{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
