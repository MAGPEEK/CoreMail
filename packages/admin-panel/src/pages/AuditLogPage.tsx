import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ClipboardList, Download, FileText, Search,
  CheckCircle2, XCircle, Info, X,
  Activity, AlertTriangle, Users, BarChart3,
} from 'lucide-react';
import { api, exportUrl } from '../api/client.js';
import { useT } from '../i18n/useT.js';

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
  userAgent?: string;
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

interface AuditStats {
  totalEntries: number;
  last24h: number;
  last7d: number;
  topActors: { actorEmail: string; count: number }[];
  topActions: { action: string; count: number }[];
  failureRate: number;
  oldestEntry: string | null;
  newestEntry: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDt(iso: string) {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** Convert a YYYY-MM-DD value to ISO at start-of-day UTC. */
function dateFromIso(d: string): string {
  return new Date(d + 'T00:00:00.000Z').toISOString();
}
/** Convert a YYYY-MM-DD value to ISO at end-of-day UTC. */
function dateToIso(d: string): string {
  return new Date(d + 'T23:59:59.999Z').toISOString();
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

function KpiCard({
  icon: Icon, label, value, accent,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
        <Icon size={16} className={accent} />
      </div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function TopList({
  title, icon: Icon, items, valueColor = 'bg-blue-500',
}: {
  title: string;
  icon: typeof Users;
  items: { label: string; count: number }[];
  valueColor?: string;
}) {
  const max = items.length > 0 ? items[0]!.count : 1;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-gray-400">—</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => (
            <div key={it.label} className="flex items-center gap-2 text-xs">
              <div className="w-44 truncate text-gray-700" title={it.label}>{it.label || '(unknown)'}</div>
              <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                <div
                  className={`${valueColor} h-full`}
                  style={{ width: `${Math.max(2, (it.count / max) * 100)}%` }}
                />
              </div>
              <div className="w-10 text-right font-mono text-gray-600">{it.count}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
const DISMISS_KEY = 'coremail:audit-immutable-notice-dismissed';

export function AuditLogPage() {
  const t = useT();
  const [filters, setFilters] = useState({
    action: '', targetType: '', from: '', to: '', success: '',
    actorEmail: '', ipAddress: '', searchText: '',
  });
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });

  // ─── Build URLSearchParams from current filters (used by list + exports)
  const buildParams = (extra?: Record<string, string>): URLSearchParams => {
    const p = new URLSearchParams(extra ?? {});
    if (filters.action)      p.set('action', filters.action);
    if (filters.targetType)  p.set('targetType', filters.targetType);
    if (filters.actorEmail)  p.set('actorEmail', filters.actorEmail);
    if (filters.ipAddress)   p.set('ipAddress', filters.ipAddress);
    if (filters.searchText)  p.set('searchText', filters.searchText);
    if (filters.from)        p.set('from', dateFromIso(filters.from));
    if (filters.to)          p.set('to', dateToIso(filters.to));
    if (filters.success !== '') p.set('success', filters.success);
    return p;
  };

  const query = useQuery<AuditResponse>({
    queryKey: ['admin-audit-log', filters, offset],
    queryFn: () => {
      const params = buildParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      return api.get(`/admin/audit-log?${params.toString()}`);
    },
  });

  const stats = useQuery<AuditStats>({
    queryKey: ['admin-audit-log-stats'],
    queryFn: () => api.get('/admin/audit-log/stats'),
    refetchInterval: 30_000,
  });

  const handleExport = (format: 'csv' | 'pdf') => {
    const params = buildParams();
    const url = exportUrl(`/admin/audit-log/export.${format}`, params);
    window.open(url, '_blank');
  };

  const dismissNotice = () => {
    setNoticeDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
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

  const hasAnyFilter =
    filters.action || filters.targetType || filters.from || filters.to ||
    filters.success || filters.actorEmail || filters.ipAddress || filters.searchText;

  const s = stats.data;

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
          <button onClick={() => handleExport('csv')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50">
            <Download size={14} /> {t('audit_export_csv')}
          </button>
          <button onClick={() => handleExport('pdf')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50">
            <FileText size={14} /> {t('audit_export_pdf')}
          </button>
        </div>
      </div>

      {/* Immutability notice */}
      {!noticeDismissed && (
        <div className="mb-4 flex items-start gap-2 bg-blue-50 border border-blue-200 text-blue-900 rounded px-3 py-2 text-xs">
          <Info size={14} className="text-blue-500 shrink-0 mt-0.5" />
          <span className="flex-1">{t('audit_immutable_notice')}</span>
          <button onClick={dismissNotice} className="text-blue-500 hover:text-blue-700" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Statistics dashboard */}
      {s && (
        <div className="mb-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard icon={Activity}      label={t('audit_stat_total')}        value={s.totalEntries.toLocaleString('de-DE')} accent="text-gray-400" />
            <KpiCard icon={Activity}      label={t('audit_stat_24h')}          value={s.last24h.toLocaleString('de-DE')}      accent="text-blue-500" />
            <KpiCard icon={Activity}      label={t('audit_stat_7d')}           value={s.last7d.toLocaleString('de-DE')}       accent="text-indigo-500" />
            <KpiCard icon={AlertTriangle} label={t('audit_stat_failure_rate')} value={`${(s.failureRate * 100).toFixed(2)}%`} accent="text-red-500" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <TopList
              title={t('audit_top_actors')}
              icon={Users}
              items={s.topActors.map(a => ({ label: a.actorEmail, count: a.count }))}
              valueColor="bg-blue-500"
            />
            <TopList
              title={t('audit_top_actions')}
              icon={BarChart3}
              items={s.topActions.map(a => ({ label: a.action, count: a.count }))}
              valueColor="bg-indigo-500"
            />
          </div>
        </div>
      )}

      {/* Filters — row 1 */}
      <div className="flex flex-wrap gap-2 mb-2">
        <div className="flex items-center gap-1.5 bg-white border border-gray-300 rounded px-3 py-1.5">
          <Search size={13} className="text-gray-400" />
          <input value={filters.searchText} onChange={e => setFilter('searchText', e.target.value)}
            className="w-56 text-sm focus:outline-none" placeholder={t('audit_filter_search')} />
        </div>
        <input value={filters.action} onChange={e => setFilter('action', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-36"
          placeholder="Aktion…" />
        <input value={filters.targetType} onChange={e => setFilter('targetType', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-36"
          placeholder="Zieltyp…" />
        <select value={filters.success} onChange={e => setFilter('success', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
          <option value="">Alle</option>
          <option value="true">Erfolgreich</option>
          <option value="false">Fehlgeschlagen</option>
        </select>
      </div>

      {/* Filters — row 2 */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input value={filters.actorEmail} onChange={e => setFilter('actorEmail', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-56"
          placeholder={t('audit_filter_actor_email')} />
        <input value={filters.ipAddress} onChange={e => setFilter('ipAddress', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-44"
          placeholder={t('audit_filter_ip')} />
        <input type="date" value={filters.from} onChange={e => setFilter('from', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
        <input type="date" value={filters.to} onChange={e => setFilter('to', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
        {hasAnyFilter && (
          <button
            onClick={() => {
              setFilters({
                action: '', targetType: '', from: '', to: '', success: '',
                actorEmail: '', ipAddress: '', searchText: '',
              });
              setOffset(0);
            }}
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
              <React.Fragment key={e.id}>
                <tr
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
                  <tr>
                    <td colSpan={6} className="p-0">
                      <div className="bg-gray-50 border-t border-gray-100 px-8 py-3">
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          {e.targetId && <div><span className="text-gray-500">Ziel-ID: </span><span className="font-mono text-gray-700">{e.targetId}</span></div>}
                          {e.actorId && <div><span className="text-gray-500">Akteur-ID: </span><span className="font-mono text-gray-700">{e.actorId}</span></div>}
                          {e.userAgent && (
                            <div className="col-span-3">
                              <span className="text-gray-500">User-Agent: </span>
                              <span className="font-mono text-gray-700 break-all">{e.userAgent}</span>
                            </div>
                          )}
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
              </React.Fragment>
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
