import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Inbox, RefreshCw, Trash2, RotateCcw, AlertCircle, Clock, Mail,
  ChevronDown, ChevronRight, Settings, Layers, CheckCircle2, XCircle,
  AlertTriangle, Play, Hourglass, Save,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';

// ─── Types ────────────────────────────────────────────────────────────────────

interface QueueStats {
  waiting:   number;
  active:    number;
  delayed:   number;
  failed:    number;
  completed: number;
  timestamp: string;
}

interface QueueJob {
  id:           string;
  name:         string;
  messageId?:   string;
  from?:        string;
  to?:          string[];
  attemptsMade: number;
  maxAttempts:  number;
  createdAt:    string;
  processedAt?: string;
  finishedAt?:  string;
  delay:        number;
  nextRunAt?:   string;
  failedReason?: string;
  stacktrace?:  string[];
  dkimDomain?:  string;
}

interface JobsResponse {
  jobs:   QueueJob[];
  total:  number;
  page:   number;
  limit:  number;
  counts: QueueStats;
}

interface QueueSettingsType {
  maxRetryAttempts:        number;
  retryBackoffDelaySec:    number;
  deadLetterRetentionDays: number;
  outboundRetentionHours:  number;
  completedRetentionHours: number;
  autoFlushDead:           boolean;
  notifyOnDeadLetter:      boolean;
}

// ─── Sub-Navigation ───────────────────────────────────────────────────────────

type Section = 'overview' | 'outbound' | 'retry' | 'deadletter' | 'settings';

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'overview',    label: 'Übersicht',    icon: <Layers size={14} /> },
  { key: 'outbound',   label: 'Ausgehend',     icon: <Mail size={14} /> },
  { key: 'retry',      label: 'Wiederholung',  icon: <RotateCcw size={14} /> },
  { key: 'deadletter', label: 'Dead Letter',   icon: <XCircle size={14} /> },
  { key: 'settings',   label: 'Einstellungen', icon: <Settings size={14} /> },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDt(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtAge(iso?: string) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function NumInput({
  label, value, onChange, min, max, unit, description,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; unit?: string; description?: string;
}) {
  return (
    <div className="flex items-start justify-between py-3 border-b border-gray-100 last:border-0">
      <div>
        <p className="text-sm font-medium text-gray-800">{label}</p>
        {description && <p className="text-xs text-gray-500 mt-0.5 max-w-md">{description}</p>}
      </div>
      <div className="flex items-center gap-2 ml-4">
        <input
          type="number" min={min} max={max} value={value}
          onChange={e => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || min)))}
          className="w-20 text-right border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {unit && <span className="text-xs text-gray-500 w-10">{unit}</span>}
      </div>
    </div>
  );
}

// ─── Sparkline component ──────────────────────────────────────────────────────

