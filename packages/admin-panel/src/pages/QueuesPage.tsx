import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Inbox, RefreshCw, Trash2, RotateCcw, AlertCircle, Clock, Mail,
  ChevronDown, ChevronRight, Settings, Layers, CheckCircle2, XCircle,
  AlertTriangle, Play, Hourglass, Save,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
import { useT } from '../i18n/useT.js';

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

// ─── Job Table ────────────────────────────────────────────────────────────────

function JobTable({
  jobs, loading, showRetry, showDelete, onRetry, onDelete,
  emptyText,
}: {
  jobs: QueueJob[]; loading: boolean; showRetry?: boolean; showDelete?: boolean;
  onRetry?: (id: string) => void; onDelete?: (id: string) => void;
  emptyText?: string;
}) {
  const t = useT();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <th className="text-left px-4 py-2.5 w-6" />
            <th className="text-left px-4 py-2.5">{t('queue_job_from')}</th>
            <th className="text-left px-4 py-2.5">{t('queue_job_to')}</th>
            <th className="text-left px-4 py-2.5">{t('queue_job_queued')}</th>
            <th className="text-center px-4 py-2.5">{t('queue_job_attempts')}</th>
            {showRetry && <th className="text-left px-4 py-2.5">{t('queue_job_next_retry')}</th>}
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={7} className="text-center py-12 text-gray-400">{t('queue_job_loading')}</td></tr>
          ) : jobs.length === 0 ? (
            <tr>
              <td colSpan={7} className="text-center py-12">
                <CheckCircle2 size={28} className="mx-auto text-gray-300 mb-2" />
                <p className="text-sm text-gray-400">{emptyText ?? t('queue_job_empty')}</p>
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
                    <div className="text-gray-400">{fmtAge(job.createdAt)} {t('queue_job_ago')}</div>
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
                    <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                      {showRetry && onRetry && (
                        <button
                          title={t('queue_retry_now')}
                          onClick={() => onRetry(job.id)}
                          className="px-2 py-1 text-xs text-blue-600 border border-blue-200 rounded hover:bg-blue-50 transition-colors"
                        >
                          <RotateCcw size={11} className="inline mr-1" />
                          {t('queue_retry_now')}
                        </button>
                      )}
                      {showDelete && onDelete && (
                        <button
                          title={t('queue_discard')}
                          onClick={() => onDelete(job.id)}
                          className="px-2 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50 transition-colors"
                        >
                          <Trash2 size={11} className="inline mr-1" />
                          {t('queue_discard')}
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
                          <div><span className="text-gray-500 inline-block w-28">{t('queue_job_jobid')}</span><span className="font-mono text-gray-700">{job.id}</span></div>
                          {job.messageId && <div><span className="text-gray-500 inline-block w-28">{t('queue_job_msgid')}</span><span className="font-mono text-gray-700 truncate">{job.messageId}</span></div>}
                          {job.dkimDomain && <div><span className="text-gray-500 inline-block w-28">{t('queue_job_dkimdomain')}</span><span className="font-mono text-gray-700">{job.dkimDomain}</span></div>}
                          {job.processedAt && <div><span className="text-gray-500 inline-block w-28">{t('queue_job_processed')}</span><span className="text-gray-700">{fmtDt(job.processedAt)}</span></div>}
                          {job.nextRunAt && <div><span className="text-gray-500 inline-block w-28">{t('queue_job_next')}</span><span className="text-gray-700">{fmtDt(job.nextRunAt)}</span></div>}
                          <div><span className="text-gray-500 inline-block w-28">{t('queue_job_recipients')}</span><span className="font-mono text-gray-700">{to}</span></div>
                        </div>
                        {job.failedReason && (
                          <div className="mt-2 p-2.5 bg-red-50 border border-red-100 rounded">
                            <p className="text-red-600 font-medium mb-0.5">{t('queue_job_failed_reason')}</p>
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
  const t = useT();
  const qc = useQueryClient();

  // Fetch all pending jobs for inline overview
  const { data: allJobsData, isLoading: jobsLoading } = useQuery<JobsResponse>({
    queryKey: ['admin-queue-overview-jobs'],
    queryFn:  () => api.get('/admin/queues/jobs?state=all&page=1&limit=25'),
    refetchInterval: 10_000,
  });

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ['admin-queue-overview-jobs'] });
    void qc.invalidateQueries({ queryKey: ['admin-queue-jobs'] });
    void qc.invalidateQueries({ queryKey: ['admin-queue-stats'] });
  };

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/admin/queues/jobs/${id}`),
    onSuccess: () => { invalidateAll(); toast.success(t('queue_msg_deleted')); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const retryMut = useMutation({
    mutationFn: (id: string) => api.post<unknown>(`/admin/queues/jobs/${id}/retry`),
    onSuccess: () => { invalidateAll(); toast.success(t('queue_msg_retried')); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const jobs = allJobsData?.jobs ?? [];
  const totalPending = allJobsData?.total ?? 0;

  // Determine state badge for a job
  function jobStateBadge(job: QueueJob): { label: string; cls: string } {
    if (job.failedReason)                         return { label: t('queue_stat_failed'),  cls: 'bg-red-100 text-red-700' };
    if (job.delay > 0 && !job.processedAt)        return { label: t('queue_stat_retry'),   cls: 'bg-yellow-100 text-yellow-700' };
    if (job.processedAt && !job.finishedAt)       return { label: t('queue_stat_active'),  cls: 'bg-green-100 text-green-700' };
    return                                               { label: t('queue_stat_waiting'), cls: 'bg-blue-100 text-blue-700' };
  }

  const statItems = [
    { label: t('queue_stat_waiting'),   value: stats?.waiting   ?? 0, color: 'text-blue-700',   ring: 'hover:ring-2 hover:ring-blue-200',   click: () => onSectionChange('outbound'),   icon: <Hourglass size={14} /> },
    { label: t('queue_stat_active'),    value: stats?.active    ?? 0, color: 'text-green-700',  ring: 'hover:ring-2 hover:ring-green-200',  click: () => onSectionChange('outbound'),   icon: <Play size={14} /> },
    { label: t('queue_stat_retry'),     value: stats?.delayed   ?? 0, color: 'text-yellow-700', ring: 'hover:ring-2 hover:ring-yellow-200', click: () => onSectionChange('retry'),      icon: <Clock size={14} /> },
    { label: t('queue_stat_failed'),    value: stats?.failed    ?? 0, color: 'text-red-700',    ring: 'hover:ring-2 hover:ring-red-200',    click: () => onSectionChange('deadletter'), icon: <XCircle size={14} /> },
    { label: t('queue_stat_delivered'), value: stats?.completed ?? 0, color: 'text-gray-500',   ring: '',                                  click: undefined,                           icon: <CheckCircle2 size={14} /> },
  ];

  return (
    <div className="space-y-4">

      {/* ── Compact Stats Strip ─────────────────────────────────────── */}
      <div className="grid grid-cols-5 bg-white rounded-xl border border-gray-200 divide-x divide-gray-100 overflow-hidden">
        {statItems.map((s, i) => (
          <button
            key={i}
            onClick={s.click}
            disabled={!s.click}
            className={`flex flex-col items-center justify-center py-4 px-2 transition-all ${s.ring} disabled:cursor-default group`}
          >
            <div className={`flex items-center gap-1.5 ${s.color} mb-1`}>
              {s.icon}
              <span className="text-xl font-bold">{s.value.toLocaleString('de-DE')}</span>
            </div>
            <span className="text-[11px] text-gray-500 group-hover:text-gray-700">{s.label}</span>
          </button>
        ))}
      </div>

      {/* ── Dead-Letter Warning ─────────────────────────────────────── */}
      {(stats?.failed ?? 0) > 0 && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-3">
          <AlertCircle size={15} className="shrink-0 text-red-500 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-red-800">
              {stats!.failed} {t('queue_dead_warning')}
            </p>
            <p className="text-xs text-red-600 mt-0.5">{t('queue_dead_hint')}</p>
          </div>
          <button
            onClick={() => onSectionChange('deadletter')}
            className="shrink-0 text-xs font-medium text-red-700 border border-red-200 rounded px-3 py-1.5 hover:bg-red-100 whitespace-nowrap"
          >
            {t('queue_dead_open')}
          </button>
        </div>
      )}

      {/* ── Pending Messages Table ──────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
          <p className="text-sm font-semibold text-gray-700">{t('queue_overview_pending')}</p>
          <span className="text-xs text-gray-400">{totalPending} {t('queue_messages')}</span>
        </div>

        {jobsLoading ? (
          <div className="py-10 text-center text-sm text-gray-400">{t('queue_job_loading')}</div>
        ) : jobs.length === 0 ? (
          <div className="py-10 text-center">
            <CheckCircle2 size={28} className="mx-auto text-gray-300 mb-2" />
            <p className="text-sm text-gray-400">{t('queue_overview_all_ok')}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100">
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2">{t('queue_job_from')}</th>
                <th className="text-left px-4 py-2">{t('queue_job_to')}</th>
                <th className="text-left px-4 py-2">Alter</th>
                <th className="text-center px-4 py-2">{t('queue_job_attempts')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => {
                const badge = jobStateBadge(job);
                const isFailed  = !!job.failedReason;
                const isDelayed = job.delay > 0 && !job.processedAt;
                const attempts  = `${job.attemptsMade}/${job.maxAttempts}`;
                const attCls    = job.attemptsMade >= job.maxAttempts ? 'bg-red-100 text-red-700'
                  : job.attemptsMade > 2 ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600';
                return (
                  <tr key={job.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium whitespace-nowrap ${badge.cls}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs font-mono text-gray-700 truncate block max-w-[150px]">{job.from ?? '—'}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs font-mono text-gray-700 truncate block max-w-[150px]">{(job.to ?? []).join(', ') || '—'}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{fmtAge(job.createdAt)}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${attCls}`}>{attempts}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5 justify-end">
                        {(isFailed || isDelayed) && (
                          <button
                            onClick={() => retryMut.mutate(job.id)}
                            disabled={retryMut.isPending}
                            className="px-2 py-1 text-xs text-blue-600 border border-blue-200 rounded hover:bg-blue-50 transition-colors disabled:opacity-50"
                          >
                            <RotateCcw size={11} className="inline mr-1" />
                            {t('queue_retry_now')}
                          </button>
                        )}
                        <button
                          onClick={() => { if (confirm(t('queue_discard_confirm'))) deleteMut.mutate(job.id); }}
                          disabled={deleteMut.isPending}
                          className="px-2 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50 transition-colors disabled:opacity-50"
                        >
                          <Trash2 size={11} className="inline mr-1" />
                          {t('queue_discard')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {totalPending > 25 && (
          <div className="px-4 py-2 border-t border-gray-100 text-xs text-gray-400 bg-gray-50 text-center">
            {t('queue_overview_more')} ·&nbsp;
            <button onClick={() => onSectionChange('outbound')} className="text-accent hover:underline">
              {t('queue_section_outbound')}
            </button>
            {' / '}
            <button onClick={() => onSectionChange('retry')} className="text-accent hover:underline">
              {t('queue_section_retry')}
            </button>
            {' / '}
            <button onClick={() => onSectionChange('deadletter')} className="text-accent hover:underline">
              {t('queue_section_deadletter')}
            </button>
          </div>
        )}
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
  const t = useT();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const LIMIT = 50;

  const { data, isLoading } = useQuery<JobsResponse>({
    queryKey: ['admin-queue-jobs', stateFilter, page],
    queryFn:  () => api.get(`/admin/queues/jobs?state=${stateFilter}&page=${page}&limit=${LIMIT}`),
    refetchInterval: 10_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin-queue-jobs'] });
    void qc.invalidateQueries({ queryKey: ['admin-queue-stats'] });
    void qc.invalidateQueries({ queryKey: ['admin-queue-overview-jobs'] });
  };

  const retryMut = useMutation({
    mutationFn: (id: string) => api.post<unknown>(`/admin/queues/jobs/${id}/retry`),
    onSuccess: () => { invalidate(); toast.success(t('queue_msg_retried')); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const retryAllMut = useMutation({
    mutationFn: () => api.post<{ retried: number }>('/admin/queues/retry-failed'),
    onSuccess: (r) => { invalidate(); toast.success(`${r.retried} ${t('queue_msg_retried')}`); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/admin/queues/jobs/${id}`),
    onSuccess: () => { invalidate(); toast.success(t('queue_msg_deleted')); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const flushMut = useMutation({
    mutationFn: () => api.post<unknown>('/admin/queues/flush', { state: stateFilter }),
    onSuccess: () => { invalidate(); toast.success(t('queue_flushed')); },
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
            <span className="text-xs text-gray-400">{total} {t('queue_messages')}</span>
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
              <RotateCcw size={12} /> {t('queue_retry_all')}
            </button>
          )}
          {jobs.length > 0 && (
            <button
              onClick={() => { if (confirm(t('queue_flush_confirm'))) flushMut.mutate(); }}
              disabled={flushMut.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50"
            >
              <Trash2 size={12} /> {t('queue_flush')}
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <JobTable
        jobs={jobs} loading={isLoading}
        showRetry={showRetry} showDelete
        onRetry={id => retryMut.mutate(id)}
        onDelete={id => { if (confirm(t('queue_discard_confirm'))) deleteMut.mutate(id); }}
        emptyText={emptyText}
      />

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{total} {t('queue_messages')} · {t('queue_page_of')} {page} {t('queue_page_slash')} {pages}</span>
          <div className="flex gap-1">
            <button onClick={() => setPage(1)} disabled={page === 1}
              className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">«</button>
            <button onClick={() => setPage(p => p - 1)} disabled={page === 1}
              className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">{t('queue_prev')}</button>
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
              className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">{t('queue_next')}</button>
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
  const t = useT();
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
    onSuccess: (d) => { void qc.invalidateQueries({ queryKey: ['admin-queue-settings'] }); setVals(d); toast.success(t('queue_settings_saved')); },
    onError:   (e: Error) => toast.error(e.message),
  });

  if (isLoading || !vals) return <div className="py-12 text-center text-gray-400 text-sm">{t('action_loading')}</div>;

  const set = (k: keyof QueueSettingsType, v: number | boolean) =>
    setVals(prev => prev ? { ...prev, [k]: v } : prev);

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Retry behaviour */}
      <div className="card p-5">
        <p className="text-sm font-semibold text-gray-700 mb-1">{t('queue_settings_title')}</p>
        <p className="text-xs text-gray-500 mb-4">
          {t('queue_settings_retry_desc')}
        </p>
        <div className="divide-y divide-gray-100">
          <NumInput
            label={t('queue_settings_max_retry')}
            value={vals.maxRetryAttempts}
            onChange={v => set('maxRetryAttempts', v)}
            min={1} max={50} unit={t('queue_unit_attempts')}
            description={t('queue_settings_max_retry_desc')}
          />
          <NumInput
            label={t('queue_settings_backoff')}
            value={vals.retryBackoffDelaySec}
            onChange={v => set('retryBackoffDelaySec', v)}
            min={10} max={3600} unit={t('queue_unit_sec')}
            description={t('queue_settings_backoff_desc')}
          />
        </div>
        {/* Visual example */}
        <div className="mt-4 p-3 bg-gray-50 rounded-lg">
          <p className="text-xs font-medium text-gray-600 mb-2">{t('queue_settings_example')}</p>
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
            {vals.maxRetryAttempts > 6 && <span className="text-xs text-gray-400 px-1 py-1">… +{vals.maxRetryAttempts - 6} {t('queue_settings_more')}</span>}
          </div>
        </div>
      </div>

      {/* Retention */}
      <div className="card p-5">
        <p className="text-sm font-semibold text-gray-700 mb-1">{t('queue_settings_retention')}</p>
        <p className="text-xs text-gray-500 mb-4">
          {t('queue_settings_retention_desc')}
        </p>
        <div className="divide-y divide-gray-100">
          <NumInput
            label={t('queue_settings_dead_ret')}
            value={vals.deadLetterRetentionDays}
            onChange={v => set('deadLetterRetentionDays', v)}
            min={1} max={365} unit={t('queue_unit_days')}
            description={t('queue_settings_dead_ret_desc')}
          />
          <NumInput
            label={t('queue_settings_outbound_ret')}
            value={vals.outboundRetentionHours}
            onChange={v => set('outboundRetentionHours', v)}
            min={1} max={720} unit={t('queue_unit_hours')}
            description={t('queue_settings_outbound_ret_desc')}
          />
          <NumInput
            label={t('queue_settings_completed_ret')}
            value={vals.completedRetentionHours}
            onChange={v => set('completedRetentionHours', v)}
            min={1} max={720} unit={t('queue_unit_hours')}
            description={t('queue_settings_completed_ret_desc')}
          />
        </div>
      </div>

      {/* Auto-flush + Notifications */}
      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-700">{t('queue_settings_automation')}</p>
        <div className="flex items-start justify-between py-2">
          <div>
            <p className="text-sm font-medium text-gray-800">{t('queue_settings_autoflush')}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {t('queue_settings_autoflush_desc')}
            </p>
          </div>
          <Toggle active={vals.autoFlushDead} onToggle={() => set('autoFlushDead', !vals.autoFlushDead)} />
        </div>
        <div className="flex items-start justify-between py-2 border-t border-gray-100">
          <div>
            <p className="text-sm font-medium text-gray-800">{t('queue_settings_notify')}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {t('queue_settings_notify_desc')}
            </p>
          </div>
          <Toggle active={vals.notifyOnDeadLetter} onToggle={() => set('notifyOnDeadLetter', !vals.notifyOnDeadLetter)} />
        </div>
      </div>

      {/* RFC note */}
      <div className="flex gap-2 bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-blue-700">
        <AlertTriangle size={13} className="shrink-0 mt-0.5 text-blue-500" />
        <p>{t('queue_settings_rfc_note')}</p>
      </div>

      <button
        onClick={() => save.mutate(vals!)}
        disabled={save.isPending}
        className="flex items-center gap-2 px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-60"
      >
        <Save size={14} />
        {save.isPending ? t('action_saving') : t('queue_settings_save')}
      </button>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function QueuesPage() {
  const t = useT();
  const [section, setSection] = useState<Section>('overview');
  const qc = useQueryClient();

  const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
    { key: 'overview',    label: t('queue_section_overview'),   icon: <Layers size={14} /> },
    { key: 'outbound',   label: t('queue_section_outbound'),   icon: <Mail size={14} /> },
    { key: 'retry',      label: t('queue_section_retry'),      icon: <RotateCcw size={14} /> },
    { key: 'deadletter', label: t('queue_section_deadletter'), icon: <XCircle size={14} /> },
    { key: 'settings',   label: t('queue_section_settings'),   icon: <Settings size={14} /> },
  ];

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
        <p className="text-[10px] text-gray-500 uppercase tracking-widest px-4 pb-2">{t('queue_nav_section')}</p>
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
          {/* Page header — single Refresh button */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Inbox size={20} className="text-accent" />
              <div>
                <h1 className="text-xl font-semibold text-gray-900">{t('queue_page_title')}</h1>
                <p className="text-xs text-gray-500">
                  {SECTIONS.find(s => s.key === section)?.label} · {t('queue_live_update')}
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                void refetch();
                void qc.refetchQueries({ queryKey: ['admin-queue-jobs'] });
                void qc.refetchQueries({ queryKey: ['admin-queue-stats'] });
                void qc.refetchQueries({ queryKey: ['admin-queue-overview-jobs'] });
              }}
              className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
            >
              <RefreshCw size={13} /> {t('action_refresh')}
            </button>
          </div>

          {/* Section content */}
          {section === 'overview'    && <OverviewSection stats={stats} onSectionChange={setSection} />}
          {section === 'outbound'    && (
            <JobsSection
              stateFilter="waiting"
              title={t('queue_outbound_title')}
              description={t('queue_outbound_desc')}
              badge={t('queue_outbound_badge')}
              emptyText={t('queue_outbound_empty')}
            />
          )}
          {section === 'retry'       && (
            <JobsSection
              stateFilter="delayed"
              title={t('queue_retry_title')}
              description={t('queue_retry_desc')}
              badge={t('queue_retry_badge')}
              emptyText={t('queue_retry_empty')}
              showRetry
            />
          )}
          {section === 'deadletter'  && (
            <JobsSection
              stateFilter="failed"
              title={t('queue_dead_title')}
              description={t('queue_dead_desc')}
              badge={t('queue_dead_badge')}
              emptyText={t('queue_dead_empty')}
              showRetry showRetryAll
            />
          )}
          {section === 'settings'    && <SettingsSection />}
        </div>
      </div>
    </div>
  );
}
