import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ShieldAlert, CheckCircle, Trash2, Loader2, Bug, AlertTriangle, FileWarning } from 'lucide-react';
import { api } from '../api/client.js';

interface QuarantineItem {
  id: string; messageId: string | null; fromAddr: string; toAddr: string;
  subject: string; reason: 'VIRUS' | 'SPAM' | 'POLICY';
  released: boolean; releasedAt: string | null; releasedBy: string | null; createdAt: string;
}
interface Stats { total: number; virus: number; spam: number; policy: number; released: number; pending: number }

function ReasonBadge({ reason }: { reason: string }) {
  if (reason === 'VIRUS')  return <span className="badge badge-red flex items-center gap-1"><Bug size={10} /> Virus</span>;
  if (reason === 'SPAM')   return <span className="badge badge-yellow flex items-center gap-1"><AlertTriangle size={10} /> Spam</span>;
  return <span className="badge badge-blue flex items-center gap-1"><FileWarning size={10} /> Richtlinie</span>;
}

export function QuarantinePage() {
  const qc = useQueryClient();
  const [reason, setReason]   = useState('');
  const [released, setReleased] = useState('false');
  const [page, setPage]       = useState(1);
  const [limit] = useState(50);

  const { data: stats } = useQuery<Stats>({
    queryKey: ['quarantine-stats'],
    queryFn: () => api.get<Stats>('/api/v1/admin/quarantine/stats'),
    refetchInterval: 30_000,
  });

  const { data, isLoading } = useQuery<{ items: QuarantineItem[]; total: number }>({
    queryKey: ['quarantine', reason, released, page, limit],
    queryFn: () => api.get(`/api/v1/admin/quarantine?reason=${reason}&released=${released}&page=${page}&limit=${limit}`),
  });

  const releaseMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/admin/quarantine/${id}/release`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['quarantine'] }); void qc.invalidateQueries({ queryKey: ['quarantine-stats'] }); toast.success('Freigegeben'); },
    onError: () => toast.error('Fehler bei Freigabe'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/quarantine/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['quarantine'] }); void qc.invalidateQueries({ queryKey: ['quarantine-stats'] }); toast.success('Gelöscht'); },
    onError: () => toast.error('Löschen fehlgeschlagen'),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <ShieldAlert size={22} className="text-amber-500" />
        <div>
          <h1 className="text-xl font-bold text-gray-900">Quarantäne</h1>
          <p className="text-sm text-gray-500">{stats?.pending ?? 0} ausstehend</p>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          {[
            { label: 'Gesamt', value: stats.total, color: 'text-gray-700' },
            { label: 'Virus', value: stats.virus, color: 'text-red-600' },
            { label: 'Spam', value: stats.spam, color: 'text-amber-600' },
            { label: 'Richtlinie', value: stats.policy, color: 'text-blue-600' },
          ].map(s => (
            <div key={s.label} className="bg-white rounded-lg border border-gray-200 p-4">
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Filter Bar */}
        <div className="flex gap-3 p-3 border-b border-gray-200">
          <select value={reason} onChange={e => { setReason(e.target.value); setPage(1); }} className="input w-40">
            <option value="">Alle Gründe</option>
            <option value="VIRUS">Virus</option>
            <option value="SPAM">Spam</option>
            <option value="POLICY">Richtlinie</option>
          </select>
          <select value={released} onChange={e => { setReleased(e.target.value); setPage(1); }} className="input w-44">
            <option value="false">Ausstehend</option>
            <option value="true">Freigegeben</option>
            <option value="">Alle</option>
          </select>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" /> Lade…
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">Keine Einträge gefunden</div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Von / An</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Betreff</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Grund</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Datum</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map(item => (
                <tr key={item.id} className={`hover:bg-gray-50 transition-colors ${item.released ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3">
                    <p className="text-sm text-gray-900">{item.fromAddr}</p>
                    <p className="text-xs text-gray-400">→ {item.toAddr}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-gray-700 truncate max-w-[200px]">{item.subject || '(kein Betreff)'}</p>
                  </td>
                  <td className="px-4 py-3"><ReasonBadge reason={item.reason} /></td>
                  <td className="px-4 py-3">
                    <p className="text-xs text-gray-500">{new Date(item.createdAt).toLocaleString('de-DE')}</p>
                    {item.released && <p className="text-xs text-green-600">Freigegeben</p>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {!item.released && item.reason !== 'VIRUS' && (
                        <button onClick={() => releaseMutation.mutate(item.id)}
                          title="Freigeben"
                          className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors">
                          <CheckCircle size={14} />
                        </button>
                      )}
                      <button onClick={() => { if (window.confirm('Eintrag endgültig löschen?')) deleteMutation.mutate(item.id); }}
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

        {pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 text-sm text-gray-500">
            <span>{total} Einträge</span>
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
