import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Cable, Plus, Trash2, Pencil, X, Loader2, ToggleLeft, ToggleRight,
  ArrowUpRight, ArrowDownLeft, LayoutGrid, Mail, Inbox, Archive, Lock,
} from 'lucide-react';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';

// ── Typen — Connectors ────────────────────────────────────────────────────────
type ConnType = 'SEND' | 'RECEIVE';

interface Connector {
  id: string; name: string; description: string; type: ConnType; enabled: boolean;
  host: string; port: number; tls: boolean; requireTls: boolean;
  sourceIps: string[]; targetDomains: string[]; priority: number;
  username: string | null; createdAt: string;
}

// ── Typen — Services ──────────────────────────────────────────────────────────
type ServiceKey = 'SMTP_RECEIVE' | 'IMAP' | 'POP3';

interface ServiceListener {
  id: string; service: ServiceKey; address: string; port: number;
  ssl: boolean; active: boolean; createdAt: string;
}

interface OverviewEntry { total: number; active: number }
type ServicesOverview = Record<ServiceKey, OverviewEntry>;

// ── Sub-Navigation ────────────────────────────────────────────────────────────
type NavView =
  | 'conn-all' | 'conn-send' | 'conn-receive'
  | 'svc-overview' | 'SMTP_RECEIVE' | 'IMAP' | 'POP3';

const SVC_SLUG: Record<ServiceKey, string> = {
  SMTP_RECEIVE: 'smtp-receive',
  IMAP:         'imap',
  POP3:         'pop3',
};


// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTORS
// ═══════════════════════════════════════════════════════════════════════════════

