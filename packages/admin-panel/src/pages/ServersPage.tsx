import { useState, useEffect } from 'react';
import { CheckCircle, Server, Settings, Loader2, Save, Wand2, AlertCircle, RefreshCw, XCircle, HelpCircle } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { errorMessage } from '../lib/errors.js';
import { mergeDerivedUrls, publicOrigin } from '../lib/serverSettings.js';
import { WriteGuard } from '../components/Can.js';
import { ServerRestartCard } from '../components/ServerRestartCard.js';

interface ServerSettings {
  publicHostname:   string;
  useHttps:         boolean;
  httpPort:         number;
  owaUrl:           string;
  easUrl:           string;
  autodiscoverBase: string;
  // v5.7.1: JMAP — default on
  jmapEnabled:      boolean;
}

type HealthState = 'up' | 'down' | 'unknown';
interface HealthReport {
  checkedAt: string;
  services: Array<{ name: string; ports: string; description: string; status: HealthState; detail?: string }>;
  dependencies: Array<{ name: string; status: HealthState; detail?: string }>;
}

type Tab = 'health' | 'settings';

/** Only the fields this page edits — the PUT is partial, everything else stays as stored. */
function editable(s: ServerSettings): ServerSettings {
  return {
    publicHostname: s.publicHostname, useHttps: s.useHttps, httpPort: s.httpPort,
    owaUrl: s.owaUrl, easUrl: s.easUrl, autodiscoverBase: s.autodiscoverBase,
    jmapEnabled: s.jmapEnabled ?? true,
  };
}

function StatusBadge({ status }: { status: HealthState }) {
  if (status === 'up') {
    return <span className="inline-flex items-center gap-1.5 text-xs text-success-fg"><CheckCircle size={14} /> Online</span>;
  }
  if (status === 'down') {
    return <span className="inline-flex items-center gap-1.5 text-xs text-danger-fg"><XCircle size={14} /> Nicht erreichbar</span>;
  }
  return <span className="inline-flex items-center gap-1.5 text-xs text-fg-subtle"><HelpCircle size={14} /> Unbekannt</span>;
}

