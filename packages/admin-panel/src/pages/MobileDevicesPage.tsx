import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Smartphone, Trash2, WifiOff, Loader2, ShieldOff } from 'lucide-react';
import { api } from '../api/client.js';

interface Device {
  id: string; deviceId: string; deviceType: string; deviceFriendlyName: string;
  policyKey: string; status: 'OK' | 'PENDING' | 'BLOCKED' | 'WIPED';
  lastSyncAt: string | null; remoteWipeAt: string | null; createdAt: string;
  user: { id: string; email: string; displayName: string };
}

function StatusBadge({ status }: { status: string }) {
  const base = 'px-2 py-0.5 rounded text-xs font-medium';
  if (status === 'OK')      return <span className={`${base} bg-green-100 text-green-700`}>OK</span>;
  if (status === 'PENDING') return <span className={`${base} bg-yellow-100 text-yellow-700`}>Ausstehend</span>;
  if (status === 'BLOCKED') return <span className={`${base} bg-red-100 text-red-700`}>Gesperrt</span>;
  if (status === 'WIPED')   return <span className={`${base} bg-gray-100 text-gray-500`}>Gelöscht</span>;
  return <span className={`${base} bg-gray-100 text-gray-600`}>{status}</span>;
}

export function MobileDevicesPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch]             = useState('');
  const [page, setPage]                 = useState(1);
  const [limit] = useState(50);

  const { data, isLoading } = useQuery<{ items: Device[]; total: number }>({
    queryKey: ['admin-mobile-devices', statusFilter, search, page, limit],
    queryFn: () => api.get(`/api/v1/admin/mobile/devices?status=${statusFilter}&search=${encodeURIComponent(search)}&page=${page}&limit=${limit}`),
    refetchInterval: 30_000,
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/api/v1/admin/mobile/devices/${id}/status`, { status }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-mobile-devices'] }); toast.success('Status aktualisiert'); },
    onError: () => toast.error('Fehler'),
  });

  const wipeMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/admin/mobile/devices/${id}/wipe`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-mobile-devices'] }); toast.success('Remote Wipe angefordert'); },
    onError: () => toast.error('Fehler'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/mobile/devices/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-mobile-devices'] }); toast.success('Gerät entfernt'); },
    onError: () => toast.error('Fehler'),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <Smartphone size={22} className="text-blue-600" />
        <div>
          <h1 className="text-xl font-bold text-gray-900">Mobile Geräte</h1>
          <p className="text-sm text-gray-500">{total} Gerät{total !== 1 ? 'e' : ''} registriert</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex gap-3 p-3 border-b border-gray-200">
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Gerät oder Benutzer suchen…" className="input max-w-xs" />
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }} className="input w-44">
            <option value="">Alle Status</option>
            <option value="OK">OK</option>
            <option value="PENDING">Ausstehend</option>
            <option value="BLOCKED">Gesperrt</option>
            <option value="WIPED">Gelöscht</option>
          </select>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" /> Lade…
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">
            <Smartphone size={28} className="mx-auto mb-2 opacity-30" />
            Keine Geräte gefunden
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Gerät</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Benutzer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Letzter Sync</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map(device => (
                <tr key={device.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Smartphone size={16} className="text-gray-400 shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {device.deviceFriendlyName || device.deviceType || 'Unbekanntes Gerät'}
                        </p>
                        <p className="text-xs text-gray-400 font-mono">{device.deviceId.slice(0, 16)}…</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-gray-900">{device.user.displayName}</p>
                    <p className="text-xs text-gray-400">{device.user.email}</p>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={device.status} /></td>
                  <td className="px-4 py-3">
                    <p className="text-xs text-gray-500">
                      {device.lastSyncAt ? new Date(device.lastSyncAt).toLocaleString('de-DE') : '–'}
                    </p>
                    {device.remoteWipeAt && (
                      <p className="text-xs text-red-500">Wipe: {new Date(device.remoteWipeAt).toLocaleDateString('de-DE')}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {device.status !== 'BLOCKED' && device.status !== 'WIPED' && (
                        <button onClick={() => statusMutation.mutate({ id: device.id, status: 'BLOCKED' })}
                          title="Sperren"
                          className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors">
                          <ShieldOff size={14} />
                        </button>
                      )}
                      {device.status === 'BLOCKED' && (
                        <button onClick={() => statusMutation.mutate({ id: device.id, status: 'OK' })}
                          title="Entsperren"
                          className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors text-xs font-medium px-2">
                          OK
                        </button>
                      )}
                      {device.status !== 'WIPED' && (
                        <button
                          onClick={() => { if (window.confirm(`Remote Wipe für "${device.deviceFriendlyName || device.deviceId}" anfordern? Dies löscht alle Daten auf dem Gerät!`)) wipeMutation.mutate(device.id); }}
                          title="Remote Wipe"
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors">
                          <WifiOff size={14} />
                        </button>
                      )}
                      <button onClick={() => { if (window.confirm('Gerät deregistrieren?')) deleteMutation.mutate(device.id); }}
                        title="Entfernen"
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

        {pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 text-sm text-gray-500">
            <span>{total} Geräte</span>
            <div className="flex gap-1">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                className="px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">‹</button>
              <span className="px-3 py-1">Seite {page} / {pages}</span>
              <button onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page === pages}
                className="px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">›</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
