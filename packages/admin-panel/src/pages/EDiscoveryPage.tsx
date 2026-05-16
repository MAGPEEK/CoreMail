import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SearchCheck, Plus, Trash2, Play, Download, Lock, Unlock, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EDiscoverySearch {
  id: string;
  name: string;
  description: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  resultCount: number;
  query: {
    keywords?: string;
    senderAddresses?: string[];
    recipientAddresses?: string[];
    dateFrom?: string;
    dateTo?: string;
    subjectContains?: string;
    hasAttachment?: boolean;
  };
  mailboxIds: string[];
  createdAt: string;
  exportPath?: string;
}

interface LegalHold {
  id: string;
  name: string;
  description: string;
  active: boolean;
  mailboxIds: string[];
  appliedBy: string;
  appliedAt: string;
  releasedAt?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: EDiscoverySearch['status'] }) {
  const map: Record<EDiscoverySearch['status'], string> = {
    PENDING:   'bg-gray-100 text-gray-600',
    RUNNING:   'bg-blue-100 text-blue-700',
    COMPLETED: 'bg-green-100 text-green-700',
    FAILED:    'bg-red-100 text-red-700',
  };
  const labels: Record<EDiscoverySearch['status'], string> = {
    PENDING: 'Ausstehend', RUNNING: 'Läuft', COMPLETED: 'Abgeschlossen', FAILED: 'Fehlgeschlagen',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${map[status]}`}>
      {labels[status]}
    </span>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Create Search Modal ──────────────────────────────────────────────────────

function CreateSearchModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: '', description: '',
    keywords: '', senderAddresses: '', recipientAddresses: '',
    dateFrom: '', dateTo: '', subjectContains: '',
  });

  const set = (k: keyof typeof form, v: string) => setForm(f => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => api.post('/admin/ediscovery/searches', {
      name: form.name,
      description: form.description,
      query: {
        ...(form.keywords ? { keywords: form.keywords } : {}),
        ...(form.senderAddresses ? { senderAddresses: form.senderAddresses.split(',').map(s => s.trim()).filter(Boolean) } : {}),
        ...(form.recipientAddresses ? { recipientAddresses: form.recipientAddresses.split(',').map(s => s.trim()).filter(Boolean) } : {}),
        ...(form.dateFrom ? { dateFrom: new Date(form.dateFrom).toISOString() } : {}),
        ...(form.dateTo ? { dateTo: new Date(form.dateTo).toISOString() } : {}),
        ...(form.subjectContains ? { subjectContains: form.subjectContains } : {}),
      },
      mailboxIds: [],
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-ediscovery-searches'] });
      toast.success('Suche erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const F = ({ label, k, placeholder, type = 'text' }: { label: string; k: keyof typeof form; placeholder?: string; type?: string }) => (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input type={type} value={form[k]} onChange={e => set(k, e.target.value)}
        className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
        placeholder={placeholder} />
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Neue eDiscovery-Suche</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <F label="Name *" k="name" placeholder="Projekt Gamma Untersuchung" />
          <F label="Beschreibung" k="description" placeholder="Optionale Beschreibung" />
          <div className="border-t border-gray-100 pt-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Suchkriterien</p>
          </div>
          <F label="Stichwörter" k="keywords" placeholder="Begriff1 Begriff2" />
          <F label="Betreff enthält" k="subjectContains" placeholder="Re: Vertrag" />
          <F label="Absender (kommagetrennt)" k="senderAddresses" placeholder="user@domain.com, …" />
          <F label="Empfänger (kommagetrennt)" k="recipientAddresses" placeholder="user@domain.com, …" />
          <div className="grid grid-cols-2 gap-3">
            <F label="Datum von" k="dateFrom" type="date" />
            <F label="Datum bis" k="dateTo" type="date" />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Erstellen…' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Create Hold Modal ────────────────────────────────────────────────────────

function CreateHoldModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mailboxIds, setMailboxIds] = useState('');

  const save = useMutation({
    mutationFn: () => api.post('/admin/ediscovery/holds', {
      name, description,
      mailboxIds: mailboxIds.split(',').map(s => s.trim()).filter(Boolean),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-ediscovery-holds'] });
      toast.success('Legal Hold erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Neuer Legal Hold</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="z.B. Rechtsstreit Müller vs. AG" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Beschreibung</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)}
              rows={2} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">User-IDs (kommagetrennt)</label>
            <textarea value={mailboxIds} onChange={e => setMailboxIds(e.target.value)}
              rows={3} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent resize-none"
              placeholder="cuid1, cuid2, …" />
            <p className="text-xs text-gray-400 mt-1">User-IDs aus der Postfachverwaltung</p>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !name || !mailboxIds.trim()}
            className="px-4 py-2 text-sm text-white bg-red-600 rounded hover:bg-red-700 disabled:opacity-50">
            {save.isPending ? 'Sperren…' : 'Hold aktivieren'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function EDiscoveryPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'searches' | 'holds'>('searches');
  const [createSearch, setCreateSearch] = useState(false);
  const [createHold, setCreateHold] = useState(false);
  const [expandedSearch, setExpandedSearch] = useState<string | null>(null);

  const { data: searches = [], isLoading: searchLoading } = useQuery<EDiscoverySearch[]>({
    queryKey: ['admin-ediscovery-searches'],
    queryFn: () => api.get('/admin/ediscovery/searches'),
    refetchInterval: 5000, // poll for status changes
  });

  const { data: holds = [], isLoading: holdLoading } = useQuery<LegalHold[]>({
    queryKey: ['admin-ediscovery-holds'],
    queryFn: () => api.get('/admin/ediscovery/holds'),
  });

  const runSearch = useMutation({
    mutationFn: (id: string) => api.post(`/admin/ediscovery/searches/${id}/run`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ediscovery-searches'] }); toast.success('Suche gestartet'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const exportSearch = useMutation({
    mutationFn: (id: string) => api.post(`/admin/ediscovery/searches/${id}/export`, {}),
    onSuccess: () => toast.success('Export-Job gestartet — Download-Link folgt'),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteSearch = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/ediscovery/searches/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ediscovery-searches'] }); toast.success('Suche gelöscht'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const releaseHold = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/ediscovery/holds/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ediscovery-holds'] }); toast.success('Legal Hold aufgehoben'); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <SearchCheck size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">eDiscovery & Legal Hold</h1>
            <p className="text-sm text-gray-500">Postfach-Suche, Datenexport und Aufbewahrungssperren</p>
          </div>
        </div>
        <button onClick={() => tab === 'searches' ? setCreateSearch(true) : setCreateHold(true)}
          className={`flex items-center gap-2 px-4 py-2 text-sm text-white rounded hover:opacity-90 ${
            tab === 'holds' ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:bg-accent/90'
          }`}>
          <Plus size={15} /> {tab === 'searches' ? 'Neue Suche' : 'Neuer Legal Hold'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-4">
        {(['searches', 'holds'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t ? 'border-accent text-accent' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {t === 'searches' ? `Suchen (${searches.length})` : `Legal Holds (${holds.filter(h => h.active).length} aktiv)`}
          </button>
        ))}
      </div>

      {/* Searches Tab */}
      {tab === 'searches' && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="w-6 px-3 py-3" />
                <th className="text-left px-4 py-3">Suche</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Ergebnisse</th>
                <th className="text-left px-4 py-3">Erstellt</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {searchLoading ? (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400">Laden…</td></tr>
              ) : searches.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400">Noch keine Suchen angelegt</td></tr>
              ) : searches.map(s => (
                <>
                  <tr key={s.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-3">
                      <button onClick={() => setExpandedSearch(expandedSearch === s.id ? null : s.id)}
                        className="text-gray-400 hover:text-gray-600">
                        {expandedSearch === s.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{s.name}</p>
                      {s.description && <p className="text-xs text-gray-500">{s.description}</p>}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                    <td className="px-4 py-3 text-gray-700">
                      {s.status === 'COMPLETED' ? s.resultCount.toLocaleString('de-DE') : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{fmtDate(s.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {s.status !== 'RUNNING' && (
                          <button onClick={() => runSearch.mutate(s.id)}
                            className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded" title="Suche starten">
                            <Play size={13} />
                          </button>
                        )}
                        {s.status === 'COMPLETED' && (
                          <button onClick={() => exportSearch.mutate(s.id)}
                            className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="Exportieren">
                            <Download size={13} />
                          </button>
                        )}
                        <button onClick={() => deleteSearch.mutate(s.id)}
                          className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded" title="Löschen">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedSearch === s.id && (
                    <tr key={`${s.id}-details`}>
                      <td colSpan={6} className="p-0">
                        <div className="bg-gray-50 border-t border-gray-100 px-8 py-4">
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Suchkriterien</p>
                          <div className="grid grid-cols-3 gap-2 text-xs">
                            {s.query.keywords && <div><span className="text-gray-500">Stichwörter:</span> <span className="text-gray-800">{s.query.keywords}</span></div>}
                            {s.query.subjectContains && <div><span className="text-gray-500">Betreff:</span> <span className="text-gray-800">{s.query.subjectContains}</span></div>}
                            {s.query.senderAddresses?.length ? <div><span className="text-gray-500">Absender:</span> <span className="text-gray-800">{s.query.senderAddresses.join(', ')}</span></div> : null}
                            {s.query.recipientAddresses?.length ? <div><span className="text-gray-500">Empfänger:</span> <span className="text-gray-800">{s.query.recipientAddresses.join(', ')}</span></div> : null}
                            {s.query.dateFrom && <div><span className="text-gray-500">Von:</span> <span className="text-gray-800">{new Date(s.query.dateFrom).toLocaleDateString('de-DE')}</span></div>}
                            {s.query.dateTo && <div><span className="text-gray-500">Bis:</span> <span className="text-gray-800">{new Date(s.query.dateTo).toLocaleDateString('de-DE')}</span></div>}
                          </div>
                          {s.exportPath && (
                            <div className="mt-2">
                              <span className="text-xs text-gray-500">Export:</span>
                              <a href={s.exportPath} className="text-xs text-blue-600 hover:underline ml-1">{s.exportPath}</a>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Legal Holds Tab */}
      {tab === 'holds' && (
        <div className="space-y-3">
          {holdLoading ? (
            <p className="text-gray-400 text-center py-12">Laden…</p>
          ) : holds.length === 0 ? (
            <p className="text-gray-400 text-center py-12">Keine Legal Holds vorhanden</p>
          ) : holds.map(h => (
            <div key={h.id} className={`bg-white rounded-lg border p-4 ${h.active ? 'border-red-200' : 'border-gray-200 opacity-60'}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Lock size={14} className={h.active ? 'text-red-500' : 'text-gray-400'} />
                    <span className="font-medium text-gray-900">{h.name}</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      h.active ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {h.active ? 'Aktiv' : 'Aufgehoben'}
                    </span>
                  </div>
                  {h.description && <p className="text-xs text-gray-500 mb-1">{h.description}</p>}
                  <p className="text-xs text-gray-500">
                    {h.mailboxIds.length} Postfächer gesperrt · Aktiviert {fmtDate(h.appliedAt)}
                    {h.releasedAt && ` · Aufgehoben ${fmtDate(h.releasedAt)}`}
                  </p>
                </div>
                {h.active && (
                  <button onClick={() => releaseHold.mutate(h.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50">
                    <Unlock size={12} /> Aufheben
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {createSearch && <CreateSearchModal onClose={() => setCreateSearch(false)} />}
      {createHold && <CreateHoldModal onClose={() => setCreateHold(false)} />}
    </div>
  );
}
