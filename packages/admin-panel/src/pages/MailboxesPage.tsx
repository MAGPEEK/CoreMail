import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Pencil, Trash2, X } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';

interface User { id: string; email: string; displayName: string; role: string; active: boolean; quotaBytes: number; usedBytes: number }
interface Domain { id: string; name: string }

function formatBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  return `${(b / 1e6).toFixed(0)} MB`;
}

export function MailboxesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ email: '', displayName: '', password: '', domainId: '', role: 'USER', quotaBytes: 5368709120 });

  const { data: mailboxes } = useQuery({ queryKey: ['admin-mailboxes'], queryFn: () => api.get<User[]>('/admin/mailboxes') });
  const { data: domains } = useQuery({ queryKey: ['admin-domains'], queryFn: () => api.get<Domain[]>('/admin/domains') });

  const createMutation = useMutation({
    mutationFn: () => api.post('/admin/mailboxes', form),
    onSuccess: () => { toast.success('Postfach erstellt'); qc.invalidateQueries({ queryKey: ['admin-mailboxes'] }); setShowCreate(false); setForm({ email: '', displayName: '', password: '', domainId: '', role: 'USER', quotaBytes: 5368709120 }); },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.put(`/admin/mailboxes/${id}`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-mailboxes'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/mailboxes/${id}`),
    onSuccess: () => { toast.success('Postfach gelöscht'); qc.invalidateQueries({ queryKey: ['admin-mailboxes'] }); },
    onError: (err: Error) => toast.error(err.message),
  });

  const filtered = (mailboxes ?? []).filter((u) =>
    u.email.toLowerCase().includes(search.toLowerCase()) ||
    u.displayName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Postfächer</h1>
        <button onClick={() => setShowCreate(true)} className="btn-primary"><Plus size={15} /> Neues Postfach</button>
      </div>

      <div className="relative w-72">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} className="input pl-8" placeholder="Suchen..." />
      </div>

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['E-Mail', 'Name', 'Rolle', 'Quota', 'Status', ''].map((h) => (
                <th key={h} className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((u) => (
              <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-2.5 font-medium text-gray-800">{u.email}</td>
                <td className="px-4 py-2.5 text-gray-600">{u.displayName}</td>
                <td className="px-4 py-2.5">
                  <span className={`badge ${u.role === 'USER' ? 'badge-gray' : 'badge-blue'}`}>{u.role}</span>
                </td>
                <td className="px-4 py-2.5 text-gray-500 text-xs">
                  {formatBytes(u.usedBytes)} / {formatBytes(u.quotaBytes)}
                </td>
                <td className="px-4 py-2.5">
                  <button onClick={() => toggleMutation.mutate({ id: u.id, active: !u.active })}
                    className={`badge cursor-pointer ${u.active ? 'badge-green' : 'badge-red'}`}>
                    {u.active ? 'Aktiv' : 'Deaktiviert'}
                  </button>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1">
                    <button className="btn-ghost p-1 text-xs"><Pencil size={13} /></button>
                    <button onClick={() => { if (confirm(`${u.email} löschen?`)) deleteMutation.mutate(u.id); }}
                      className="btn-ghost p-1 text-xs text-red-500 hover:bg-red-50">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="py-8 text-center text-gray-400 text-sm">Keine Postfächer</div>
        )}
      </div>

      {/* Create dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Neues Postfach</h2>
              <button onClick={() => setShowCreate(false)} className="btn-ghost p-1"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Domain</label>
                <select className="input" value={form.domainId} onChange={(e) => { const d = domains?.find((x) => x.id === e.target.value); setForm({ ...form, domainId: e.target.value, email: d ? `@${d.name}` : '' }); }}>
                  <option value="">Domain wählen...</option>
                  {(domains ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">E-Mail-Adresse</label>
                <input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="benutzer@domain.com" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Anzeigename</label>
                <input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Passwort</label>
                <input type="password" className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Rolle</label>
                <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {['USER', 'HELP_DESK', 'RECIPIENT_MANAGEMENT', 'COMPLIANCE_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'SERVER_MANAGEMENT', 'ORGANIZATION_MANAGEMENT', 'ADMIN'].map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreate(false)} className="btn-secondary">Abbrechen</button>
              <button onClick={() => createMutation.mutate()} disabled={!form.email || !form.password || !form.domainId || createMutation.isPending} className="btn-primary disabled:opacity-50">
                {createMutation.isPending ? 'Erstellen...' : 'Erstellen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