export function ServersPage() {
  const [tab, setTab] = useState<Tab>('settings');
  const [form, setForm] = useState<ServerSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const qc = useQueryClient();

  const { data: settings, isLoading, isError, refetch } = useQuery<ServerSettings>({
    queryKey: ['server-settings'],
    queryFn:  () => api.get<ServerSettings>('/admin/servers/settings'),
    retry: 1,
  });

  const health = useQuery<HealthReport>({
    queryKey: ['server-health'],
    queryFn:  () => api.get<HealthReport>('/admin/servers/health'),
    enabled:  tab === 'health',
    refetchInterval: tab === 'health' ? 30_000 : false,
  });

  // Initialize form once data is loaded
  useEffect(() => {
    if (settings && !form) setForm(editable(settings));
  }, [settings, form]);

  const saveMutation = useMutation({
    mutationFn: (data: ServerSettings) => api.put<ServerSettings>('/admin/servers/settings', data),
    onSuccess: (stored) => {
      // the server may re-derive stale URLs — show what was really stored
      setForm(editable(stored));
      qc.setQueryData(['server-settings'], stored);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: () => undefined, // shown inline below
  });

  const deriveMutation = useMutation({
    mutationFn: (data: { publicHostname: string; useHttps: boolean; httpPort: number }) =>
      api.post<Record<string, unknown>>('/admin/servers/settings/derive', data),
    // only the URL fields — the suggestions (orgName, ports) must not reach the save
    onSuccess: (d) => setForm((prev) => (prev ? mergeDerivedUrls(prev, d) : prev)),
  });

  const current = form;

  function set<K extends keyof ServerSettings>(key: K, value: ServerSettings[K]) {
    setForm((prev) => prev ? { ...prev, [key]: value } : null);
  }

  function handleDerive() {
    if (!current) return;
    deriveMutation.mutate({
      publicHostname: current.publicHostname.trim(),
      useHttps:       current.useHttps,
      httpPort:       current.httpPort,
    });
  }

  function handleSave() {
    if (!current) return;
    saveMutation.mutate({ ...current, publicHostname: current.publicHostname.trim() });
  }

  const portValid = !!current && Number.isInteger(current.httpPort) && current.httpPort >= 1 && current.httpPort <= 65535;
  const formValid = !!current && current.publicHostname.trim() !== '' && portValid;

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Server size={20} className="text-accent-fg" />
        <h1 className="text-xl font-semibold text-fg">Server</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-line" role="tablist">
        {([['settings', 'Virtuelle Verzeichnisse'], ['health', 'Health & Status']] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === id
                ? 'border-accent text-accent-fg'
                : 'border-transparent text-fg-subtle hover:text-fg-muted'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Tab: Virtual directories ─────────────────────────────────────────── */}
      {tab === 'settings' && (
        <div className="space-y-6 max-w-3xl">
          {isLoading ? (
            <div className="flex items-center gap-2 text-fg-subtle">
              <Loader2 size={16} className="animate-spin" /> Lade Einstellungen…
            </div>
          ) : isError ? (
            <div className="card flex items-center gap-3 text-danger-fg bg-danger-bg border border-danger-line">
              <AlertCircle size={18} className="shrink-0" />
              <div className="flex-1">
                <p className="font-medium">Einstellungen konnten nicht geladen werden</p>
                <p className="text-sm text-danger-fg mt-0.5">Session abgelaufen? Bitte neu anmelden oder erneut versuchen.</p>
              </div>
              <button onClick={() => void refetch()} className="btn-secondary flex items-center gap-1.5 text-sm">
                <RefreshCw size={14} /> Erneut versuchen
              </button>
            </div>
          ) : !current ? (
            <div className="flex items-center gap-2 text-fg-subtle">
              <Loader2 size={16} className="animate-spin" /> Lade Einstellungen…
            </div>
          ) : (
            <WriteGuard area="servers" className="space-y-6">
              {/* Base */}
              <div className="card space-y-4">
                <div className="flex items-center gap-2 border-b border-line pb-3">
                  <Settings size={16} className="text-fg-subtle" />
                  <h2 className="font-medium text-fg">Öffentliche Server-Adresse</h2>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label htmlFor="srv-hostname" className="block text-xs font-medium text-fg-muted mb-1">Hostname / Domain</label>
                    <input
                      id="srv-hostname"
                      className="input w-full"
                      placeholder="mail.example.com"
                      value={current.publicHostname}
                      onChange={(e) => set('publicHostname', e.target.value)}
                    />
                    <p className="text-xs text-fg-subtle mt-1">DNS-Name, unter dem CoreMail extern erreichbar ist</p>
                  </div>
                  <div>
                    <label htmlFor="srv-port" className="block text-xs font-medium text-fg-muted mb-1">HTTP-Port</label>
                    <input
                      id="srv-port"
                      className="input w-full"
                      type="number" min={1} max={65535}
                      value={Number.isNaN(current.httpPort) ? '' : current.httpPort}
                      onChange={(e) => set('httpPort', e.target.value === '' ? NaN : Number(e.target.value))}
                    />
                    {!portValid && <p className="text-xs text-danger-fg mt-1">Port 1–65535</p>}
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded border-line-strong"
                    checked={current.useHttps}
                    onChange={(e) => set('useHttps', e.target.checked)}
                  />
                  <span className="text-sm text-fg-muted">HTTPS verwenden</span>
                  <span className="text-xs text-fg-subtle">— TLS über HTTPS (Port 443) dieses Servers oder über einen Reverse Proxy</span>
                </label>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleDerive}
                    disabled={deriveMutation.isPending || !formValid}
                    className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50"
                  >
                    {deriveMutation.isPending
                      ? <Loader2 size={14} className="animate-spin" />
                      : <Wand2 size={14} />}
                    URLs automatisch ableiten
                  </button>
                  <span className="text-xs text-fg-subtle">Setzt die Client-URLs aus Hostname, HTTPS und Port (erst mit „Speichern“ übernommen)</span>
                </div>
              </div>

              {/* Client URLs (Autodiscover) */}
              <div className="card space-y-4">
                <h2 className="font-medium text-fg border-b border-line pb-3">Client-URLs (Autodiscover)</h2>
                {([
                  ['owaUrl',           'MWA-URL (Mail Web Access)'],
                  ['easUrl',           'EAS-URL (ActiveSync — Mobil)'],
                  ['autodiscoverBase', 'Autodiscover-Basis-URL'],
                ] as const).map(([key, label]) => (
                  <div key={key}>
                    <label htmlFor={`srv-${key}`} className="block text-xs font-medium text-fg-muted mb-1">{label}</label>
                    <input
                      id={`srv-${key}`}
                      className="input w-full font-mono text-sm"
                      value={current[key]}
                      onChange={(e) => set(key, e.target.value)}
                    />
                  </div>
                ))}
              </div>

              {/* JMAP — v5.7.1 */}
              <div className="card space-y-3">
                <h2 className="font-medium text-fg border-b border-line pb-3">JMAP</h2>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded border-line-strong"
                    checked={current.jmapEnabled}
                    onChange={(e) => set('jmapEnabled', e.target.checked)}
                  />
                  <span className="text-sm text-fg-muted">JMAP aktivieren</span>
                  <span className="text-xs text-fg-subtle">(Standard: an)</span>
                </label>
                <p className="text-xs text-fg-subtle">
                  JSON-Mail-Protokoll als moderner IMAP/SMTP-Ersatz. Discovery über{' '}
                  <code className="bg-surface-2 px-1 rounded">{publicOrigin(current.publicHostname.trim() || 'mail.example.com', current.useHttps, portValid ? current.httpPort : 443)}/.well-known/jmap</code>,
                  Session unter <code className="bg-surface-2 px-1 rounded">/jmap/session</code>. Login per App-Passwort (Basic) oder Session-Token (Bearer).
                  Enthalten: Mail (Mailbox/Email/Thread/Identity/EmailSubmission), Push über EventSource und WebSocket,
                  Blob-Methoden, Quota, Principals/Sharing, VAPID.
                  Aus: <code className="bg-surface-2 px-1 rounded">/jmap/*</code> liefert 404. Die Umschaltung greift ohne Neustart.
                </p>
                <p className="text-xs text-fg-subtle">
                  DNS-Empfehlung: <code className="bg-surface-2 px-1 rounded">_jmap._tcp.{current.publicHostname.split('.').slice(-2).join('.')} SRV 0 1 {current.useHttps ? 443 : (portValid ? current.httpPort : 80)} {current.publicHostname}</code>
                </p>
              </div>

              {/* Save */}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={handleSave}
                  disabled={saveMutation.isPending || !formValid}
                  className="btn-primary flex items-center gap-2 disabled:opacity-50"
                >
                  {saveMutation.isPending
                    ? <Loader2 size={16} className="animate-spin" />
                    : <Save size={16} />}
                  Einstellungen speichern
                </button>
                {saved && (
                  <div role="status" className="flex items-center gap-1.5 text-success-fg text-sm">
                    <CheckCircle size={16} />
                    Gespeichert — die Dienste übernehmen die Änderung sofort
                  </div>
                )}
                {saveMutation.isError && (
                  <p role="alert" className="text-danger-fg text-sm">
                    Fehler beim Speichern: {errorMessage(saveMutation.error)}
                  </p>
                )}
              </div>
            </WriteGuard>
          )}
        </div>
      )}

      {/* ── Tab: Health & Status ─────────────────────────────────────────────── */}
      {tab === 'health' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-fg-subtle">
              {health.data ? `Geprüft: ${new Date(health.data.checkedAt).toLocaleTimeString('de-DE')} — Verbindungstest auf die Dienst-Ports` : 'Verbindungstest auf die Dienst-Ports'}
            </p>
            <button onClick={() => void health.refetch()} disabled={health.isFetching}
              className="btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-50">
              <RefreshCw size={13} className={health.isFetching ? 'animate-spin' : ''} /> Erneut prüfen
            </button>
          </div>
          {health.isLoading ? (
            <div className="flex items-center gap-2 text-fg-subtle"><Loader2 size={16} className="animate-spin" /> Prüfe Dienste…</div>
          ) : health.isError || !health.data ? (
            <div role="alert" className="card flex items-center gap-3 text-danger-fg bg-danger-bg border border-danger-line">
              <AlertCircle size={18} className="shrink-0" />
              <p className="text-sm">Status konnte nicht abgefragt werden: {errorMessage(health.error)}</p>
            </div>
          ) : (
            <>
              <div className="card p-0 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 border-b border-line">
                    <tr>
                      {['Service', 'Ports', 'Beschreibung', 'Status'].map((h) => (
                        <th key={h} className="text-left px-4 py-2.5 font-medium text-fg-subtle text-xs">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {health.data.services.map((s) => (
                      <tr key={s.name} className="hover:bg-surface-2">
                        <td className="px-4 py-2.5 font-mono text-sm text-fg-muted">{s.name}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-fg-subtle">{s.ports}</td>
                        <td className="px-4 py-2.5 text-xs text-fg-muted">{s.description}</td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={s.status} />
                          {s.detail && <p className="text-[11px] text-fg-subtle mt-0.5">{s.detail}</p>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {health.data.dependencies.map((d) => (
                  <div key={d.name} className="card flex items-center gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-fg">{d.name}</p>
                      <StatusBadge status={d.status} />
                      {d.detail && <p className="text-xs text-fg-subtle truncate" title={d.detail}>{d.detail}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {/* 10.4.2: restart the coremail container (independent of the health query) */}
          <div className="max-w-3xl">
            <ServerRestartCard publicHostname={settings?.publicHostname ?? null} />
          </div>
        </div>
      )}
    </div>
  );
}
