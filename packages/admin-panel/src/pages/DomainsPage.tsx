import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, X, Copy, CheckCircle, ChevronDown, RefreshCw } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
import { copyToClipboard } from '../utils/clipboard.js';

// ── Typen ─────────────────────────────────────────────────────────────────────
interface Domain {
  id:           string;
  name:         string;
  active:       boolean;
  primary:      boolean;
  dkimSelector: string;
  createdAt:    string;
  _count:       { users: number };
}
interface DomainsResponse { domains: Domain[]; total: number; page: number; limit: number }
interface DkimRecord { selector: string; dnsName: string; dnsValue: string }


// ── Add-Domain-Modal ──────────────────────────────────────────────────────────
function AddDomainModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [selector, setSelector] = useState('coremail');

  const createMutation = useMutation({
    mutationFn: () => api.post<Domain>('/admin/domains', { name: name.trim(), dkimSelector: selector }),
    onSuccess: () => {
      toast.success('Domain wurde hinzugefügt');
      void qc.invalidateQueries({ queryKey: ['admin-domains'] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || 'Fehler beim Anlegen'),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-gray-900">Domain hinzufügen</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Domain-Name <span className="text-red-500">*</span></label>
            <input
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="example.com"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && name.trim() && createMutation.mutate()}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">DKIM-Selektor</label>
            <input
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={selector}
              onChange={e => setSelector(e.target.value)}
              placeholder="coremail"
            />
            <p className="text-xs text-gray-400 mt-1">DKIM-Schlüsselpaar wird automatisch generiert</p>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors"
          >
            Abbrechen
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={!name.trim() || createMutation.isPending}
            className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {createMutation.isPending ? 'Hinzufügen…' : 'Hinzufügen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit-Domain-Modal ─────────────────────────────────────────────────────────
function EditDomainModal({ domain, onClose }: { domain: Domain; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(domain.name);
  const [selector, setSelector] = useState(domain.dkimSelector);
  const [dkimRecord, setDkimRecord] = useState<DkimRecord | null>(null);
  const [dkimLoading, setDkimLoading] = useState(false);

  const updateMutation = useMutation({
    mutationFn: () => api.put<Domain>(`/admin/domains/${domain.id}`, { name: name.trim(), dkimSelector: selector }),
    onSuccess: () => {
      toast.success('Domain aktualisiert');
      void qc.invalidateQueries({ queryKey: ['admin-domains'] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || 'Fehler'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/admin/domains/${domain.id}`),
    onSuccess: () => {
      toast.success('Domain gelöscht');
      void qc.invalidateQueries({ queryKey: ['admin-domains'] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || 'Fehler beim Löschen'),
  });

  const loadDkim = async () => {
    setDkimLoading(true);
    try {
      const r = await api.get<DkimRecord>(`/admin/domains/${domain.id}/dkim-record`);
      setDkimRecord(r);
    } catch {
      toast.error('DKIM-Record konnte nicht geladen werden');
    } finally {
      setDkimLoading(false);
    }
  };

  const regenerateDkim = async () => {
    if (!confirm('DKIM-Schlüsselpaar neu generieren?\n\nDer bestehende DNS-TXT-Eintrag wird ungültig — danach muss ein neuer Eintrag beim DNS-Anbieter gesetzt werden.')) return;
    setDkimLoading(true);
    try {
      const r = await api.post<DkimRecord>(`/admin/domains/${domain.id}/regenerate-dkim`, {});
      setDkimRecord(r);
      toast.success('Neues DKIM-Schlüsselpaar generiert — DNS-Eintrag aktualisieren!');
    } catch {
      toast.error('DKIM-Schlüssel konnte nicht neu generiert werden');
    } finally {
      setDkimLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-gray-900">Domain bearbeiten</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded"><X size={16} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Domain-Name</label>
            <input
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">DKIM-Selektor</label>
            <input
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={selector}
              onChange={e => setSelector(e.target.value)}
            />
          </div>

          {/* Info */}
          <div className="flex items-center gap-4 pt-1">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${domain.primary ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
              {domain.primary ? 'Primäre Domain' : 'Sekundäre Domain'}
            </span>
            <span className="text-xs text-gray-400">{domain._count.users} Postfach/Postfächer</span>
          </div>

          {/* DKIM DNS Record */}
          <div className="pt-1 flex items-center gap-3">
            <button
              onClick={() => void loadDkim()}
              disabled={dkimLoading}
              className="flex items-center gap-1.5 text-xs text-blue-600 hover:underline disabled:opacity-50"
            >
              <CheckCircle size={13} />
              {dkimLoading ? 'Lädt…' : 'DKIM DNS-Eintrag anzeigen'}
            </button>
            {dkimRecord && (
              <button
                onClick={() => void regenerateDkim()}
                disabled={dkimLoading}
                className="flex items-center gap-1.5 text-xs text-amber-600 hover:underline disabled:opacity-50"
                title="Neues RSA-2048-Schlüsselpaar generieren — bestehender DNS-Eintrag wird ungültig"
              >
                <RefreshCw size={12} />
                Neu generieren
              </button>
            )}
          </div>

          {dkimRecord && (
            <div className="bg-gray-50 rounded-lg p-3 space-y-2 border border-gray-200">
              <div>
                <label className="text-xs text-gray-500 font-medium">DNS-Name</label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-xs font-mono break-all">{dkimRecord.dnsName}</code>
                  <button onClick={() => { copyToClipboard(dkimRecord.dnsName).then(() => toast.success('Kopiert')).catch(() => toast.error('Kopieren fehlgeschlagen')); }} className="p-1 text-gray-400 hover:text-gray-600"><Copy size={12} /></button>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 font-medium">TXT-Wert</label>
                <div className="flex items-start gap-2 mt-1">
                  <code className="flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-xs font-mono break-all">{dkimRecord.dnsValue}</code>
                  <button onClick={() => { copyToClipboard(dkimRecord.dnsValue).then(() => toast.success('Kopiert')).catch(() => toast.error('Kopieren fehlgeschlagen')); }} className="p-1 text-gray-400 hover:text-gray-600 mt-0.5"><Copy size={12} /></button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between mt-5">
          {/* Löschen nur wenn nicht primär und keine User */}
          <button
            onClick={() => {
              if (confirm(`Domain "${domain.name}" wirklich löschen?`)) deleteMutation.mutate();
            }}
            disabled={domain.primary || deleteMutation.isPending}
            className="px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={domain.primary ? 'Primäre Domain kann nicht gelöscht werden' : undefined}
          >
            Löschen
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors">
              Abbrechen
            </button>
            <button
              onClick={() => updateMutation.mutate()}
              disabled={!name.trim() || updateMutation.isPending}
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {updateMutation.isPending ? 'Speichern…' : 'Speichern'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Haupt-Komponente ──────────────────────────────────────────────────────────
export function DomainsPage() {
  const qc = useQueryClient();

  const [search, setSearch]       = useState('');
  const [limit,  setLimit]        = useState(50);
  const [page,   setPage]         = useState(1);
  const [showAdd, setShowAdd]     = useState(false);
  const [editing, setEditing]     = useState<Domain | null>(null);

  // Debounced search query string
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useMemo(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery<DomainsResponse>({
    queryKey: ['admin-domains', debouncedSearch, page, limit],
    queryFn:  () => api.get<DomainsResponse>(
      `/admin/domains?search=${encodeURIComponent(debouncedSearch)}&page=${page}&limit=${limit}`
    ),
    placeholderData: prev => prev,
  });

  const domains = data?.domains ?? [];
  const total   = data?.total   ?? 0;
  const totalPages = Math.ceil(total / limit);

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/domains/${id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-domains'] }),
    onError: () => toast.error('Fehler beim Umschalten'),
  });

  const makePrimaryMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/domains/${id}/make-primary`, {}),
    onSuccess: () => {
      toast.success('Primäre Domain gesetzt');
      void qc.invalidateQueries({ queryKey: ['admin-domains'] });
    },
    onError: () => toast.error('Fehler beim Setzen der primären Domain'),
  });

  return (
    <div className="min-h-full bg-gray-100">
      {/* ── Kopfzeile ──────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-8 py-5">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Manage Domains</h1>
        </div>
      </div>

      {/* ── Inhaltsbereich ─────────────────────────────────────────────────── */}
      <div className="p-8">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          {/* ── Toolbar ──────────────────────────────────────── */}
          <div className="flex items-center gap-4 p-5 border-b border-gray-200">
            <h2 className="text-lg font-bold text-gray-900 shrink-0">Domains</h2>

            {/* Suche */}
            <div className="flex-1 max-w-lg">
              <input
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search domains"
                className="w-full border border-gray-300 rounded px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-center placeholder-gray-400"
              />
            </div>

            <div className="flex-1" />

            {/* ADD DOMAIN */}
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors uppercase tracking-wide"
            >
              <Plus size={15} />
              ADD DOMAIN
            </button>
          </div>

          {/* ── Tabelle ───────────────────────────────────────── */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide w-12">#</th>
                <th className="text-left px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide">DOMAIN NAME</th>
                <th className="px-6 py-3 w-44"></th>
                <th className="text-center px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide">STATUS</th>
                <th className="text-center px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading && (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-gray-400 text-sm">Lade…</td>
                </tr>
              )}
              {!isLoading && domains.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-gray-400 text-sm">
                    {search ? 'Keine Domains gefunden' : 'Noch keine Domains angelegt'}
                  </td>
                </tr>
              )}
              {domains.map((d, i) => (
                <tr key={d.id} className="hover:bg-gray-50 transition-colors">
                  {/* # */}
                  <td className="px-6 py-4 text-gray-500 text-sm">{(page - 1) * limit + i + 1}</td>

                  {/* Domain Name */}
                  <td className="px-6 py-4 text-gray-800 text-sm font-medium">{d.name}</td>

                  {/* MAKE PRIMARY / Primary Domain label */}
                  <td className="px-6 py-4">
                    {d.primary ? (
                      <span className="text-sm text-gray-500">Primary Domain</span>
                    ) : (
                      <button
                        onClick={() => makePrimaryMutation.mutate(d.id)}
                        disabled={makePrimaryMutation.isPending}
                        className="px-4 py-1.5 text-xs font-bold text-blue-600 border border-blue-300 rounded hover:bg-blue-50 transition-colors uppercase tracking-wide disabled:opacity-50"
                      >
                        MAKE PRIMARY
                      </button>
                    )}
                  </td>

                  {/* STATUS Toggle */}
                  <td className="px-6 py-4 text-center">
                    <Toggle
                      active={d.active}
                      onToggle={() => toggleMutation.mutate(d.id)}
                    />
                  </td>

                  {/* ACTIONS — Pencil-Edit */}
                  <td className="px-6 py-4 text-center">
                    <button
                      onClick={() => setEditing(d)}
                      className="p-1.5 text-blue-500 hover:text-blue-700 border border-blue-200 rounded hover:bg-blue-50 transition-colors"
                      title="Domain bearbeiten"
                    >
                      <Pencil size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* ── Fußzeile: Pagination ──────────────────────────── */}
          <div className="flex items-center gap-3 px-6 py-3 border-t border-gray-200">
            {/* Limit-Auswahl */}
            <div className="relative flex items-center">
              <select
                value={limit}
                onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}
                className="appearance-none border border-gray-300 rounded px-3 py-1.5 pr-7 text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <ChevronDown size={12} className="absolute right-2 text-gray-400 pointer-events-none" />
            </div>
            <span className="text-sm text-gray-500">domains per page</span>

            <div className="flex-1" />

            {/* Seitennavigation */}
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded disabled:opacity-40"
                >
                  ‹
                </button>
                <span className="text-sm text-gray-600">{page} / {totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded disabled:opacity-40"
                >
                  ›
                </button>
              </div>
            )}

            <span className="text-xs text-gray-400">{total} Domain{total !== 1 ? 's' : ''} gesamt</span>
          </div>
        </div>
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {showAdd  && <AddDomainModal  onClose={() => setShowAdd(false)} />}
      {editing  && <EditDomainModal domain={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