function ConnectorTable({
  items, type, onEdit, onAdd,
}: {
  items: Connector[]; type: ConnType;
  onEdit: (c: Connector) => void;
  onAdd: (t: ConnType) => void;
}) {
  const qc = useQueryClient();

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/api/v1/admin/connectors/${id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-connectors'] }),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/connectors/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-connectors'] }); toast.success('Gelöscht'); },
    onError: () => toast.error('Löschen fehlgeschlagen'),
  });

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {type === 'SEND'
            ? <ArrowUpRight size={16} className="text-blue-500" />
            : <ArrowDownLeft size={16} className="text-green-500" />}
          <h2 className="font-semibold text-gray-800">{type === 'SEND' ? 'Sendeconnectors' : 'Empfangsconnectors'}</h2>
          <span className="text-xs text-gray-400">({items.length})</span>
        </div>
        <button onClick={() => onAdd(type)}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
          <Plus size={12} /> Neuer {type === 'SEND' ? 'Sendeconnector' : 'Empfangsconnector'}
        </button>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {items.length === 0 ? (
          <p className="text-center py-8 text-sm text-gray-400">Keine {type === 'SEND' ? 'Sende' : 'Empfangs'}connectoren</p>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Priorität</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">{type === 'SEND' ? 'Ziel-Host' : 'Quell-IPs'}</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Domains</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">TLS</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {[...items].sort((a, b) => a.priority - b.priority).map(c => (
                <tr key={c.id} className={`hover:bg-gray-50 transition-colors ${!c.enabled ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3 text-xs font-mono text-gray-500">{c.priority}</td>
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-gray-900">{c.name}</p>
                    {c.description && <p className="text-xs text-gray-400">{c.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {type === 'SEND'
                      ? `${c.host}:${c.port}`
                      : c.sourceIps.length ? c.sourceIps.slice(0, 2).join(', ') + (c.sourceIps.length > 2 ? ` +${c.sourceIps.length - 2}` : '') : 'Alle'
                    }
                  </td>
                  <td className="px-4 py-3">
                    {c.targetDomains.length === 0
                      ? <span className="text-xs text-gray-400">Alle</span>
                      : <span className="text-xs text-gray-700">{c.targetDomains.slice(0, 2).join(', ')}{c.targetDomains.length > 2 ? ` +${c.targetDomains.length - 2}` : ''}</span>
                    }
                  </td>
                  <td className="px-4 py-3">
                    {c.tls
                      ? <span className="badge badge-green text-xs">TLS</span>
                      : <span className="badge badge-gray text-xs">Kein TLS</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => toggleMutation.mutate(c.id)} title={c.enabled ? 'Deaktivieren' : 'Aktivieren'}
                        className={`p-1.5 rounded transition-colors ${c.enabled ? 'text-green-500 hover:text-green-700' : 'text-gray-400 hover:text-gray-600'}`}>
                        {c.enabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                      </button>
                      <button onClick={() => onEdit(c)} title="Bearbeiten"
                        className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => { if (window.confirm(`"${c.name}" löschen?`)) deleteMutation.mutate(c.id); }}
                        title="Löschen"
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ConnectorModal({ type, connector, onClose }: { type: ConnType; connector?: Connector; onClose: () => void }) {
  const qc = useQueryClient();
  const isSend = type === 'SEND';
  const [name, setName]             = useState(connector?.name ?? '');
  const [description, setDesc]      = useState(connector?.description ?? '');
  const [host, setHost]             = useState(connector?.host ?? '');
  const [port, setPort]             = useState(connector?.port ?? 25);
  const [tls, setTls]               = useState(connector?.tls ?? false);
  const [requireTls, setReqTls]     = useState(connector?.requireTls ?? false);
  const [priority, setPriority]     = useState(connector?.priority ?? 0);
  const [sourceIps, setSourceIps]   = useState(connector?.sourceIps.join('\n') ?? '');
  const [targetDomains, setTgtDom]  = useState(connector?.targetDomains.join('\n') ?? '');
  const [username, setUsername]     = useState(connector?.username ?? '');
  const [password, setPassword]     = useState('');

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        name, description, type, host, port, tls, requireTls, priority,
        sourceIps: sourceIps.split('\n').map(s => s.trim()).filter(Boolean),
        targetDomains: targetDomains.split('\n').map(s => s.trim()).filter(Boolean),
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
      };
      return connector
        ? api.put(`/api/v1/admin/connectors/${connector.id}`, body)
        : api.post('/api/v1/admin/connectors', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-connectors'] });
      toast.success(connector ? 'Gespeichert' : 'Erstellt');
      onClose();
    },
    onError: () => toast.error('Fehler'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white">
          <h2 className="font-semibold text-gray-900">
            {connector ? 'Connector bearbeiten' : `Neuer ${isSend ? 'Sende' : 'Empfangs'}connector`}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div><label className="field-label">Name</label><input value={name} onChange={e => setName(e.target.value)} className="input" /></div>
          <div><label className="field-label">Beschreibung</label><input value={description} onChange={e => setDesc(e.target.value)} className="input" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="field-label">Priorität</label><input type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} className="input" min={0} max={9999} /></div>
          </div>
          {isSend && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2"><label className="field-label">Ziel-Host</label><input value={host} onChange={e => setHost(e.target.value)} className="input" placeholder="smtp.relay.com" /></div>
                <div><label className="field-label">Port</label><input type="number" value={port} onChange={e => setPort(Number(e.target.value))} className="input" min={1} max={65535} /></div>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none"><input type="checkbox" checked={tls} onChange={e => setTls(e.target.checked)} className="rounded" />TLS</label>
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none"><input type="checkbox" checked={requireTls} onChange={e => setReqTls(e.target.checked)} className="rounded" />TLS erzwingen</label>
              </div>
              <div><label className="field-label">Benutzername (optional)</label><input value={username} onChange={e => setUsername(e.target.value)} className="input" /></div>
              <div><label className="field-label">Passwort (optional, leer = unverändert)</label><input type="password" value={password} onChange={e => setPassword(e.target.value)} className="input" /></div>
              <div><label className="field-label">Ziel-Domains (eine pro Zeile, leer = Fallback für alle)</label><textarea value={targetDomains} onChange={e => setTgtDom(e.target.value)} rows={3} className="input font-mono text-sm" placeholder="external-domain.com" /></div>
            </>
          )}
          {!isSend && (
            <div><label className="field-label">Erlaubte Quell-IPs/CIDR (eine pro Zeile, leer = alle)</label><textarea value={sourceIps} onChange={e => setSourceIps(e.target.value)} rows={4} className="input font-mono text-sm" placeholder={"10.0.0.0/8\n192.168.1.100"} /></div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="btn-secondary">Abbrechen</button>
            <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name}
              className="btn-primary flex items-center gap-1.5">
              {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {connector ? 'Speichern' : 'Erstellen'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectorsView() {
  const [typeFilter, setTypeFilter] = useState<'' | ConnType>('');
  const [editItem, setEditItem]     = useState<Connector | null>(null);
  const [createType, setCreateType] = useState<ConnType | null>(null);

  const { data: connectors = [], isLoading } = useQuery<Connector[]>({
    queryKey: ['admin-connectors', typeFilter],
    queryFn: () => api.get<Connector[]>(`/api/v1/admin/connectors?type=${typeFilter}`),
  });

  const send    = connectors.filter(c => c.type === 'SEND');
  const receive = connectors.filter(c => c.type === 'RECEIVE');

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Cable size={20} className="text-blue-600" />
          <div>
            <h1 className="text-lg font-bold text-gray-900">Connectors</h1>
            <p className="text-sm text-gray-500">Sende- und Empfangsconnectors für den Mailfluss</p>
          </div>
        </div>
        <div className="flex gap-2">
          {(['', 'SEND', 'RECEIVE'] as const).map(t => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${typeFilter === t ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
              {t === '' ? 'Alle' : t === 'SEND' ? 'Senden' : 'Empfangen'}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 size={20} className="animate-spin mr-2" /> Lade…
        </div>
      ) : (
        <>
          {(typeFilter === '' || typeFilter === 'SEND') && (
            <ConnectorTable items={send} type="SEND" onEdit={setEditItem} onAdd={setCreateType} />
          )}
          {(typeFilter === '' || typeFilter === 'RECEIVE') && (
            <ConnectorTable items={receive} type="RECEIVE" onEdit={setEditItem} onAdd={setCreateType} />
          )}
        </>
      )}

      {(createType || editItem) && (
        <ConnectorModal
          type={editItem?.type ?? createType!}
          connector={editItem ?? undefined}
          onClose={() => { setEditItem(null); setCreateType(null); }}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICES / LISTENER
// ═══════════════════════════════════════════════════════════════════════════════

interface ListenerFormData { address: string; port: string; ssl: boolean; active: boolean }

function ListenerModal({ initial, onSave, onClose }: {
  initial?: Partial<ListenerFormData>;
  onSave:  (data: ListenerFormData) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ListenerFormData>({
    address: initial?.address ?? '0.0.0.0',
    port:    initial?.port    ?? '',
    ssl:     initial?.ssl     ?? false,
    active:  initial?.active  ?? true,
  });
  const handle = (field: keyof ListenerFormData, val: string | boolean) =>
    setForm(f => ({ ...f, [field]: val }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <h3 className="text-base font-semibold text-gray-800 mb-4">
          {initial ? 'Listener bearbeiten' : 'Listener hinzufügen'}
        </h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">IP-Adresse</label>
            <input type="text" value={form.address} onChange={e => handle('address', e.target.value)}
              placeholder="0.0.0.0" className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Port</label>
            <input type="number" value={form.port} onChange={e => handle('port', e.target.value)}
              placeholder="25" min={1} max={65535}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-gray-600">SSL/TLS</span>
            <Toggle active={form.ssl} onToggle={() => handle('ssl', !form.ssl)} />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-gray-600">Aktiv</span>
            <Toggle active={form.active} onToggle={() => handle('active', !form.active)} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors">Abbrechen</button>
          <button onClick={() => {
            if (!form.port || isNaN(Number(form.port))) { toast.error('Bitte einen gültigen Port eingeben'); return; }
            onSave(form);
          }} className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors">Speichern</button>
        </div>
      </div>
    </div>
  );
}

function ListenersTable({ svcKey, svcSlug }: { svcKey: ServiceKey; svcSlug: string }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState<'add' | string | null>(null);

  const { data: listeners = [], isLoading } = useQuery<ServiceListener[]>({
    queryKey: ['service-listeners', svcKey],
    queryFn:  () => api.get<ServiceListener[]>(`/admin/services/listeners/${svcSlug}`),
  });

  const editingListener = modal && modal !== 'add' ? listeners.find(l => l.id === modal) : null;

  const addMutation = useMutation({
    mutationFn: (data: ListenerFormData) =>
      api.post(`/admin/services/listeners/${svcSlug}`, { address: data.address, port: Number(data.port), ssl: data.ssl, active: data.active }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }); void qc.invalidateQueries({ queryKey: ['services-overview'] }); setModal(null); toast.success('Listener hinzugefügt'); },
    onError:   () => toast.error('Fehler beim Hinzufügen'),
  });

  const editMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ListenerFormData }) =>
      api.put(`/admin/services/listeners/${id}`, { address: data.address, port: Number(data.port), ssl: data.ssl, active: data.active }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }); setModal(null); toast.success('Listener aktualisiert'); },
    onError:   () => toast.error('Fehler beim Aktualisieren'),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/services/listeners/${id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }),
    onError:   () => toast.error('Fehler beim Umschalten'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/services/listeners/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }); void qc.invalidateQueries({ queryKey: ['services-overview'] }); toast.success('Listener gelöscht'); },
    onError:   () => toast.error('Fehler beim Löschen'),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-semibold text-gray-900">Listeners</h2>
        <button onClick={() => setModal('add')}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors">
          <Plus size={14} /> Listener hinzufügen
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16 text-gray-400 text-sm">Lade…</div>
      ) : listeners.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-gray-400">
          <p className="text-sm">Keine Listener konfiguriert</p>
          <button onClick={() => setModal('add')} className="mt-3 text-blue-600 text-sm hover:underline">Ersten Listener hinzufügen</button>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-12">#</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Address:Port</th>
                <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {listeners.map((l, i) => (
                <tr key={l.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 text-gray-500 font-mono text-xs">{i + 1}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium text-gray-800">{l.address}:{l.port}</span>
                      {l.ssl && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200">
                          <Lock size={10} /> SSL
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Toggle active={l.active} onToggle={() => toggleMutation.mutate(l.id)} />
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => setModal(l.id)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors border border-gray-200" title="Bearbeiten">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => { if (confirm(`Listener ${l.address}:${l.port} wirklich löschen?`)) deleteMutation.mutate(l.id); }}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors border border-gray-200" title="Löschen">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal === 'add' && <ListenerModal onSave={data => addMutation.mutate(data)} onClose={() => setModal(null)} />}
      {modal && modal !== 'add' && editingListener && (
        <ListenerModal
          initial={{ address: editingListener.address, port: String(editingListener.port), ssl: editingListener.ssl, active: editingListener.active }}
          onSave={data => editMutation.mutate({ id: modal, data })}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function ServicesOverview({ onSelect }: { onSelect: (key: ServiceKey) => void }) {
  const { data: overview, isLoading } = useQuery<ServicesOverview>({
    queryKey: ['services-overview'],
    queryFn:  () => api.get<ServicesOverview>('/admin/services/overview'),
  });

  const CARDS: { key: ServiceKey; label: string; icon: React.ElementType; ports: string }[] = [
    { key: 'SMTP_RECEIVE', label: 'SMTP Inbound',  icon: Inbox,   ports: '25 · 465 · 587' },
    { key: 'IMAP',         label: 'IMAP',           icon: Mail,    ports: '143 · 993'       },
    { key: 'POP3',         label: 'POP3',           icon: Archive, ports: '110 · 995'       },
  ];

  return (
    <div className="p-6">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-900">Services Management</h2>
        <p className="text-sm text-gray-500 mt-0.5">Übersicht aller konfigurierten Protokoll-Services und Listener</p>
      </div>
      {isLoading ? (
        <div className="flex justify-center py-16 text-gray-400 text-sm">Lade…</div>
      ) : (
        <div className="grid grid-cols-3 gap-4 max-w-2xl">
          {CARDS.map(({ key, label, icon: Icon, ports }) => {
            const entry = overview?.[key] ?? { total: 0, active: 0 };
            return (
              <button key={key} onClick={() => onSelect(key)}
                className="bg-white border border-gray-200 rounded-lg p-5 text-left hover:border-blue-400 hover:shadow-md transition-all group">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 bg-blue-50 rounded-lg group-hover:bg-blue-100 transition-colors">
                    <Icon size={18} className="text-blue-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{label}</p>
                    <p className="text-xs text-gray-400">{ports}</p>
                  </div>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-gray-900">{entry.active}</span>
                  <span className="text-sm text-gray-400">/ {entry.total} Listener</span>
                </div>
                <div className="mt-2">
                  <div className="w-full bg-gray-100 rounded-full h-1.5">
                    <div className="bg-blue-500 h-1.5 rounded-full transition-all"
                      style={{ width: entry.total ? `${(entry.active / entry.total) * 100}%` : '0%' }} />
                  </div>
                </div>
                <p className="text-xs text-blue-600 mt-3 font-medium group-hover:underline">Listener verwalten →</p>
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4 max-w-2xl">
        <p className="text-xs text-blue-700">
          <strong>Hinweis:</strong> Listener-Änderungen werden in der Datenbank gespeichert.
          Die tatsächlich lauschenden Ports werden durch die Dienst-Konfiguration (supervisord / Docker) bestimmt.
        </p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HAUPT-KOMPONENTE
// ═══════════════════════════════════════════════════════════════════════════════

export function ConnectorsPage() {
  const [view, setView] = useState<NavView>('conn-all');

  type NavSection = {
    heading: string;
    items: { key: NavView; label: string; icon: React.ElementType }[];
  };

  const NAV_SECTIONS: NavSection[] = [
    {
      heading: 'Connectors',
      items: [
        { key: 'conn-all',     label: 'Alle Connectors',   icon: Cable          },
        { key: 'conn-send',    label: 'Sendeconnectors',    icon: ArrowUpRight   },
        { key: 'conn-receive', label: 'Empfangsconnectors', icon: ArrowDownLeft  },
      ],
    },
    {
      heading: 'Services',
      items: [
        { key: 'svc-overview',  label: 'Übersicht',     icon: LayoutGrid },
        { key: 'SMTP_RECEIVE',  label: 'SMTP Inbound',  icon: Inbox      },
        { key: 'IMAP',          label: 'IMAP',          icon: Mail       },
        { key: 'POP3',          label: 'POP3',          icon: Archive    },
      ],
    },
  ];

  function renderContent() {
    if (view === 'conn-all')     return <ConnectorsView />;
    if (view === 'conn-send')    return <ConnectorsFilteredView filter="SEND" />;
    if (view === 'conn-receive') return <ConnectorsFilteredView filter="RECEIVE" />;
    if (view === 'svc-overview') return <ServicesOverview onSelect={k => setView(k)} />;
    // ServiceKey views
    return <ListenersTable svcKey={view as ServiceKey} svcSlug={SVC_SLUG[view as ServiceKey]} />;
  }

  return (
    <div className="h-full flex bg-gray-50">
      {/* Sub-Navigation */}
      <aside className="w-48 shrink-0 bg-[#1e2433] text-gray-300 flex flex-col">
        <div className="px-4 py-3 border-b border-white/10">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Nachrichtenfluss</p>
        </div>
        <nav className="flex-1 py-1 overflow-y-auto">
          {NAV_SECTIONS.map(section => (
            <div key={section.heading}>
              <p className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                {section.heading}
              </p>
              {section.items.map(({ key, label, icon: Icon }) => (
                <button key={key} onClick={() => setView(key)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors text-left ${
                    view === key ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-white/10 hover:text-white'
                  }`}>
                  <Icon size={13} />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* Inhalt */}
      <div className="flex-1 overflow-y-auto">
        {renderContent()}
      </div>
    </div>
  );
}

// Gefilterte Connector-Ansicht (nur SEND oder nur RECEIVE)
function ConnectorsFilteredView({ filter }: { filter: ConnType }) {
  const [editItem, setEditItem]     = useState<Connector | null>(null);
  const [createType, setCreateType] = useState<ConnType | null>(null);

  const { data: connectors = [], isLoading } = useQuery<Connector[]>({
    queryKey: ['admin-connectors', filter],
    queryFn: () => api.get<Connector[]>(`/api/v1/admin/connectors?type=${filter}`),
  });

  if (isLoading) return (
    <div className="flex items-center justify-center py-12 text-gray-400 p-6">
      <Loader2 size={20} className="animate-spin mr-2" /> Lade…
    </div>
  );

  return (
    <div className="p-6">
      <ConnectorTable
        items={connectors}
        type={filter}
        onEdit={setEditItem}
        onAdd={setCreateType}
      />
      {(createType || editItem) && (
        <ConnectorModal
          type={editItem?.type ?? createType!}
          connector={editItem ?? undefined}
          onClose={() => { setEditItem(null); setCreateType(null); }}
        />
      )}
    </div>
  );
}
