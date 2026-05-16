import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Download, Trash2, Search, CheckCircle2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string;
  timestamp: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId?: string;
  targetName?: string;
  ipAddress?: string;
  success: boolean;
  errorMsg?: string;
  changes?: Record<string, unknown>;
}

interface AuditResponse {
  total: number;
  limit: number;
  offset: number;
  entries: AuditEntry[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDt(iso: string) {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function ActionBadge({ action }: { action: string }) {
  const color = action.startsWith('CREATE') ? 'bg-green-100 text-green-700'
    : action.startsWith('DELETE') ? 'bg-red-100 text-red-700'
    : action.startsWith('UPDATE') || action.startsWith('PUT') ? 'bg-blue-100 text-blue-700'
    : action.startsWith('LOGIN') ? 'bg-purple-100 text-purple-700'
    : 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium ${color}`}>
      {action}
    </span>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

export function AuditLogPage() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState({
    action: '', targetType: '', from: '', to: '', success: '',
  });
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const query = useQuery<AuditResponse>({
    queryKey: ['admin-audit-log', filters, offset],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (filters.action)      params.set('action', filters.action);
      if (filters.targetType)  params.set('targetType', filters.targetType);
      if (filters.from)        params.set('from', new Date(filters.from).toISOString());
      if (filters.to)          params.set('to', new Date(filters.to + 'T23:59:59').toISOString());
      if (filters.success !== '') params.set('success', filters.success);
      return api.get(`/admin/audit-log?${params.toString()}`);
    },
  });

  const purge = useMutation({
    mutationFn: (days: number) => api.delete(`/admin/audit-log/purge?olderThanDays=${days}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-audit-log'] }); toast.success('Einträge gelöscht'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleExport = () => {
    const params = new URLSearchParams();
    if (filters.action)     params.set('action', filters.action);
    if (filters.targetType) params.set('targetType', filters.targetType);
    if (filters.from)       params.set('from', new Date(filters.from).toISOString());
    if (filters.to)         params.set('to', new Date(filters.to + 'T23:59:59').toISOString());
    window.open(`/api/v1/admin/audit-log/export?${params.toString()}`, '_blank');
  };

  const data = query.data;
  const entries = data?.entries ?? [];
  const total   = data?.total ?? 0;
  const pages   = Math.ceil(total / PAGE_SIZE);
  const page    = Math.floor(offset / PAGE_SIZE) + 1;

  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters(f => ({ ...f, [k]: v }));
    setOffset(0);
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ClipboardList size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Audit-Log</h1>
            <p className="text-sm text-gray-500">Alle Admin-Aktionen protokolliert</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50">
            <Download size={14} /> CSV exportieren
          </button>
          <button onClick={() => { if (confirm('Einträge älter als 90 Tage löschen?')) purge.mutate(90); }}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 border border-red-200 rounded hover:bg-red-50">
            <Trash2 size={14} /> Bereinigen
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="flex items-center gap-1.5 bg-white border border-gray-300 rounded px-3 py-1.5">
          <Search size={13} className="text-gray-400" />
          <input value={filters.action} onChange={e => setFilter('action', e.target.value)}
            className="w-36 text-sm focus:outline-none" placeholder="Aktion…" />
        </div>
        <input value={filters.targetType} onChange={e => setFilter('targetType', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-36"
          placeholder="Zieltyp…" />
        <input type="date" value={filters.from} onChange={e => setFilter('from', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
        <input type="date" value={filters.to} onChange={e => setFilter('to', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
        <select value={filters.success} onChange={e => setFilter('success', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
          <option value="">Alle</option>
          <option value="true">Erfolgreich</option>
          <option value="false">Fehlgeschlagen</option>
        </select>
        {(filters.action || filters.targetType || filters.from || filters.to || filters.success) && (
          <button onClick={() => { setFilters({ action: '', targetType: '', from: '', to: '', success: '' }); setOffset(0); }}
            className="px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded hover:bg-gray-50">
            Filter zurücksetzen
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3">Zeitpunkt</th>
              <th className="text-left px-4 py-3">Akteur</th>
              <th className="text-left px-4 py-3">Aktion</th>
              <th className="text-left px-4 py-3">Ziel</th>
              <th className="text-left px-4 py-3">IP</th>
              <th className="text-center px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading ? (
              <tr><td colSpan={6} className="text-center py-12 text-gray-400">Laden…</td></tr>
            ) : entries.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-12 text-gray-400">Keine Einträge gefunden</td></tr>
            ) : entries.map(e => (
              <>
                <tr key={e.id}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}>
                  <td className="px-4 py-2.5 text-xs text-gray-600 whitespace-nowrap">{fmtDt(e.timestamp)}</td>
                  <td className="px-4 py-2.5">
                    <p className="text-gray-900 text-xs font-medium">{e.actorEmail}</p>
                  </td>
                  <td className="px-4 py-2.5"><ActionBadge action={e.action} /></td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">
                    <span className="text-gray-400">{e.targetType}</span>
                    {e.targetName && <span className="ml-1 text-gray-700">{e.targetName}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 font-mono">{e.ipAddress ?? '—'}</td>
                  <td className="px-4 py-2.5 text-center">
                    {e.success
                      ? <CheckCircle2 size={15} className="text-green-500 mx-auto" />
                      : <XCircle size={15} className="text-red-500 mx-auto" />}
                  </td>
                </tr>
                {expandedId === e.id && (
                  <tr key={`${e.id}-detail`}>
                    <td colSpan={6} className="p-0">
                      <div className="bg-gray-50 border-t border-gray-100 px-8 py-3">
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          {e.targetId && <div><span className="text-gray-500">Ziel-ID: </span><span className="font-mono text-gray-700">{e.targetId}</span></div>}
                          {e.actorId && <div><span className="text-gray-500">Akteur-ID: </span><span className="font-mono text-gray-700">{e.actorId}</span></div>}
                          {e.errorMsg && <div className="col-span-3"><span className="text-red-500">Fehler: </span><span className="text-gray-700">{e.errorMsg}</span></div>}
                          {e.changes && Object.keys(e.changes).length > 0 && (
                            <div className="col-span-3">
                              <span className="text-gray-500">Änderungen: </span>
                              <pre className="inline text-gray-700 text-xs">{JSON.stringify(e.changes, null, 2)}</pre>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
            <span>{total.toLocaleString('de-DE')} Einträge · Seite {page} / {pages}</span>
            <div className="flex gap-1">
              <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}
                className="px-3 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">← Zurück</button>
              <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}
                className="px-3 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">Weiter →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
