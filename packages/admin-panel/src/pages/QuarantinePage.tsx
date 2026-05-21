import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ShieldAlert, CheckCircle, Trash2, Loader2, Bug, AlertTriangle,
  FileWarning, X, Search, RefreshCw, Mail, Calendar,
  User, ArrowRight, Eye, ChevronLeft, ChevronRight,
  Info, Clock, Download,
} from 'lucide-react';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type Reason = 'VIRUS' | 'SPAM' | 'POLICY';

interface QuarantineItem {
  id: string;
  messageId: string | null;
  fromAddr: string;
  toAddr: string;
  subject: string;
  reason: Reason;
  details: Record<string, unknown>;
  released: boolean;
  releasedAt: string | null;
  releasedBy: string | null;
  createdAt: string;
}

interface QuarantineDetail extends QuarantineItem {
  preview: {
    headers: Record<string, string>;
    bodyText: string;
  } | null;
}

interface Stats {
  total: number; virus: number; spam: number; policy: number;
  released: number; pending: number;
}

// ── Reason badge ──────────────────────────────────────────────────────────────

function ReasonBadge({ reason, size = 'sm' }: { reason: Reason; size?: 'sm' | 'lg' }) {
  const cfg = {
    VIRUS:  { icon: Bug,           cls: 'bg-red-100 text-red-700 border-red-200',    label: 'Virus'      },
    SPAM:   { icon: AlertTriangle, cls: 'bg-amber-100 text-amber-700 border-amber-200', label: 'Spam'    },
    POLICY: { icon: FileWarning,   cls: 'bg-blue-100 text-blue-700 border-blue-200', label: 'Richtlinie' },
  }[reason];
  const Icon = cfg.icon;
  const px = size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium ${px} ${cfg.cls}`}>
      <Icon size={size === 'lg' ? 13 : 10} />
      {cfg.label}
    </span>
  );
}

// ── Detail Slide-Over ─────────────────────────────────────────────────────────

function DetailPanel({ id, onClose, onRelease, onDelete }: {
  id: string;
  onClose: () => void;
  onRelease: (id: string) => void;
  onDelete:  (id: string) => void;
}) {
  const t = useT();
  const { data, isLoading } = useQuery({
    queryKey: ['quarantine-detail', id],
    queryFn:  () => api.get<QuarantineDetail>(`/admin/quarantine/${id}`),
    enabled:  !!id,
  });

  const hdrs = data?.preview?.headers ?? {};
  const body = data?.preview?.bodyText ?? '';

  const INTERESTING_HEADERS = [
    'From','To','Subject','Date','Message-ID','X-Spam-Score',
    'X-Spam-Status','X-Virus-Scanned','Received','DKIM-Signature',
    'Authentication-Results','Return-Path','Reply-To',
  ];
  const filteredHdrs = INTERESTING_HEADERS
    .filter(h => hdrs[h])
    .map(h => [h, hdrs[h]!] as [string, string]);

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="w-[600px] bg-white h-full shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gray-50 shrink-0">
          <div className="flex items-center gap-2">
            <Eye size={16} className="text-gray-500" />
            <span className="font-semibold text-gray-900 text-sm">{t('quar_detail_title')}</span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded">
            <X size={16} />
          </button>
        </div>

        {isLoading && (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" /> {t('quar_detail_loading')}
          </div>
        )}

        {data && (
          <div className="flex-1 overflow-y-auto">
            {/* Metadata */}
            <div className="px-5 py-4 space-y-4 border-b border-gray-100">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h2 className="font-semibold text-gray-900 text-base leading-tight truncate">
                    {data.subject || t('quar_no_subject')}
                  </h2>
                </div>
                <ReasonBadge reason={data.reason} size="lg" />
              </div>

              <div className="grid grid-cols-1 gap-2">
                {[
                  { icon: User,     label: t('quar_detail_from'),    val: data.fromAddr },
                  { icon: ArrowRight, label: t('quar_detail_to'),    val: data.toAddr },
                  { icon: Clock,    label: t('quar_detail_received'), val: new Date(data.createdAt).toLocaleString('de-DE') },
                  ...(data.messageId ? [{ icon: Mail, label: t('quar_detail_msgid'), val: data.messageId }] : []),
                ].map(({ icon: Icon, label, val }) => (
                  <div key={label} className="flex items-start gap-2 text-sm">
                    <Icon size={13} className="text-gray-400 mt-0.5 shrink-0" />
                    <span className="text-gray-500 w-20 shrink-0">{label}:</span>
                    <span className="text-gray-800 break-all">{val}</span>
                  </div>
                ))}
              </div>

              {/* Status */}
              {data.released ? (
                <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700">
                  <CheckCircle size={13} />
                  {t('quar_detail_released_at')} {data.releasedAt ? new Date(data.releasedAt).toLocaleString('de-DE') : '—'}
                  {data.releasedBy && ` · ${data.releasedBy}`}
                </div>
              ) : (
                <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                  <Clock size={13} />
                  {t('quar_detail_pending_msg')}
                </div>
              )}
            </div>

            {/* Reason details */}
            {Object.keys(data.details).length > 0 && (
              <div className="px-5 py-4 border-b border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('quar_detail_filter')}</p>
                <div className="space-y-1.5">
                  {Object.entries(data.details).map(([k, v]) => (
                    <div key={k} className="flex gap-2 text-xs">
                      <span className="text-gray-400 font-mono w-28 shrink-0">{k}:</span>
                      <span className="text-gray-700 break-all">{String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* E-Mail Headers */}
            {filteredHdrs.length > 0 && (
              <div className="px-5 py-4 border-b border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('quar_detail_headers')}</p>
                <div className="bg-gray-50 rounded-lg p-3 space-y-1 text-xs font-mono max-h-52 overflow-y-auto">
                  {filteredHdrs.map(([h, v]) => (
                    <div key={h} className="flex gap-2">
                      <span className="text-blue-600 shrink-0 w-36">{h}:</span>
                      <span className="text-gray-700 break-all">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Body Preview */}
            {body && (
              <div className="px-5 py-4 border-b border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('quar_detail_body')}</p>
                <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-700 whitespace-pre-wrap max-h-48 overflow-y-auto font-mono leading-relaxed">
                  {body}
                </div>
                {body.length >= 2000 && (
                  <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                    <Info size={10} /> {t('quar_detail_body_limit')}
                  </p>
                )}
              </div>
            )}

            {!data.preview && (
              <div className="px-5 py-4">
                <div className="bg-gray-50 rounded-lg p-4 text-xs text-gray-400 text-center flex items-center justify-center gap-2">
                  <Download size={13} />
                  {t('quar_detail_no_preview')}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        {data && (
          <div className="px-5 py-4 border-t border-gray-200 bg-gray-50 flex items-center gap-2 shrink-0">
            {!data.released && data.reason !== 'VIRUS' && (
              <button
                onClick={() => { onRelease(data.id); onClose(); }}
                className="btn-primary text-sm gap-1.5 flex-1 justify-center"
              >
                <CheckCircle size={14} /> {t('quar_detail_release_btn')}
              </button>
            )}
            {data.reason === 'VIRUS' && !data.released && (
              <div className="flex-1 text-xs text-red-600 flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <Bug size={13} /> {t('quar_detail_virus_block')}
              </div>
            )}
            <button
              onClick={() => { onDelete(data.id); onClose(); }}
              className="btn-secondary text-sm gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
            >
              <Trash2 size={14} /> {t('quar_detail_delete_btn')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Bulk Cleanup Modal ────────────────────────────────────────────────────────

function CleanupModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: (days: number, onlyReleased: boolean) => void }) {
  const t = useT();
  const [days, setDays]               = useState(30);
  const [onlyReleased, setOnlyReleased] = useState(true);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-[400px] p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Trash2 size={18} className="text-red-500" />
          <h2 className="text-base font-semibold text-gray-900">{t('quar_cleanup_title')}</h2>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {t('quar_cleanup_older_than')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number" min={1} max={365} value={days}
                onChange={e => setDays(parseInt(e.target.value, 10) || 1)}
                className="w-24 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <span className="text-sm text-gray-600">{t('quar_cleanup_warn_days')}</span>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox" checked={onlyReleased} onChange={e => setOnlyReleased(e.target.checked)}
              className="rounded border-gray-300 text-accent"
            />
            <span className="text-sm text-gray-700">{t('quar_cleanup_only_released')}</span>
          </label>

          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700 flex items-start gap-1.5">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>
              {onlyReleased
                ? `${t('quar_cleanup_warn_released')} ${days} ${t('quar_cleanup_warn_days')}`
                : `${t('quar_cleanup_warn_all')} ${days} ${t('quar_cleanup_warn_days')}`}
              {' '}{t('quar_cleanup_warn_undo')}
            </span>
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="btn-secondary text-sm flex-1 justify-center">{t('action_cancel')}</button>
          <button
            onClick={() => { onConfirm(days, onlyReleased); onClose(); }}
            className="flex-1 justify-center btn-primary text-sm bg-red-600 hover:bg-red-700 border-red-600"
          >
            <Trash2 size={13} /> {t('quar_cleanup_btn')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// QuarantinePage
// ═════════════════════════════════════════════════════════════════════════════

export function QuarantinePage() {
  const t = useT();
  const qc = useQueryClient();

  // Filter state
  const [search,     setSearch]     = useState('');
  const [reason,     setReason]     = useState<string>('');
  const [released,   setReleased]   = useState('false');
  const [page,       setPage]       = useState(1);
  const LIMIT = 50;

  // UI state
  const [selectedId,    setSelectedId]    = useState<string | null>(null);
  const [selectedRows,  setSelectedRows]  = useState<Set<string>>(new Set());
  const [showCleanup,   setShowCleanup]   = useState(false);

  // ── Queries ──────────────────────────────────────────────────────────────

  const { data: stats, isLoading: statsLoading } = useQuery<Stats>({
    queryKey: ['quarantine-stats'],
    queryFn:  () => api.get<Stats>('/admin/quarantine/stats'),
    refetchInterval: 30_000,
  });

  const { data, isLoading, isFetching } = useQuery<{ items: QuarantineItem[]; total: number }>({
    queryKey: ['quarantine', search, reason, released, page],
    queryFn:  () => api.get(
      `/admin/quarantine?search=${encodeURIComponent(search)}&reason=${reason}&released=${released}&page=${page}&limit=${LIMIT}`
    ),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ['quarantine'] });
    void qc.invalidateQueries({ queryKey: ['quarantine-stats'] });
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  const releaseMut = useMutation({
    mutationFn: (id: string) => api.post(`/admin/quarantine/${id}/release`, {}),
    onSuccess: () => { invalidate(); toast.success(t('quar_released_toast')); },
    onError:   () => toast.error(t('quar_release_error')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/quarantine/${id}`),
    onSuccess: () => { invalidate(); setSelectedRows(new Set()); toast.success(t('quar_deleted_toast')); },
    onError:   () => toast.error(t('quar_delete_error')),
  });

  const bulkDeleteMut = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map(id => api.delete(`/admin/quarantine/${id}`))),
    onSuccess: () => { invalidate(); setSelectedRows(new Set()); toast.success(`${selectedRows.size} ${t('quar_deleted_toast')}`); },
    onError:   () => toast.error(t('quar_delete_error')),
  });

  const cleanupMut = useMutation({
    mutationFn: ({ days, onlyReleased }: { days: number; onlyReleased: boolean }) =>
      api.deleteWithBody<{ deleted: number }>('/admin/quarantine', { olderThanDays: days, onlyReleased }),
    onSuccess: (res) => { invalidate(); toast.success(`${res.deleted} ${t('quar_cleanup_success')}`); },
    onError:   () => toast.error(t('quar_cleanup_error')),
  });

  // ── Selection helpers ────────────────────────────────────────────────────

  function toggleRow(id: string) {
    setSelectedRows(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedRows.size === items.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(items.map(i => i.id)));
    }
  }

  function resetFilters() {
    setSearch(''); setReason(''); setReleased('false'); setPage(1); setSelectedRows(new Set());
  }

  // ── Stat cards config ────────────────────────────────────────────────────

  const STAT_CARDS = [
    { label: t('quar_stat_pending'),  value: stats?.pending  ?? '—', color: 'text-amber-600', bg: 'bg-amber-50',  icon: Clock },
    { label: t('quar_stat_virus'),    value: stats?.virus    ?? '—', color: 'text-red-600',   bg: 'bg-red-50',    icon: Bug },
    { label: t('quar_stat_spam'),     value: stats?.spam     ?? '—', color: 'text-yellow-600',bg: 'bg-yellow-50', icon: AlertTriangle },
    { label: t('quar_stat_policy'),   value: stats?.policy   ?? '—', color: 'text-blue-600',  bg: 'bg-blue-50',   icon: FileWarning },
    { label: t('quar_stat_released'), value: stats?.released ?? '—', color: 'text-green-600', bg: 'bg-green-50',  icon: CheckCircle },
    { label: t('quar_stat_total'),    value: stats?.total    ?? '—', color: 'text-gray-700',  bg: 'bg-gray-50',   icon: ShieldAlert },
  ];

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="px-6 py-4 bg-white border-b border-gray-200 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-amber-100 rounded-lg flex items-center justify-center">
              <ShieldAlert size={18} className="text-amber-600" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-900">{t('quar_page_title')}</h1>
              <p className="text-xs text-gray-400">
                {statsLoading ? '…' : `${stats?.pending ?? 0} ${t('quar_pending')} · ${stats?.total ?? 0} ${t('quar_total')}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowCleanup(true)}
              className="btn-secondary text-xs gap-1.5">
              <Trash2 size={13} /> {t('quar_cleanup')}
            </button>
            <button onClick={() => { invalidate(); void qc.invalidateQueries({ queryKey: ['quarantine-stats'] }); }}
              className="btn-ghost text-xs gap-1">
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} /> {t('quar_refresh')}
            </button>
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-6 gap-2.5">
          {STAT_CARDS.map(({ label, value, color, bg, icon: Icon }) => (
            <button
              key={label}
              onClick={() => {
                if (label === t('quar_stat_virus'))    { setReason('VIRUS');  setReleased('false'); setPage(1); }
                else if (label === t('quar_stat_spam'))    { setReason('SPAM');   setReleased('false'); setPage(1); }
                else if (label === t('quar_stat_policy'))  { setReason('POLICY'); setReleased('false'); setPage(1); }
                else if (label === t('quar_stat_released')) { setReleased('true'); setReason(''); setPage(1); }
                else if (label === t('quar_stat_pending'))  { setReleased('false'); setReason(''); setPage(1); }
                else resetFilters();
              }}
              className={`${bg} rounded-xl p-3 text-left border border-transparent hover:border-gray-200 transition-colors`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Icon size={12} className={color} />
                <span className="text-xs text-gray-500">{label}</span>
              </div>
              <p className={`text-xl font-bold ${color}`}>{value}</p>
            </button>
          ))}
        </div>
      </div>

      {/* ── Filter bar ────────────────────────────────────────────────── */}
      <div className="px-6 py-2.5 bg-white border-b border-gray-200 flex items-center gap-3 shrink-0">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); setSelectedRows(new Set()); }}
            placeholder={t('quar_search_placeholder')}
            className="w-full pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {search && (
            <button onClick={() => { setSearch(''); setPage(1); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X size={12} />
            </button>
          )}
        </div>

        <select value={reason} onChange={e => { setReason(e.target.value); setPage(1); setSelectedRows(new Set()); }}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
          <option value="">{t('quar_filter_all_reasons')}</option>
          <option value="VIRUS">{t('quar_stat_virus')}</option>
          <option value="SPAM">{t('quar_stat_spam')}</option>
          <option value="POLICY">{t('quar_stat_policy')}</option>
        </select>

        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
          {([[`false`, t('quar_filter_pending')],[`true`, t('quar_filter_released')],[``, t('quar_filter_all')]] as [string, string][]).map(([val, label]) => (
            <button
              key={val}
              onClick={() => { setReleased(val); setPage(1); setSelectedRows(new Set()); }}
              className={`px-3 py-1.5 transition-colors ${released === val ? 'bg-accent text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {(search || reason || released !== 'false') && (
          <button onClick={resetFilters} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <X size={12} /> {t('quar_filter_clear')}
          </button>
        )}

        <span className="ml-auto text-xs text-gray-400">{total} {t('quar_entries')}</span>
      </div>

      {/* ── Bulk action bar ───────────────────────────────────────────── */}
      {selectedRows.size > 0 && (
        <div className="px-6 py-2 bg-accent/10 border-b border-accent/20 flex items-center gap-3 shrink-0">
          <span className="text-sm font-medium text-accent">{selectedRows.size} {t('quar_bulk_selected')}</span>
          <button
            onClick={() => bulkDeleteMut.mutate([...selectedRows])}
            disabled={bulkDeleteMut.isPending}
            className="btn-secondary text-xs text-red-600 border-red-200 hover:bg-red-50 gap-1">
            <Trash2 size={12} /> {t('quar_bulk_delete')}
          </button>
          <button onClick={() => setSelectedRows(new Set())} className="text-xs text-gray-500 hover:text-gray-700 ml-auto">
            {t('quar_bulk_deselect')}
          </button>
        </div>
      )}

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <Loader2 size={22} className="animate-spin mr-2" /> {t('quar_loading')}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400 gap-3">
            <ShieldAlert size={36} className="text-gray-200" />
            <p className="text-sm">{t('quar_empty')}</p>
            {(search || reason) && (
              <button onClick={resetFilters} className="text-xs text-accent hover:underline">{t('quar_reset_filter')}</button>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-white border-b border-gray-200 sticky top-0 z-10">
              <tr>
                <th className="w-8 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selectedRows.size === items.length && items.length > 0}
                    onChange={toggleAll}
                    className="rounded border-gray-300 text-accent focus:ring-accent"
                  />
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('quar_col_from_to')}</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('quar_col_subject')}</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('quar_col_reason')}</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <Calendar size={11} className="inline mr-1" />{t('quar_col_date')}
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('quar_col_status')}</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{t('quar_col_actions')}</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-100">
              {items.map(item => {
                const isSelected  = selectedRows.has(item.id);
                const isActive    = selectedId === item.id;
                return (
                  <tr
                    key={item.id}
                    className={`transition-colors hover:bg-gray-50 cursor-pointer ${item.released ? 'opacity-60' : ''} ${isActive ? 'bg-accent/5' : ''} ${isSelected ? 'bg-blue-50/60' : ''}`}
                    onClick={() => setSelectedId(item.id === selectedId ? null : item.id)}
                  >
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRow(item.id)}
                        className="rounded border-gray-300 text-accent focus:ring-accent"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800 truncate max-w-[170px]">{item.fromAddr}</p>
                      <p className="text-xs text-gray-400 flex items-center gap-0.5 truncate max-w-[170px]">
                        <ArrowRight size={9} /> {item.toAddr}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-gray-700 truncate max-w-[220px]">{item.subject || <span className="italic text-gray-400">{t('quar_no_subject')}</span>}</p>
                    </td>
                    <td className="px-4 py-3">
                      <ReasonBadge reason={item.reason} />
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                      {new Date(item.createdAt).toLocaleDateString('de-DE')}<br/>
                      <span className="text-gray-400">{new Date(item.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
                    </td>
                    <td className="px-4 py-3">
                      {item.released ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-600">
                          <CheckCircle size={11} /> {t('quar_status_released')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                          <Clock size={11} /> {t('quar_status_pending')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setSelectedId(item.id === selectedId ? null : item.id)}
                          title={t('quar_btn_preview')}
                          className={`p-1.5 rounded transition-colors ${isActive ? 'bg-accent/10 text-accent' : 'text-gray-400 hover:text-accent hover:bg-accent/10'}`}
                        >
                          <Eye size={14} />
                        </button>
                        {!item.released && item.reason !== 'VIRUS' && (
                          <button
                            onClick={() => releaseMut.mutate(item.id)}
                            title={t('quar_btn_release')}
                            className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors"
                          >
                            <CheckCircle size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => { if (window.confirm(t('quar_delete_confirm'))) deleteMut.mutate(item.id); }}
                          title={t('quar_btn_delete')}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination ────────────────────────────────────────────────── */}
      {pages > 1 && (
        <div className="px-6 py-3 bg-white border-t border-gray-200 flex items-center justify-between text-sm text-gray-500 shrink-0">
          <span>{total} {t('quar_entries')} · {t('quar_page_info')} {page} {t('quar_page_of')} {pages}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(1)} disabled={page === 1}
              className="p-1.5 border rounded hover:bg-gray-50 disabled:opacity-40 transition-colors">
              «
            </button>
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="p-1.5 border rounded hover:bg-gray-50 disabled:opacity-40 transition-colors">
              <ChevronLeft size={14} />
            </button>
            {Array.from({ length: Math.min(5, pages) }, (_, i) => {
              const p = Math.max(1, Math.min(pages - 4, page - 2)) + i;
              return (
                <button key={p} onClick={() => setPage(p)}
                  className={`min-w-[32px] px-2 py-1 rounded border text-xs transition-colors ${p === page ? 'bg-accent text-white border-accent' : 'hover:bg-gray-50'}`}>
                  {p}
                </button>
              );
            })}
            <button
              onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page === pages}
              className="p-1.5 border rounded hover:bg-gray-50 disabled:opacity-40 transition-colors">
              <ChevronRight size={14} />
            </button>
            <button
              onClick={() => setPage(pages)} disabled={page === pages}
              className="p-1.5 border rounded hover:bg-gray-50 disabled:opacity-40 transition-colors">
              »
            </button>
          </div>
        </div>
      )}

      {/* ── Detail Slide-Over ──────────────────────────────────────────── */}
      {selectedId && (
        <DetailPanel
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onRelease={id => releaseMut.mutate(id)}
          onDelete={id => { if (window.confirm(t('quar_delete_confirm'))) deleteMut.mutate(id); }}
        />
      )}

      {/* ── Cleanup Modal ─────────────────────────────────────────────── */}
      {showCleanup && (
        <CleanupModal
          onClose={() => setShowCleanup(false)}
          onConfirm={(days, onlyReleased) => cleanupMut.mutate({ days, onlyReleased })}
        />
      )}
    </div>
  );
}