function Sparkbar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  label, value, icon, color, onClick, active,
}: {
  label: string; value: number; icon: React.ReactNode;
  color: string; onClick?: () => void; active?: boolean;
}) {
  const colors: Record<string, { bg: string; text: string; border: string; bar: string }> = {
    blue:   { bg: 'bg-blue-50',   text: 'text-blue-700',   border: 'border-blue-200',   bar: 'bg-blue-400' },
    green:  { bg: 'bg-green-50',  text: 'text-green-700',  border: 'border-green-200',  bar: 'bg-green-400' },
    yellow: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200', bar: 'bg-yellow-400' },
    red:    { bg: 'bg-red-50',    text: 'text-red-700',    border: 'border-red-200',    bar: 'bg-red-400' },
    gray:   { bg: 'bg-gray-50',   text: 'text-gray-600',   border: 'border-gray-200',   bar: 'bg-gray-300' },
  };
  const c = colors[color] ?? colors.gray;
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-xl border p-4 transition-all hover:shadow-md w-full ${c.bg} ${c.border} ${
        active ? 'ring-2 ring-accent ring-offset-1' : ''
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${c.bg} ${c.text}`}>{icon}</div>
        <span className={`text-2xl font-bold ${c.text}`}>{value.toLocaleString('de-DE')}</span>
      </div>
      <p className="text-xs font-semibold text-gray-600">{label}</p>
    </button>
  );
}

// ─── Job Table ────────────────────────────────────────────────────────────────

function JobTable({
  jobs, loading, showRetry, showDelete, onRetry, onDelete,
  emptyText = 'Keine Nachrichten',
}: {
  jobs: QueueJob[]; loading: boolean; showRetry?: boolean; showDelete?: boolean;
  onRetry?: (id: string) => void; onDelete?: (id: string) => void;
  emptyText?: string;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <th className="text-left px-4 py-2.5 w-6" />
            <th className="text-left px-4 py-2.5">Absender</th>
            <th className="text-left px-4 py-2.5">Empfänger</th>
            <th className="text-left px-4 py-2.5">Eingestellt</th>
            <th className="text-center px-4 py-2.5">Versuche</th>
            {showRetry && <th className="text-left px-4 py-2.5">Nächster Versuch</th>}
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={7} className="text-center py-12 text-gray-400">Laden…</td></tr>
          ) : jobs.length === 0 ? (
            <tr>
              <td colSpan={7} className="text-center py-12">
                <CheckCircle2 size={28} className="mx-auto text-gray-300 mb-2" />
                <p className="text-sm text-gray-400">{emptyText}</p>
              </td>
            </tr>
          ) : jobs.map(job => {
            const isExpanded = expandedId === job.id;
            const from = job.from ?? '—';
            const to   = (job.to ?? []).join(', ') || '—';
            const attempts = `${job.attemptsMade} / ${job.maxAttempts}`;
            const attemptsColor = job.attemptsMade >= job.maxAttempts ? 'bg-red-100 text-red-700'
              : job.attemptsMade > 2 ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600';
            return (
              <>
                <tr
                  key={job.id}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : job.id)}
                >
                  <td className="px-4 py-3 text-gray-400">
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <Mail size={11} className="text-gray-400 shrink-0" />
                      <span className="text-xs font-mono text-gray-700 truncate max-w-[160px]">{from}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-gray-700 truncate max-w-[160px]">{to}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                    <div>{fmtDt(job.createdAt)}</div>
                    <div className="text-gray-400">{fmtAge(job.createdAt)} her</div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${attemptsColor}`}>
                      {attempts}
                    </span>
                  </td>
                  {showRetry && (
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {job.nextRunAt ? fmtDt(job.nextRunAt) : '—'}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {showRetry && onRetry && (
                        <button
                          title="Jetzt wiederholen"
                          onClick={e => { e.stopPropagation(); onRetry(job.id); }}
                          className="p-1 text-gray-400 hover:text-blue-600 transition-colors"
                        >
                          <RotateCcw size={13} />
                        </button>
                      )}
                      {showDelete && onDelete && (
                        <button
                          title="Löschen"
                          onClick={e => { e.stopPropagation(); onDelete(job.id); }}
                          className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {isExpanded && (
                  <tr key={`${job.id}-detail`}>
                    <td colSpan={7} className="p-0">
                      <div className="bg-gray-50 border-t border-gray-100 px-8 py-4 space-y-2 text-xs">
                        <div className="grid grid-cols-2 gap-x-8 gap-y-1.5">
                          <div><span className="text-gray-500 inline-block w-28">Job-ID:</span><span className="font-mono text-gray-700">{job.id}</span></div>
                          {job.messageId && <div><span className="text-gray-500 inline-block w-28">Message-ID:</span><span className="font-mono text-gray-700 truncate">{job.messageId}</span></div>}
                          {job.dkimDomain && <div><span className="text-gray-500 inline-block w-28">DKIM-Domain:</span><span className="font-mono text-gray-700">{job.dkimDomain}</span></div>}
                          {job.processedAt && <div><span className="text-gray-500 inline-block w-28">Verarbeitet:</span><span className="text-gray-700">{fmtDt(job.processedAt)}</span></div>}
                          {job.nextRunAt && <div><span className="text-gray-500 inline-block w-28">Nächster Versuch:</span><span className="text-gray-700">{fmtDt(job.nextRunAt)}</span></div>}
                          <div><span className="text-gray-500 inline-block w-28">An:</span><span className="font-mono text-gray-700">{to}</span></div>
                        </div>
                        {job.failedReason && (
                          <div className="mt-2 p-2.5 bg-red-50 border border-red-100 rounded">
                            <p className="text-red-600 font-medium mb-0.5">Fehlerursache:</p>
                            <p className="text-red-700 font-mono">{job.failedReason}</p>
                          </div>
                        )}
                        {(job.stacktrace ?? []).length > 0 && (
                          <pre className="mt-1 p-2 bg-gray-900 text-gray-300 rounded text-[11px] overflow-auto max-h-28 leading-relaxed">
                            {job.stacktrace?.join('\n')}
                          </pre>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Overview Section ─────────────────────────────────────────────────────────

function OverviewSection({
  stats, onSectionChange,
}: {
  stats?: QueueStats; onSectionChange: (s: Section) => void;
}) {
  const total = (stats?.waiting ?? 0) + (stats?.active ?? 0) + (stats?.delayed ?? 0);
  const maxBar = Math.max(stats?.waiting ?? 0, stats?.active ?? 0, stats?.delayed ?? 0, stats?.failed ?? 0, 1);

  return (
    <div className="space-y-6">
      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard label="Wartend"      value={stats?.waiting   ?? 0} color="blue"   icon={<Hourglass size={16} />} onClick={() => onSectionChange('outbound')} />
        <StatCard label="Aktiv"        value={stats?.active    ?? 0} color="green"  icon={<Play size={16} />}      onClick={() => onSectionChange('outbound')} />
        <StatCard label="Wiederholung" value={stats?.delayed   ?? 0} color="yellow" icon={<Clock size={16} />}     onClick={() => onSectionChange('retry')} />
        <StatCard label="Dead Letter"  value={stats?.failed    ?? 0} color="red"    icon={<XCircle size={16} />}   onClick={() => onSectionChange('deadletter')} />
        <StatCard label="Zugestellt"   value={stats?.completed ?? 0} color="gray"   icon={<CheckCircle2 size={16} />} />
      </div>

      {/* Dead-letter warning */}
      {(stats?.failed ?? 0) > 0 && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-4">
          <AlertCircle size={16} className="shrink-0 text-red-500 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-red-800">
              {stats!.failed} Nachricht{stats!.failed !== 1 ? 'en' : ''} dauerhaft nicht zustellbar
            </p>
            <p className="text-xs text-red-600 mt-0.5">
              Diese Nachrichten befinden sich in der Dead-Letter-Queue. Ursache prüfen und ggf. manuell wiederholen.
            </p>
          </div>
          <button
            onClick={() => onSectionChange('deadletter')}
            className="shrink-0 text-xs font-medium text-red-700 border border-red-200 rounded px-3 py-1.5 hover:bg-red-100"
          >
            Öffnen →
          </button>
        </div>
      )}

      {/* Queue distribution */}
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-700">Queue-Verteilung</p>
          <p className="text-xs text-gray-400">{total} ausstehend gesamt</p>
        </div>
        <div className="space-y-3">
          {[
            { label: 'Wartend',       value: stats?.waiting ?? 0,   bar: 'bg-blue-400' },
            { label: 'Aktiv',         value: stats?.active ?? 0,    bar: 'bg-green-400' },
            { label: 'Wiederholung',  value: stats?.delayed ?? 0,   bar: 'bg-yellow-400' },
            { label: 'Dead Letter',   value: stats?.failed ?? 0,    bar: 'bg-red-400' },
          ].map(row => (
            <div key={row.label} className="flex items-center gap-3">
              <span className="text-xs text-gray-500 w-28">{row.label}</span>
              <div className="flex-1">
                <Sparkbar value={row.value} max={maxBar} color={row.bar} />
              </div>
              <span className="text-xs font-semibold text-gray-700 w-8 text-right">{row.value}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 pt-1 border-t border-gray-100">
          Zuletzt aktualisiert: {stats ? fmtDt(stats.timestamp) : '—'}
        </p>
      </div>

      {/* State explanation */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { icon: <Hourglass size={15} className="text-blue-500" />,  title: 'Wartend',      text: 'Nachrichten, die auf einen freien Worker-Slot warten und bereit zur Zustellung sind.' },
          { icon: <Play size={15} className="text-green-500" />,       title: 'Aktiv',        text: 'Nachrichten, die gerade über SMTP zugestellt werden (laufende Verbindung).' },
          { icon: <Clock size={15} className="text-yellow-500" />,     title: 'Wiederholung', text: 'Fehlgeschlagene Versuche mit exponential Backoff — werden automatisch neu versucht.' },
          { icon: <XCircle size={15} className="text-red-500" />,      title: 'Dead Letter',  text: 'Alle Retry-Versuche erschöpft. Manuelle Freigabe oder Löschen erforderlich.' },
        ].map(c => (
          <div key={c.title} className="card p-4 flex gap-3">
            <div className="shrink-0 mt-0.5">{c.icon}</div>
            <div>
              <p className="text-sm font-semibold text-gray-800">{c.title}</p>
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{c.text}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Jobs Section (Ausgehend / Retry / Dead Letter) ───────────────────────────

function JobsSection({
  stateFilter, title, description, badge, emptyText, showRetry = false, showRetryAll = false,
}: {
  stateFilter: string; title: string; description: string; badge?: string;
  emptyText?: string; showRetry?: boolean; showRetryAll?: boolean;
}) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const LIMIT = 50;

  const { data, isLoading, refetch } = useQuery<JobsResponse>({
    queryKey: ['admin-queue-jobs', stateFilter, page],
    queryFn:  () => api.get(`/admin/queues/jobs?state=${stateFilter}&page=${page}&limit=${LIMIT}`),
    refetchInterval: 10_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin-queue-jobs'] });
    void qc.invalidateQueries({ queryKey: ['admin-queue-stats'] });
  };

  const retryMut = useMutation({
    mutationFn: (id: string) => api.post<unknown>(`/admin/queues/jobs/${id}/retry`),
    onSuccess: () => { invalidate(); toast.success('Nachricht zur Wiederholung eingestellt'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const retryAllMut = useMutation({
    mutationFn: () => api.post<{ retried: number }>('/admin/queues/retry-failed'),
    onSuccess: (r) => { invalidate(); toast.success(`${r.retried} Nachricht${r.retried !== 1 ? 'en' : ''} zur Wiederholung eingestellt`); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/admin/queues/jobs/${id}`),
    onSuccess: () => { invalidate(); toast.success('Nachricht gelöscht'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const flushMut = useMutation({
    mutationFn: () => api.post<unknown>('/admin/queues/flush', { state: stateFilter }),
    onSuccess: () => { invalidate(); toast.success('Queue geleert'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const jobs  = data?.jobs  ?? [];
  const total = data?.total ?? 0;
  const pages = Math.ceil(total / LIMIT);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
            {badge && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{badge}</span>}
            <span className="text-xs text-gray-400">{total} Nachrichten</span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          {showRetryAll && jobs.length > 0 && (
            <button
              onClick={() => retryAllMut.mutate()}
              disabled={retryAllMut.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-blue-700 border border-blue-200 rounded hover:bg-blue-50"
            >
              <RotateCcw size={12} /> Alle wiederholen
            </button>
          )}
          {jobs.length > 0 && (
            <button
              onClick={() => { if (confirm(`Queue „${title}" komplett leeren?`)) flushMut.mutate(); }}
              disabled={flushMut.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50"
            >
              <Trash2 size={12} /> Queue leeren
            </button>
          )}
          <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded hover:bg-gray-50">
            <RefreshCw size={12} /> Aktualisieren
          </button>
        </div>
      </div>

      {/* Table */}
      <JobTable
        jobs={jobs} loading={isLoading}
        showRetry={showRetry} showDelete
        onRetry={id => retryMut.mutate(id)}
        onDelete={id => { if (confirm('Nachricht aus Queue löschen?')) deleteMut.mutate(id); }}
        emptyText={emptyText}
      />

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{total} Nachrichten · Seite {page} / {pages}</span>
          <div className="flex gap-1">
            <button onClick={() => setPage(1)} disabled={page === 1}
              className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">«</button>
            <button onClick={() => setPage(p => p - 1)} disabled={page === 1}
              className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">‹ Zurück</button>
            {Array.from({ length: Math.min(5, pages) }, (_, i) => {
              const p = page <= 3 ? i + 1 : page + i - 2;
              if (p < 1 || p > pages) return null;
              return (
                <button key={p} onClick={() => setPage(p)}
                  className={`px-2 py-1 border rounded ${p === page ? 'border-accent bg-accent/10 text-accent font-semibold' : 'border-gray-200 hover:bg-gray-50'}`}>
                  {p}
                </button>
              );
            })}
            <button onClick={() => setPage(p => p + 1)} disabled={page === pages}
              className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">Weiter ›</button>
            <button onClick={() => setPage(pages)} disabled={page === pages}
              className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">»</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Settings Section ─────────────────────────────────────────────────────────

function SettingsSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<QueueSettingsType>({
    queryKey: ['admin-queue-settings'],
    queryFn:  () => api.get('/admin/queues/settings'),
  });

  const [vals, setVals] = useState<QueueSettingsType | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (data && !loaded.current) { setVals(data); loaded.current = true; }
  }, [data]);

  const save = useMutation({
    mutationFn: (v: QueueSettingsType) => api.put<QueueSettingsType>('/admin/queues/settings', v),
    onSuccess: (d) => { void qc.invalidateQueries({ queryKey: ['admin-queue-settings'] }); setVals(d); toast.success('Einstellungen gespeichert'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  if (isLoading || !vals) return <div className="py-12 text-center text-gray-400 text-sm">Laden…</div>;

  const set = (k: keyof QueueSettingsType, v: number | boolean) =>
    setVals(prev => prev ? { ...prev, [k]: v } : prev);

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Retry behaviour */}
      <div className="card p-5">
        <p className="text-sm font-semibold text-gray-700 mb-1">Retry-Verhalten</p>
        <p className="text-xs text-gray-500 mb-4">
          Bei einem Zustellfehler wird die Nachricht mit exponentiellem Backoff erneut versucht.
          Nach Erschöpfen aller Versuche wandert sie in die Dead-Letter-Queue.
        </p>
        <div className="divide-y divide-gray-100">
          <NumInput
            label="Max. Wiederholungsversuche"
            value={vals.maxRetryAttempts}
            onChange={v => set('maxRetryAttempts', v)}
            min={1} max={50} unit="Versuche"
            description="Anzahl der Gesamtversuche inkl. Erstversuch. Danach → Dead Letter."
          />
          <NumInput
            label="Basis-Backoff-Delay"
            value={vals.retryBackoffDelaySec}
            onChange={v => set('retryBackoffDelaySec', v)}
            min={10} max={3600} unit="Sek."
            description="Initiale Wartezeit vor dem ersten Retry. Jeder weitere Versuch verdoppelt die Wartezeit (exponential backoff)."
          />
        </div>
        {/* Visual example */}
        <div className="mt-4 p-3 bg-gray-50 rounded-lg">
          <p className="text-xs font-medium text-gray-600 mb-2">Beispiel-Zeitplan (Versuch → Wartezeit):</p>
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: Math.min(vals.maxRetryAttempts, 6) }, (_, i) => {
              const delay = vals.retryBackoffDelaySec * Math.pow(2, i);
              const label = delay >= 3600 ? `${(delay/3600).toFixed(1)}h` : delay >= 60 ? `${Math.round(delay/60)}min` : `${delay}s`;
              return (
                <span key={i} className="text-xs px-2 py-1 bg-white border border-gray-200 rounded">
                  #{i + 2}: +{label}
                </span>
              );
            })}
            {vals.maxRetryAttempts > 6 && <span className="text-xs text-gray-400 px-1 py-1">… +{vals.maxRetryAttempts - 6} weitere</span>}
          </div>
        </div>
      </div>

      {/* Retention */}
      <div className="card p-5">
        <p className="text-sm font-semibold text-gray-700 mb-1">Aufbewahrungsfristen</p>
        <p className="text-xs text-gray-500 mb-4">
          Bestimmt, wie lange Nachrichten in den verschiedenen Queues aufbewahrt werden, bevor sie automatisch bereinigt werden.
        </p>
        <div className="divide-y divide-gray-100">
          <NumInput
            label="Dead-Letter-Aufbewahrung"
            value={vals.deadLetterRetentionDays}
            onChange={v => set('deadLetterRetentionDays', v)}
            min={1} max={365} unit="Tage"
            description="Dauerhaft nicht zustellbare Nachrichten bleiben für diese Dauer in der Dead-Letter-Queue sichtbar."
          />
          <NumInput
            label="Ausgehende Queue"
            value={vals.outboundRetentionHours}
            onChange={v => set('outboundRetentionHours', v)}
            min={1} max={720} unit="Stunden"
            description="Nachrichten in der ausgehenden Queue werden spätestens nach dieser Zeit aus dem System entfernt."
          />
          <NumInput
            label="Zugestellte Nachrichten"
            value={vals.completedRetentionHours}
            onChange={v => set('completedRetentionHours', v)}
            min={1} max={720} unit="Stunden"
            description="Erfolgreich zugestellte Nachrichten für Queue-History sichtbar halten (max. 100 Einträge)."
          />
        </div>
      </div>

      {/* Auto-flush + Notifications */}
      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-700">Automatisierung</p>
        <div className="flex items-start justify-between py-2">
          <div>
            <p className="text-sm font-medium text-gray-800">Dead Letter automatisch bereinigen</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Nachrichten in der Dead-Letter-Queue werden nach Ablauf der Aufbewahrungsfrist automatisch gelöscht.
            </p>
          </div>
          <button
            onClick={() => set('autoFlushDead', !vals.autoFlushDead)}
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ml-4 mt-0.5 ${
              vals.autoFlushDead ? 'bg-accent' : 'bg-gray-300'
            }`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${
              vals.autoFlushDead ? 'translate-x-4' : 'translate-x-0.5'
            }`} />
          </button>
        </div>
        <div className="flex items-start justify-between py-2 border-t border-gray-100">
          <div>
            <p className="text-sm font-medium text-gray-800">Warnung bei neuen Dead Letters</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Zeigt eine Warnmeldung in der Übersicht an, wenn neue Nachrichten in die Dead-Letter-Queue wandern.
            </p>
          </div>
          <button
            onClick={() => set('notifyOnDeadLetter', !vals.notifyOnDeadLetter)}
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ml-4 mt-0.5 ${
              vals.notifyOnDeadLetter ? 'bg-accent' : 'bg-gray-300'
            }`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${
              vals.notifyOnDeadLetter ? 'translate-x-4' : 'translate-x-0.5'
            }`} />
          </button>
        </div>
      </div>

      {/* RFC note */}
      <div className="flex gap-2 bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-blue-700">
        <AlertTriangle size={13} className="shrink-0 mt-0.5 text-blue-500" />
        <p>
          <strong>RFC 5321 § 4.5.4.1</strong>: SMTP-Server müssen Zustellversuche mindestens 4–5 Tage lang wiederholen.
          Die empfohlene Mindest-Aufbewahrung für ausgehende Mails beträgt daher <strong>120 Stunden</strong> (5 Tage).
        </p>
      </div>

      <button
        onClick={() => save.mutate(vals!)}
        disabled={save.isPending}
        className="flex items-center gap-2 px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-60"
      >
        <Save size={14} />
        {save.isPending ? 'Speichern…' : 'Einstellungen speichern'}
      </button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function QueuesPage() {
  const [section, setSection] = useState<Section>('overview');
  const qc = useQueryClient();

  const { data: stats, refetch } = useQuery<QueueStats>({
    queryKey: ['admin-queue-stats'],
    queryFn:  () => api.get('/admin/queues/stats'),
    refetchInterval: 5_000,
  });

  const deadCount = stats?.failed ?? 0;

  return (
    <div className="h-full flex">
      {/* ── Left sub-nav ──────────────────────────────────────────────── */}
      <nav className="w-44 shrink-0 bg-[#1e2433] flex flex-col py-4 gap-0.5 overflow-y-auto">
        <p className="text-[10px] text-gray-500 uppercase tracking-widest px-4 pb-2">Warteschlangen</p>
        {SECTIONS.map(s => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`flex items-center gap-2 px-4 py-2 text-sm text-left transition-colors relative ${
              section === s.key
                ? 'bg-white/10 text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            {s.icon}
            <span>{s.label}</span>
            {s.key === 'deadletter' && deadCount > 0 && (
              <span className="ml-auto text-[10px] bg-red-500 text-white rounded-full px-1.5 py-0.5 font-bold leading-none">
                {deadCount > 99 ? '99+' : deadCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* ── Content ───────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-5xl">
          {/* Page header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Inbox size={20} className="text-accent" />
              <div>
                <h1 className="text-xl font-semibold text-gray-900">SMTP-Warteschlangen</h1>
                <p className="text-xs text-gray-500">
                  {SECTIONS.find(s => s.key === section)?.label} · Live-Aktualisierung alle 5 s
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                void refetch();
                void qc.invalidateQueries({ queryKey: ['admin-queue-jobs'] });
              }}
              className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
            >
              <RefreshCw size={13} /> Aktualisieren
            </button>
          </div>

          {/* Section content */}
          {section === 'overview'    && <OverviewSection stats={stats} onSectionChange={setSection} />}
          {section === 'outbound'    && (
            <JobsSection
              stateFilter="waiting"
              title="Ausgehende Nachrichten"
              description="Nachrichten, die auf Zustellung warten oder gerade aktiv zugestellt werden."
              badge="Wartend + Aktiv"
              emptyText="Keine Nachrichten in der ausgehenden Queue"
            />
          )}
          {section === 'retry'       && (
            <JobsSection
              stateFilter="delayed"
              title="Wiederholungsversuche"
              description="Fehlgeschlagene Nachrichten mit Backoff-Verzögerung — werden automatisch erneut versucht."
              badge="Exponential Backoff"
              emptyText="Keine Nachrichten in der Retry-Queue"
              showRetry
            />
          )}
          {section === 'deadletter'  && (
            <JobsSection
              stateFilter="failed"
              title="Dead-Letter-Queue"
              description="Alle Retry-Versuche erschöpft. Nachrichten manuell wiederholen oder dauerhaft löschen."
              badge="Manueller Eingriff erforderlich"
              emptyText="Keine Dead-Letter-Nachrichten — alles in Ordnung!"
              showRetry showRetryAll
            />
          )}
          {section === 'settings'    && <SettingsSection />}
        </div>
      </div>
    </div>
  );
}
