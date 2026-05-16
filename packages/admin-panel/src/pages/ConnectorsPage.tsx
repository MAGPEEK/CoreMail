import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Cable, Plus, Trash2, Pencil, X, Loader2, ToggleLeft, ToggleRight, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { api } from '../api/client.js';

type ConnType = 'SEND' | 'RECEIVE';
interface Connector {
  id: string; name: string; description: string; type: ConnType; enabled: boolean;
  host: string; port: number; tls: boolean; requireTls: boolean;
  sourceIps: string[]; targetDomains: string[]; priority: number;
  username: string | null; createdAt: string;
}

export function ConnectorsPage() {
  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<'' | ConnType>('');
  const [editItem, setEditItem]     = useState<Connector | null>(null);
  const [createType, setCreateType] = useState<ConnType | null>(null);

  const { data: connectors = [], isLoading } = useQuery<Connector[]>({
    queryKey: ['admin-connectors', typeFilter],
    queryFn: () => api.get<Connector[]>(`/api/v1/admin/connectors?type=${typeFilter}`),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/api/v1/admin/connectors/${id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-connectors'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/connectors/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-connectors'] }); toast.success('Gelöscht'); },
    onError: () => toast.error('Löschen fehlgeschlagen'),
  });

  const send    = connectors.filter(c => c.type === 'SEND');
  const receive = connectors.filter(c => c.type === 'RECEIVE');

  function ConnectorTable({ items, type }: { items: Connector[]; type: ConnType }) {
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
          <button onClick={() => setCreateType(type)}
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
                {items.sort((a, b) => a.priority - b.priority).map(c => (
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
                        <button onClick={() => setEditItem(c)} title="Bearbeiten"
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

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Cable size={22} className="text-blue-600" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">Connectors</h1>
            <p className="text-sm text-gray-500">Sende- und Empfangsconnectors</p>
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
          {(typeFilter === '' || typeFilter === 'SEND')    && <ConnectorTable items={send}    type="SEND" />}
          {(typeFilter === '' || typeFilter === 'RECEIVE') && <ConnectorTable items={receive} type="RECEIVE" />}
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

function ConnectorModal({ type, connector, onClose }: { type: ConnType; connector?: Connector; onClose: () => void }) {
  const qc = useQueryClient();
  const isSend = type === 'SEND';
  const [name, setName]           = useState(connector?.name ?? '');
  const [description, setDesc]    = useState(connector?.description ?? '');
  const [host, setHost]           = useState(connector?.host ?? '');
  const [port, setPort]           = useState(connector?.port ?? (isSend ? 25 : 25));
  const [tls, setTls]             = useState(connector?.tls ?? false);
  const [requireTls, setReqTls]   = useState(connector?.requireTls ?? false);
  const [priority, setPriority]   = useState(connector?.priority ?? 0);
  const [sourceIps, setSourceIps] = useState(connector?.sourceIps.join('\n') ?? '');
  const [targetDomains, setTgtDom] = useState(connector?.targetDomains.join('\n') ?? '');
  const [username, setUsername]   = useState(connector?.username ?? '');
  const [password, setPassword]   = useState('');

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
