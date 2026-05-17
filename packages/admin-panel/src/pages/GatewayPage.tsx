import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Network, Save, Plug, CheckCircle2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GatewaySettings {
  enabled: boolean;
  upstreamHost: string;
  upstreamPort: number;
  upstreamTls: boolean;
  upstreamUsername: string | null;
  upstreamPassword: string | null;
  relayDomains: string[];
  filterBeforeRelay: boolean;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function GatewayPage() {
  const qc = useQueryClient();
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [form, setForm] = useState<{
    enabled: boolean;
    upstreamHost: string;
    upstreamPort: string;
    upstreamTls: boolean;
    upstreamUsername: string;
    upstreamPassword: string;
    relayDomains: string;
    filterBeforeRelay: boolean;
  }>({
    enabled: false,
    upstreamHost: '',
    upstreamPort: '25',
    upstreamTls: false,
    upstreamUsername: '',
    upstreamPassword: '',
    relayDomains: '',
    filterBeforeRelay: true,
  });

  const { data: settings, isLoading } = useQuery<GatewaySettings>({
    queryKey: ['admin-gateway-settings'],
    queryFn: () => api.get('/admin/gateway/settings'),
  });

  useEffect(() => {
    if (!settings) return;
    setForm({
      enabled: settings.enabled,
      upstreamHost: settings.upstreamHost,
      upstreamPort: settings.upstreamPort.toString(),
      upstreamTls: settings.upstreamTls,
      upstreamUsername: settings.upstreamUsername ?? '',
      upstreamPassword: '',  // never pre-fill password
      relayDomains: settings.relayDomains.join('\n'),
      filterBeforeRelay: settings.filterBeforeRelay,
    });
  }, [settings]);

  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm(f => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => api.put('/admin/gateway/settings', {
      enabled: form.enabled,
      upstreamHost: form.upstreamHost,
      upstreamPort: parseInt(form.upstreamPort),
      upstreamTls: form.upstreamTls,
      ...(form.upstreamUsername ? { upstreamUsername: form.upstreamUsername } : { upstreamUsername: null }),
      ...(form.upstreamPassword ? { upstreamPassword: form.upstreamPassword } : {}),
      relayDomains: form.relayDomains.split('\n').map(s => s.trim()).filter(Boolean),
      filterBeforeRelay: form.filterBeforeRelay,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-gateway-settings'] });
      toast.success('Gateway-Einstellungen gespeichert');
      setForm(f => ({ ...f, upstreamPassword: '' }));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const test = useMutation({
    mutationFn: () => api.post('/admin/gateway/test', {
      upstreamHost: form.upstreamHost,
      upstreamPort: parseInt(form.upstreamPort),
      upstreamTls: form.upstreamTls,
      ...(form.upstreamUsername ? { upstreamUsername: form.upstreamUsername } : {}),
      ...(form.upstreamPassword ? { upstreamPassword: form.upstreamPassword } : {}),
    }),
    onSuccess: (res: unknown) => {
      const r = res as { ok: boolean; message: string };
      setTestResult(r);
    },
    onError: (e: Error) => setTestResult({ ok: false, message: e.message }),
  });

  if (isLoading) return <div className="p-6 text-gray-400">Laden…</div>;

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <Network size={22} className="text-accent" />
        <div>
          <h1 className="text-xl font-semibold text-gray-900">SMTP-Gateway-Modus</h1>
          <p className="text-sm text-gray-500">Ausgehende Mails über einen vorgelagerten SMTP-Relay-Server senden</p>
        </div>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* Enable toggle */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">Gateway-Modus aktivieren</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Alle ausgehenden Mails werden über den unten konfigurierten SMTP-Relay geleitet
              </p>
            </div>
            <Toggle active={form.enabled} onToggle={() => set('enabled', !form.enabled)} />
          </div>
        </div>

        {/* Upstream SMTP */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Upstream SMTP-Server</h2>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">Hostname / IP *</label>
              <input value={form.upstreamHost} onChange={e => set('upstreamHost', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="smtp.relay.example.com" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Port</label>
              <input type="number" min="1" max="65535" value={form.upstreamPort} onChange={e => set('upstreamPort', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.upstreamTls} onChange={e => set('upstreamTls', e.target.checked)}
              className="accent-accent" />
            <span className="text-sm text-gray-700">TLS/STARTTLS verwenden</span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Benutzername (optional)</label>
              <input value={form.upstreamUsername} onChange={e => set('upstreamUsername', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="relay-user" autoComplete="off" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Passwort {settings?.upstreamPassword && <span className="text-gray-400">(leer = unverändert)</span>}
              </label>
              <input type="password" value={form.upstreamPassword} onChange={e => set('upstreamPassword', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder={settings?.upstreamPassword ? '••••••••' : ''} autoComplete="new-password" />
            </div>
          </div>

          {/* Test button */}
          <div className="flex items-center gap-3 pt-1">
            <button onClick={() => { setTestResult(null); test.mutate(); }} disabled={!form.upstreamHost || test.isPending}
              className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50">
              <Plug size={14} /> {test.isPending ? 'Teste…' : 'Verbindung testen'}
            </button>
            {testResult && (
              <div className={`flex items-center gap-1.5 text-sm ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>
                {testResult.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                {testResult.message}
              </div>
            )}
          </div>
        </div>

        {/* Relay Domains */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Relay-Domains</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Nur Mails an diese Domains werden über den Gateway geleitet (leer = alle Domains)
            </p>
          </div>
          <textarea value={form.relayDomains} onChange={e => set('relayDomains', e.target.value)}
            rows={4} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent resize-none"
            placeholder="partner-firma.com&#10;extern.de" />
        </div>

        {/* Filter Option */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={form.filterBeforeRelay} onChange={e => set('filterBeforeRelay', e.target.checked)}
              className="accent-accent mt-0.5" />
            <div>
              <p className="text-sm font-medium text-gray-900">Spam-/Virenfilter vor Weiterleitung anwenden</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Eingehende Mails werden zuerst durch rspamd/ClamAV gefiltert bevor sie weitergeleitet werden
              </p>
            </div>
          </label>
        </div>

        {/* Save Button */}
        <div className="flex justify-end">
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="flex items-center gap-2 px-5 py-2.5 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            <Save size={15} /> {save.isPending ? 'Speichern…' : 'Einstellungen speichern'}
          </button>
        </div>
      </div>
    </div>
  );
}
