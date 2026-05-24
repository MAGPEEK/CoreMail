import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Pencil, Trash2, RotateCcw, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface OAuthClient {
  id: string;
  clientId: string;
  name: string;
  description: string;
  redirectUris: string[];
  allowedScopes: string[];
  trusted: boolean;
  active: boolean;
  createdAt: string;
}

interface OAuthToken {
  id: string;
  userId: string;
  clientId: string;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
  revoked: boolean;
}

const ALL_SCOPES = ['openid', 'profile', 'email', 'mail', 'calendar', 'contacts', 'ews', 'admin'];

// ─── Client Modal ─────────────────────────────────────────────────────────────

function ClientModal({ client, onClose }: { client: OAuthClient | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = client !== null;

  const [form, setForm] = useState({
    name:          client?.name ?? '',
    description:   client?.description ?? '',
    redirectUris:  client?.redirectUris.join('\n') ?? '',
    allowedScopes: client?.allowedScopes ?? ['openid', 'email', 'mail', 'ews'],
    trusted:       client?.trusted ?? false,
  });

  const toggleScope = (s: string) => setForm(f => ({
    ...f,
    allowedScopes: f.allowedScopes.includes(s)
      ? f.allowedScopes.filter(x => x !== s)
      : [...f.allowedScopes, s],
  }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        description: form.description,
        redirectUris: form.redirectUris.split('\n').map(s => s.trim()).filter(Boolean),
        allowedScopes: form.allowedScopes,
        trusted: form.trusted,
      };
      return isEdit
        ? api.put(`/admin/oauth/clients/${client.id}`, body)
        : api.post('/admin/oauth/clients', body);
    },
    onSuccess: (res: unknown) => {
      void qc.invalidateQueries({ queryKey: ['admin-oauth-clients'] });
      const r = res as { rawSecret?: string; clientId?: string };
      if (r?.rawSecret) {
        toast.success(
          `Client erstellt! Secret (einmalig): ${r.rawSecret}`,
          { duration: 15000 }
        );
      } else {
        toast.success(isEdit ? 'Client aktualisiert' : 'Client erstellt');
      }
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            {isEdit ? 'OAuth2-Client bearbeiten' : 'Neuer OAuth2-Client'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="z.B. Outlook Modern Auth" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Beschreibung</label>
            <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Redirect-URIs <span className="text-gray-400">(eine pro Zeile)</span>
            </label>
            <textarea value={form.redirectUris} onChange={e => setForm(f => ({ ...f, redirectUris: e.target.value }))}
              rows={3} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent resize-none"
              placeholder="https://app.example.com/callback" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">Erlaubte Scopes</label>
            <div className="flex flex-wrap gap-2">
              {ALL_SCOPES.map(s => (
                <button key={s} onClick={() => toggleScope(s)}
                  className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
                    form.allowedScopes.includes(s)
                      ? 'bg-accent text-white border-accent'
                      : 'border-gray-300 text-gray-600 hover:border-accent'
                  }`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.trusted} onChange={e => setForm(f => ({ ...f, trusted: e.target.checked }))}
              className="accent-accent" />
            <div>
              <span className="text-sm text-gray-700">Vertrauenswürdiger Client</span>
              <p className="text-xs text-gray-500">Überspringt Zustimmungsdialog (z.B. eigene First-Party-Apps)</p>
            </div>
          </label>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name || !form.redirectUris.trim()}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function OAuthClientsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'clients' | 'tokens'>('clients');
  const [modal, setModal] = useState<'create' | OAuthClient | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<OAuthClient | null>(null);

  const { data: clients = [], isLoading } = useQuery<OAuthClient[]>({
    queryKey: ['admin-oauth-clients'],
    queryFn: () => api.get('/admin/oauth/clients'),
  });

  const { data: tokens = [] } = useQuery<OAuthToken[]>({
    queryKey: ['admin-oauth-tokens'],
    queryFn: () => api.get('/admin/oauth/tokens'),
    enabled: tab === 'tokens',
  });

  const rotateSecret = useMutation({
    mutationFn: (id: string) => api.post(`/admin/oauth/clients/${id}/rotate-secret`, {}),
    onSuccess: (res: unknown) => {
      const r = res as { rawSecret?: string };
      if (r?.rawSecret) {
        toast.success(`Neues Secret (einmalig): ${r.rawSecret}`, { duration: 15000 });
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteClient = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/oauth/clients/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-oauth-clients'] });
      toast.success('Client gelöscht');
      setDeleteConfirm(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revokeToken = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/oauth/tokens/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-oauth-tokens'] }); toast.success('Token widerrufen'); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <KeyRound size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">OAuth2 / Modern Auth</h1>
            <p className="text-sm text-gray-500">OAuth2-Clients für Outlook Modern Authentication</p>
          </div>
        </div>
        {tab === 'clients' && (
          <button onClick={() => setModal('create')}
            className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90">
            <Plus size={15} /> Neuer Client
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-4">
        {(['clients', 'tokens'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t ? 'border-accent text-accent' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {t === 'clients' ? `Clients (${clients.length})` : 'Aktive Tokens'}
          </button>
        ))}
      </div>

      {/* Clients Tab */}
      {tab === 'clients' && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">Client</th>
                <th className="text-left px-4 py-3">Client-ID</th>
                <th className="text-left px-4 py-3">Scopes</th>
                <th className="text-left px-4 py-3">Typ</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={5} className="text-center py-12 text-gray-400">Laden…</td></tr>
              ) : clients.length === 0 ? (
                <tr><td colSpan={5} className="text-center py-12 text-gray-400">Noch keine OAuth2-Clients registriert</td></tr>
              ) : clients.map(c => (
                <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{c.name}</p>
                    {c.description && <p className="text-xs text-gray-500">{c.description}</p>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{c.clientId}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {c.allowedScopes.map(s => (
                        <span key={s} className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">{s}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {c.trusted
                      ? <span className="flex items-center gap-1 text-xs text-green-600"><ShieldCheck size={12} /> Vertrauenswürdig</span>
                      : <span className="text-xs text-gray-400">Standard</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => rotateSecret.mutate(c.id)}
                        className="p-1.5 text-gray-400 hover:text-yellow-600 hover:bg-yellow-50 rounded" title="Secret rotieren">
                        <RotateCcw size={13} />
                      </button>
                      <button onClick={() => setModal(c)}
                        className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded" title="Bearbeiten">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => setDeleteConfirm(c)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded" title="Löschen">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tokens Tab */}
      {tab === 'tokens' && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">Benutzer</th>
                <th className="text-left px-4 py-3">Client-ID</th>
                <th className="text-left px-4 py-3">Scopes</th>
                <th className="text-left px-4 py-3">Läuft ab</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {tokens.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400">Keine aktiven Tokens</td></tr>
              ) : tokens.map(t => (
                <tr key={t.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{t.userId}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{t.clientId}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {t.scopes.map(s => (
                        <span key={s} className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">{s}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {new Date(t.expiresAt).toLocaleString('de-DE')}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      t.revoked ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'
                    }`}>
                      {t.revoked ? 'Widerrufen' : 'Aktiv'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!t.revoked && (
                      <button onClick={() => revokeToken.mutate(t.id)}
                        className="px-2 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50">
                        Widerrufen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal !== null && <ClientModal client={modal === 'create' ? null : modal} onClose={() => setModal(null)} />}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Client löschen</h2>
            <p className="text-sm text-gray-600 mb-4">
              Soll <strong>{deleteConfirm.name}</strong> gelöscht werden? Alle Tokens werden ungültig.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
              <button onClick={() => deleteClient.mutate(deleteConfirm.id)} disabled={deleteClient.isPending}
                className="px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50">
                {deleteClient.isPending ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
