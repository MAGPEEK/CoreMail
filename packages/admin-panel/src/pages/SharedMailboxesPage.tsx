import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Inbox, Plus, Trash2, Pencil, UserPlus, X, Loader2, Shield } from 'lucide-react';
import { api } from '../api/client.js';

type PermType = 'FULL_ACCESS' | 'SEND_AS' | 'SEND_ON_BEHALF' | 'READ_ONLY';

interface Perm {
  id: string; userId: string; permission: PermType; grantedAt: string;
  user: { email: string; displayName: string };
}
interface SharedMailbox {
  id: string; email: string; displayName: string; domainId: string;
  quotaBytes: number; usedBytes: number; active: boolean; createdAt: string;
  permissions: Perm[];
}
interface Domain { id: string; name: string }
interface User   { id: string; email: string; displayName: string }

const PERM_LABELS: Record<PermType, string> = {
  FULL_ACCESS: 'Vollzugriff', SEND_AS: 'Senden als',
  SEND_ON_BEHALF: 'Im Auftrag senden', READ_ONLY: 'Nur lesen',
};

export function SharedMailboxesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [editItem, setEditItem] = useState<SharedMailbox | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [permItem, setPermItem] = useState<SharedMailbox | null>(null);

  useMemo(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery<{ items: SharedMailbox[]; total: number }>({
    queryKey: ['admin-shared-mailboxes', debouncedSearch, page, limit],
    queryFn: () => api.get(`/api/v1/admin/shared-mailboxes?search=${encodeURIComponent(debouncedSearch)}&page=${page}&limit=${limit}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/shared-mailboxes/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] }); toast.success('Gelöscht'); },
    onError: () => toast.error('Löschen fehlgeschlagen'),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Inbox size={22} className="text-blue-600" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">Freigegebene Postfächer</h1>
            <p className="text-sm text-gray-500">{total} Postfach{total !== 1 ? 'fächer' : ''}</p>
          </div>
        </div>
        <button onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
          <Plus size={14} /> Neues Postfach
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="p-3 border-b border-gray-200">
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Postfächer durchsuchen…"
            className="input max-w-sm" />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" /> Lade…
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">Keine freigegebenen Postfächer</div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">E-Mail / Name</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Berechtigungen</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map(item => (
                <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900 text-sm">{item.email}</p>
                    <p className="text-xs text-gray-400">{item.displayName}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {item.permissions.length === 0
                        ? <span className="text-xs text-gray-400">–</span>
                        : item.permissions.slice(0, 3).map(p => (
                            <span key={p.id} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs">
                              {p.user.email.split('@')[0]} · {PERM_LABELS[p.permission]}
                            </span>
                          ))
                      }
                      {item.permissions.length > 3 && (
                        <span className="text-xs text-gray-400">+{item.permissions.length - 3}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${item.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {item.active ? 'Aktiv' : 'Inaktiv'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setPermItem(item)} title="Berechtigungen"
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors">
                        <Shield size={14} />
                      </button>
                      <button onClick={() => setEditItem(item)} title="Bearbeiten"
                        className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => { if (window.confirm(`"${item.email}" löschen?`)) deleteMutation.mutate(item.id); }}
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

        {/* Pagination */}
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

      {createOpen && <SharedMailboxModal onClose={() => setCreateOpen(false)} />}
      {editItem   && <SharedMailboxModal item={editItem} onClose={() => setEditItem(null)} />}
      {permItem   && <PermissionsModal item={permItem} onClose={() => setPermItem(null)} />}
    </div>
  );
}

// ── Create/Edit Modal ─────────────────────────────────────────────────────────
function SharedMailboxModal({ item, onClose }: { item?: SharedMailbox; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail]     = useState(item?.email ?? '');
  const [name, setName]       = useState(item?.displayName ?? '');
  const [domainId, setDomainId] = useState(item?.domainId ?? '');
  const [active, setActive]   = useState(item?.active ?? true);

  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['admin-domains-list'],
    queryFn: () => api.get<{ items: Domain[] }>('/api/v1/admin/domains?limit=200').then(r => r.items),
  });

  const mutation = useMutation({
    mutationFn: () => item
      ? api.put(`/api/v1/admin/shared-mailboxes/${item.id}`, { displayName: name, active })
      : api.post('/api/v1/admin/shared-mailboxes', { email, displayName: name, domainId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] });
      toast.success(item ? 'Gespeichert' : 'Erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message || 'Fehler'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">{item ? 'Postfach bearbeiten' : 'Neues freigegebenes Postfach'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          {!item && (
            <>
              <div>
                <label className="field-label">E-Mail-Adresse</label>
                <input value={email} onChange={e => setEmail(e.target.value)} className="input" placeholder="support@domain.com" />
              </div>
              <div>
                <label className="field-label">Domain</label>
                <select value={domainId} onChange={e => setDomainId(e.target.value)} className="input">
                  <option value="">Domain wählen…</option>
                  {domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            </>
          )}
          <div>
            <label className="field-label">Anzeigename</label>
            <input value={name} onChange={e => setName(e.target.value)} className="input" placeholder="Support-Team" />
          </div>
          {item && (
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="rounded" />
              Aktiv
            </label>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="btn-secondary">Abbrechen</button>
            <button onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !name || (!item && (!email || !domainId))}
              className="btn-primary flex items-center gap-1.5">
              {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {item ? 'Speichern' : 'Erstellen'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Permissions Modal ─────────────────────────────────────────────────────────
function PermissionsModal({ item, onClose }: { item: SharedMailbox; onClose: () => void }) {
  const qc = useQueryClient();
  const [userId, setUserId]     = useState('');
  const [permission, setPerm]   = useState<PermType>('FULL_ACCESS');
  const [userSearch, setUserSearch] = useState('');

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ['admin-users-list', userSearch],
    queryFn: () => api.get<{ items: User[] }>(`/api/v1/admin/mailboxes?search=${encodeURIComponent(userSearch)}&limit=50`).then(r => r.items),
    enabled: userSearch.length > 1,
  });

  const addMutation = useMutation({
    mutationFn: () => api.post(`/api/v1/admin/shared-mailboxes/${item.id}/permissions`, { userId, permission }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] }); toast.success('Berechtigung hinzugefügt'); setUserId(''); setUserSearch(''); },
    onError: () => toast.error('Fehler'),
  });

  const removeMutation = useMutation({
    mutationFn: (uid: string) => api.delete(`/api/v1/admin/shared-mailboxes/${item.id}/permissions/${uid}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] }); toast.success('Entfernt'); },
    onError: () => toast.error('Fehler'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h2 className="font-semibold text-gray-900">Berechtigungen</h2>
            <p className="text-xs text-gray-500">{item.email}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          {/* Bestehende Berechtigungen */}
          <div className="space-y-2">
            {item.permissions.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-2">Noch keine Berechtigungen</p>
            )}
            {item.permissions.map(p => (
              <div key={p.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                <div>
                  <p className="text-sm font-medium text-gray-900">{p.user.displayName}</p>
                  <p className="text-xs text-gray-500">{p.user.email} · {PERM_LABELS[p.permission]}</p>
                </div>
                <button onClick={() => removeMutation.mutate(p.userId)}
                  className="p-1 text-gray-400 hover:text-red-600 transition-colors">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>

          {/* Neue Berechtigung */}
          <div className="border-t border-gray-200 pt-4">
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Berechtigung hinzufügen</p>
            <div className="space-y-2">
              <input value={userSearch} onChange={e => setUserSearch(e.target.value)}
                className="input" placeholder="Benutzer suchen…" />
              {users.length > 0 && (
                <select size={4} value={userId} onChange={e => setUserId(e.target.value)}
                  className="input h-auto">
                  {users.map(u => <option key={u.id} value={u.id}>{u.displayName} ({u.email})</option>)}
                </select>
              )}
              <select value={permission} onChange={e => setPerm(e.target.value as PermType)} className="input">
                {(Object.entries(PERM_LABELS) as [PermType, string][]).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <button onClick={() => addMutation.mutate()} disabled={!userId || addMutation.isPending}
                className="btn-primary w-full flex items-center justify-center gap-1.5">
                {addMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
                Hinzufügen
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
