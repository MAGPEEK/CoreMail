// BCP → SMTP-Konfiguration → Geräte-Relay: unauthenticated relay for internal
// devices (scanners, printers, monitoring) — only from the listed networks, only
// for the listed sender domains, rate-limited. Default: off.
import { useEffect, useId, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Info, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { Toggle } from './Toggle.js';
import { WriteGuard } from './Can.js';
import { errorMessage } from '../lib/errors.js';
import {
  deviceRelayPayload, formatEntryList, type DeviceRelayForm, type DeviceRelayPayload,
} from '../lib/legacyClients.js';

interface DeviceRelayView extends DeviceRelayPayload {
  /** An active SMTP inbound listener serves the configured port. */
  listenerActive: boolean;
}

const toForm = (v: DeviceRelayView): DeviceRelayForm => ({
  enabled: v.enabled,
  networks: formatEntryList(v.allowedNetworks),
  senderDomains: formatEntryList(v.senderDomains),
  port: String(v.port),
  maxMessagesPerMinute: String(v.maxMessagesPerMinute),
});

const inputCls = 'w-full border border-line-strong rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg';

export function DeviceRelaySection() {
  const qc = useQueryClient();
  const ids = { networks: useId(), domains: useId(), port: useId(), rate: useId() };
  const { data } = useQuery<DeviceRelayView>({
    queryKey: ['admin', 'smtp-config', 'device-relay'],
    queryFn:  () => api.get<DeviceRelayView>('/admin/smtp-config/device-relay'),
  });
  const [form, setForm] = useState<DeviceRelayForm | null>(null);
  useEffect(() => { if (data) setForm(toForm(data)); }, [data]);

  const save = useMutation({
    mutationFn: (body: DeviceRelayPayload) => api.put<DeviceRelayView>('/admin/smtp-config/device-relay', body),
    onSuccess: () => {
      toast.success('Geräte-Relay gespeichert');
      void qc.invalidateQueries({ queryKey: ['admin', 'smtp-config', 'device-relay'] });
    },
    onError: (e) => toast.error(errorMessage(e, 'Fehler beim Speichern')),
  });

  if (!data || !form) return <div className="text-sm text-fg-subtle">Lade Geräte-Relay…</div>;
  const set = <K extends keyof DeviceRelayForm>(k: K, v: DeviceRelayForm[K]) => setForm({ ...form, [k]: v });
  const submit = () => {
    const checked = deviceRelayPayload(form);
    if (!checked.ok) { toast.error(checked.error); return; }
    save.mutate(checked.value);
  };

  return (
    <WriteGuard area="servers">
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-fg">Geräte-Relay</h2>
            <p className="text-xs text-fg-subtle mt-0.5">
              Scanner, Drucker und Überwachungssysteme dürfen ohne Anmeldung Mails nach extern senden — nur aus den angegebenen Netzen
            </p>
          </div>
          <button onClick={submit} disabled={save.isPending} className="btn-primary text-sm disabled:opacity-50">
            {save.isPending ? 'Speichern…' : 'Speichern'}
          </button>
        </div>

        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-fg">Geräte-Relay aktiv</p>
              <p className="text-xs text-fg-subtle mt-0.5">Aus = Port 25 nimmt wie bisher nur Mails für eigene Postfächer an</p>
            </div>
            <Toggle active={form.enabled} label="Geräte-Relay aktiv" onToggle={() => set('enabled', !form.enabled)} />
          </div>

          <div>
            <label htmlFor={ids.networks} className="block text-xs font-medium text-fg-muted mb-1">Erlaubte Netze (IP oder CIDR, eines pro Zeile)</label>
            <textarea id={ids.networks} rows={4} value={form.networks} onChange={(e) => set('networks', e.target.value)}
              placeholder={'192.168.10.0/24\n10.0.0.25'} className={inputCls} />
            <p className="text-[11px] text-fg-subtle mt-1">Nur interne Netze eintragen. Netze größer als /8 (IPv4) bzw. /32 (IPv6) werden abgelehnt.</p>
          </div>

          <div>
            <label htmlFor={ids.domains} className="block text-xs font-medium text-fg-muted mb-1">Erlaubte Absender-Domains (eine pro Zeile)</label>
            <textarea id={ids.domains} rows={3} value={form.senderDomains} onChange={(e) => set('senderDomains', e.target.value)}
              placeholder="example.com" className={inputCls} />
            <p className="text-[11px] text-fg-subtle mt-1">Nur Domains dieses Servers. Absender (MAIL FROM) und „Von"-Kopfzeile müssen dazu passen.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor={ids.port} className="block text-xs font-medium text-fg-muted mb-1">Listener-Port</label>
              <input id={ids.port} type="number" min={1} max={65535} value={form.port}
                onChange={(e) => set('port', e.target.value)} className={inputCls} />
              <p className="text-[11px] text-fg-subtle mt-1">25 oder ein eigener Port (nicht 465/587)</p>
            </div>
            <div>
              <label htmlFor={ids.rate} className="block text-xs font-medium text-fg-muted mb-1">Max. Nachrichten pro Minute und Gerät</label>
              <input id={ids.rate} type="number" min={1} max={1000} value={form.maxMessagesPerMinute}
                onChange={(e) => set('maxMessagesPerMinute', e.target.value)} className={inputCls} />
            </div>
          </div>

          {!data.listenerActive && (
            <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-warning-line bg-warning-bg px-3 py-2 text-xs text-warning-fg">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>Auf Port {data.port} läuft kein aktiver SMTP-Listener. Bitte unter Dienste → SMTP Inbound einen Listener für diesen Port anlegen.</span>
            </p>
          )}
        </div>

        <div className="bg-info-bg border border-info-line rounded-lg px-4 py-3 text-xs text-info-fg flex items-start gap-2">
          <Info size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Kein offenes Relay: Clients außerhalb der Netze, andere Absender-Domains und andere Ports erhalten für externe Empfänger
            weiterhin eine Ablehnung. Weitergeleitete Gerätemails durchlaufen Anhangfilter und Virenscan (Einstellungen unter
            Schutzfilter), aber keinen Spam-Filter; jede Weiterleitung wird im Nachrichtenfluss protokolliert, jede Änderung hier im Audit-Log.
          </span>
        </div>
      </div>
    </WriteGuard>
  );
}
