import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Copy, Trash2, X, CheckCircle } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';

interface Domain { id: string; name: string; dkimSelector: string; active: boolean; createdAt: string }
interface DkimRecord { selector: string; dnsName: string; dnsValue: string }

export function DomainsPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [dkimRecord, setDkimRecord] = useState<DkimRecord | null>(null);

  const { data: domains } = useQuery({ queryKey: ['admin-domains'], queryFn: () => api.get<Domain[]>('/admin/domains') });

  const createMutation = useMutation({
    mutationFn: () => api.post<Domain>('/admin/domains', { name }),
    onSuccess: () => { toast.success('Domain erstellt'); qc.invalidateQueries({ queryKey: ['admin-domains'] }); setShowCreate(false); setName(''); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/domains/${id}`),
    onSuccess: () => { toast.success('Domain gelöscht'); qc.invalidateQueries({ queryKey: ['admin-domains'] }); },
    onError: (err: Error) => toast.error(err.message),
  });

  const fetchDkim = async (id: string) => {
    try { setDkimRecord(await api.get<DkimRecord>(`/admin/domains/${id}/dkim-record`)); }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Fehler'); }
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Domains</h1>
        <button onClick={() => setShowCreate(true)} className="btn-primary"><Plus size={15} /> Domain hinzufügen</button>
      </div>

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['Domain', 'DKIM-Selektor', 'Status', ''].map((h) => (
                <th key={h} className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(domains ?? []).map((d) => (
              <tr key={d.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-2.5 font-medium text-gray-800">{d.name}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{d.dkimSelector}</td>
                <td className="px-4 py-2.5">
                  <span className={`badge ${d.active ? 'badge-green' : 'badge-red'}`}>
                    {d.active ? 'Aktiv' : 'Inaktiv'}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1">
                    <button onClick={() => fetchDkim(d.id)} className="btn-ghost text-xs p-1" title="DKIM DNS Record anzeigen">
                      <CheckCircle size={13} /> DKIM
                    </button>
                    <button onClick={() => { if (confirm(`${d.name} löschen?`)) deleteMutation.mutate(d.id); }}
                      className="btn-ghost p-1 text-xs text-red-500 hover:bg-red-50">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(domains ?? []).length === 0 && <div className="py-8 text-center text-gray-400 text-sm">Keine Domains konfiguriert</div>}
      </div>

      {/* DKIM record modal */}
      {dkimRecord && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-2xl w-full max-w-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">DKIM DNS-Eintrag</h2>
              <button onClick={() => setDkimRecord(null)} className="btn-ghost p-1"><X size={16} /></button>
            </div>
            <p className="text-sm text-gray-600 mb-3">Fügen Sie diesen TXT-Eintrag in Ihrem DNS hinzu:</p>
            <div className="space-y-2">
              <div>
                <label className="text-xs font-medium text-gray-500">DNS-Name</label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="flex-1 bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs font-mono break-all">{dkimRecord.dnsName}</code>
                  <button onClick={() => { navigator.clipboard.writeText(dkimRecord.dnsName); toast.success('Kopiert'); }} className="btn-ghost p-1.5"><Copy size={13} /></button>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500">TXT-Wert</label>
                <div className="flex items-start gap-2 mt-1">
                  <code className="flex-1 bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs font-mono break-all">{dkimRecord.dnsValue}</code>
                  <button onClick={() => { navigator.clipboard.writeText(dkimRecord.dnsValue); toast.success('Kopiert'); }} className="btn-ghost p-1.5 mt-0.5"><Copy size={13} /></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create domain dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Domain hinzufügen</h2>
              <button onClick={() => setShowCreate(false)} className="btn-ghost p-1"><X size={16} /></button>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Domain-Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="company.com" />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowCreate(false)} className="btn-secondary">Abbrechen</button>
              <button onClick={() => createMutation.mutate()} disabled={!name || createMutation.isPending} className="btn-primary disabled:opacity-50">
                {createMutation.isPending ? 'Hinzufügen...' : 'Hinzufügen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
