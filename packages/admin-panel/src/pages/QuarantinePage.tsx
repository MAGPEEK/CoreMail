import { useId, useState } from 'react';
import { Modal } from '../components/Modal.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ShieldAlert, CheckCircle, Trash2, Loader2, Bug, AlertTriangle,
  FileWarning, X, RefreshCw, Mail,
  User, ArrowRight, Eye,
  Info, Clock, Download,
} from 'lucide-react';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { Can } from '../components/Can.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { errorMessage } from '../lib/errors.js';

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
    VIRUS:  { icon: Bug,           cls: 'bg-danger-bg text-danger-fg border-danger-line',    label: 'Virus'      },
    SPAM:   { icon: AlertTriangle, cls: 'bg-warning-bg text-warning-fg border-warning-line', label: 'Spam'    },
    POLICY: { icon: FileWarning,   cls: 'bg-info-bg text-info-fg border-info-line', label: 'Richtlinie' },
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

  const titleId = useId();
  return (
    // Slide-over panel on the right; clicking the dimmed area closes it
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      overlayClassName="fixed inset-0 z-50 flex justify-end bg-scrim/30"
      className="w-[600px] max-w-full bg-surface h-full shadow-2xl flex flex-col overflow-hidden"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line bg-surface-2 shrink-0">
          <div className="flex items-center gap-2">
            <Eye size={16} className="text-fg-subtle" aria-hidden="true" />
            <h2 id={titleId} className="font-semibold text-fg text-sm">{t('quar_detail_title')}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Schließen" className="p-1 hover:bg-surface-3 rounded">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {isLoading && (
          <div className="flex-1 flex items-center justify-center text-fg-subtle">
            <Loader2 size={20} className="animate-spin mr-2" /> {t('quar_detail_loading')}
          </div>
        )}

        {data && (
          <div className="flex-1 overflow-y-auto">
            {/* Metadata */}
            <div className="px-5 py-4 space-y-4 border-b border-line">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h2 className="font-semibold text-fg text-base leading-tight truncate">
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
                    <Icon size={13} className="text-fg-subtle mt-0.5 shrink-0" />
                    <span className="text-fg-subtle w-20 shrink-0">{label}:</span>
                    <span className="text-fg break-all">{val}</span>
                  </div>
                ))}
              </div>

              {/* Status */}
              {data.released ? (
                <div className="flex items-center gap-2 bg-success-bg border border-success-line rounded-lg px-3 py-2 text-xs text-success-fg">
                  <CheckCircle size={13} />
                  {t('quar_detail_released_at')} {data.releasedAt ? new Date(data.releasedAt).toLocaleString('de-DE') : '—'}
                  {data.releasedBy && ` · ${data.releasedBy}`}
                </div>
              ) : (
                <div className="flex items-center gap-2 bg-warning-bg border border-warning-line rounded-lg px-3 py-2 text-xs text-warning-fg">
                  <Clock size={13} />
                  {t('quar_detail_pending_msg')}
                </div>
              )}
            </div>

            {/* Reason details */}
            {Object.keys(data.details).length > 0 && (
              <div className="px-5 py-4 border-b border-line">
                <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide mb-2">{t('quar_detail_filter')}</p>
                <div className="space-y-1.5">
                  {Object.entries(data.details).map(([k, v]) => (
                    <div key={k} className="flex gap-2 text-xs">
                      <span className="text-fg-subtle font-mono w-28 shrink-0">{k}:</span>
                      <span className="text-fg-muted break-all">{String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* E-Mail Headers */}
            {filteredHdrs.length > 0 && (
              <div className="px-5 py-4 border-b border-line">
                <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide mb-2">{t('quar_detail_headers')}</p>
                <div className="bg-surface-2 rounded-lg p-3 space-y-1 text-xs font-mono max-h-52 overflow-y-auto">
                  {filteredHdrs.map(([h, v]) => (
                    <div key={h} className="flex gap-2">
                      <span className="text-info-fg shrink-0 w-36">{h}:</span>
                      <span className="text-fg-muted break-all">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Body Preview */}
            {body && (
              <div className="px-5 py-4 border-b border-line">
                <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide mb-2">{t('quar_detail_body')}</p>
                <div className="bg-surface-2 rounded-lg p-3 text-xs text-fg-muted whitespace-pre-wrap max-h-48 overflow-y-auto font-mono leading-relaxed">
                  {body}
                </div>
                {body.length >= 2000 && (
                  <p className="text-xs text-fg-subtle mt-1 flex items-center gap-1">
                    <Info size={10} /> {t('quar_detail_body_limit')}
                  </p>
                )}
              </div>
            )}

            {!data.preview && (
              <div className="px-5 py-4">
                <div className="bg-surface-2 rounded-lg p-4 text-xs text-fg-subtle text-center flex items-center justify-center gap-2">
                  <Download size={13} />
                  {t('quar_detail_no_preview')}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Actions (hidden without write access to the hygiene area) */}
        {data && (
          <Can area="hygiene" access="write" mode="hide">
          <div className="px-5 py-4 border-t border-line bg-surface-2 flex items-center gap-2 shrink-0">
            {!data.released && data.reason !== 'VIRUS' && (
              <button
                onClick={() => { onRelease(data.id); onClose(); }}
                className="btn-primary text-sm gap-1.5 flex-1 justify-center"
              >
                <CheckCircle size={14} /> {t('quar_detail_release_btn')}
              </button>
            )}
            {data.reason === 'VIRUS' && !data.released && (
              <div className="flex-1 text-xs text-danger-fg flex items-center gap-1.5 bg-danger-bg border border-danger-line rounded-lg px-3 py-2">
                <Bug size={13} /> {t('quar_detail_virus_block')}
              </div>
            )}
            <button
              onClick={() => { onDelete(data.id); onClose(); }}
              className="btn-secondary text-sm gap-1.5 text-danger-fg border-danger-line hover:bg-danger-bg"
            >
              <Trash2 size={14} /> {t('quar_detail_delete_btn')}
            </button>
          </div>
          </Can>
        )}
    </Modal>
  );
}

// ── Bulk Cleanup Modal ────────────────────────────────────────────────────────

function CleanupModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: (days: number, onlyReleased: boolean) => void }) {
  const t = useT();
  const [days, setDays]               = useState(30);
  const [onlyReleased, setOnlyReleased] = useState(true);

  const titleId = useId();
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
      className="relative bg-surface rounded-xl shadow-2xl w-[400px] max-w-full p-6 space-y-5"
    >
        <div className="flex items-center gap-2">
          <Trash2 size={18} className="text-danger-fg" aria-hidden="true" />
          <h2 id={titleId} className="text-base font-semibold text-fg">{t('quar_cleanup_title')}</h2>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-fg-muted mb-1.5">
              {t('quar_cleanup_older_than')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number" min={1} max={365} value={days}
                onChange={e => setDays(parseInt(e.target.value, 10) || 1)}
                className="w-24 border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-fg"
              />
              <span className="text-sm text-fg-muted">{t('quar_cleanup_warn_days')}</span>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox" checked={onlyReleased} onChange={e => setOnlyReleased(e.target.checked)}
              className="rounded border-line-strong text-accent-fg"
            />
            <span className="text-sm text-fg-muted">{t('quar_cleanup_only_released')}</span>
          </label>

          <div className="bg-warning-bg border border-warning-line rounded-lg px-3 py-2 text-xs text-warning-fg flex items-start gap-1.5">
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
            className="flex-1 justify-center btn-primary text-sm bg-danger hover:bg-danger/85 border-danger-line"
          >
            <Trash2 size={13} /> {t('quar_cleanup_btn')}
          </button>
        </div>
    </Modal>
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
  const [showCleanup,   setShowCleanup]   = useState(false);
  const { can } = usePermissions();
  const canWrite = can('hygiene', 'write');

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

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ['quarantine'] });
    void qc.invalidateQueries({ queryKey: ['quarantine-stats'] });
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  const releaseMut = useMutation({
    mutationFn: (id: string) => api.post(`/admin/quarantine/${id}/release`, {}),
    onSuccess: () => { invalidate(); toast.success(t('quar_released_toast')); },
    onError:   (e) => toast.error(errorMessage(e, t('quar_release_error'))),
  });

  const releaseManyMut = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map(id => api.post(`/admin/quarantine/${id}/release`, {}))),
    onSuccess: (r) => { invalidate(); toast.success(`${r.length} × ${t('quar_released_toast')}`); },
    onError:   (e) => { invalidate(); toast.error(errorMessage(e, t('quar_release_error'))); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/quarantine/${id}`),
    onSuccess: () => { invalidate(); toast.success(t('quar_deleted_toast')); },
    onError:   (e) => toast.error(errorMessage(e, t('quar_delete_error'))),
  });

  const bulkDeleteMut = useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map(id => api.delete(`/admin/quarantine/${id}`))),
    onSuccess: (r) => { invalidate(); toast.success(`${r.length} ${t('quar_deleted_toast')}`); },
    onError:   (e) => { invalidate(); toast.error(errorMessage(e, t('quar_delete_error'))); },
  });

  const cleanupMut = useMutation({
    mutationFn: ({ days, onlyReleased }: { days: number; onlyReleased: boolean }) =>
      api.deleteWithBody<{ deleted: number }>('/admin/quarantine', { olderThanDays: days, onlyReleased }),
    onSuccess: (res) => { invalidate(); toast.success(`${res.deleted} ${t('quar_cleanup_success')}`); },
    onError:   (e) => toast.error(errorMessage(e, t('quar_cleanup_error'))),
  });

  function resetFilters() {
    setSearch(''); setReason(''); setReleased('false'); setPage(1);
  }

  const columns: Column<QuarantineItem>[] = [
    {
      key: 'from', header: t('quar_col_from_to'),
      cell: (item) => (
        <>
          <p className="font-medium text-fg truncate max-w-[170px]">{item.fromAddr}</p>
          <p className="text-xs text-fg-subtle flex items-center gap-0.5 truncate max-w-[170px]">
            <ArrowRight size={9} aria-hidden="true" /> {item.toAddr}
          </p>
        </>
      ),
    },
    {
      key: 'subject', header: t('quar_col_subject'),
      cell: (item) => <p className="text-fg-muted truncate max-w-[220px]">{item.subject || <span className="italic text-fg-subtle">{t('quar_no_subject')}</span>}</p>,
    },
    { key: 'reason', header: t('quar_col_reason'), cell: (item) => <ReasonBadge reason={item.reason} /> },
    {
      key: 'date', header: t('quar_col_date'), className: 'text-xs text-fg-subtle whitespace-nowrap',
      cell: (item) => (
        <>
          {new Date(item.createdAt).toLocaleDateString()}<br />
          <span className="text-fg-subtle">{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </>
      ),
    },
    {
      key: 'status', header: t('quar_col_status'),
      cell: (item) => item.released ? (
        <span className="inline-flex items-center gap-1 text-xs text-success-fg"><CheckCircle size={11} aria-hidden="true" /> {t('quar_status_released')}</span>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-warning-fg"><Clock size={11} aria-hidden="true" /> {t('quar_status_pending')}</span>
      ),
    },
    {
      key: 'actions', header: t('quar_col_actions'), srOnlyHeader: true,
      cell: (item) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => setSelectedId(item.id === selectedId ? null : item.id)}
            title={t('quar_btn_preview')} aria-label={`${t('quar_btn_preview')}: ${item.subject || item.fromAddr}`}
            className={`p-1.5 rounded transition-colors ${selectedId === item.id ? 'bg-accent/10 text-accent-fg' : 'text-fg-subtle hover:text-accent-fg hover:bg-accent/10'}`}
          >
            <Eye size={14} />
          </button>
          <Can area="hygiene" access="write">
            {!item.released && item.reason !== 'VIRUS' && (
              <button onClick={() => releaseMut.mutate(item.id)} title={t('quar_btn_release')} aria-label={t('quar_btn_release')}
                className="p-1.5 text-fg-subtle hover:text-success-fg hover:bg-success-bg rounded transition-colors">
                <CheckCircle size={14} />
              </button>
            )}
            <button onClick={() => { if (window.confirm(t('quar_delete_confirm'))) deleteMut.mutate(item.id); }}
              title={t('quar_btn_delete')} aria-label={t('quar_btn_delete')}
              className="p-1.5 text-fg-subtle hover:text-danger-fg hover:bg-danger-bg rounded transition-colors">
              <Trash2 size={14} />
            </button>
          </Can>
        </div>
      ),
    },
  ];

  // ── Stat cards config ────────────────────────────────────────────────────

  const STAT_CARDS = [
    { label: t('quar_stat_pending'),  value: stats?.pending  ?? '—', color: 'text-warning-fg', bg: 'bg-warning-bg',  icon: Clock },
    { label: t('quar_stat_virus'),    value: stats?.virus    ?? '—', color: 'text-danger-fg',   bg: 'bg-danger-bg',    icon: Bug },
    { label: t('quar_stat_spam'),     value: stats?.spam     ?? '—', color: 'text-warning-fg',bg: 'bg-warning-bg', icon: AlertTriangle },
    { label: t('quar_stat_policy'),   value: stats?.policy   ?? '—', color: 'text-info-fg',  bg: 'bg-info-bg',   icon: FileWarning },
    { label: t('quar_stat_released'), value: stats?.released ?? '—', color: 'text-success-fg', bg: 'bg-success-bg',  icon: CheckCircle },
    { label: t('quar_stat_total'),    value: stats?.total    ?? '—', color: 'text-fg-muted',  bg: 'bg-surface-2',   icon: ShieldAlert },
  ];

  return (
    <div className="flex flex-col h-full bg-surface-2">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="px-6 py-4 bg-surface border-b border-line shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-warning-bg rounded-lg flex items-center justify-center">
              <ShieldAlert size={18} className="text-warning-fg" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-fg">{t('quar_page_title')}</h1>
              <p className="text-xs text-fg-subtle">
                {statsLoading ? '…' : `${stats?.pending ?? 0} ${t('quar_pending')} · ${stats?.total ?? 0} ${t('quar_total')}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Can area="hygiene" access="write">
              <button onClick={() => setShowCleanup(true)}
                className="btn-secondary text-xs gap-1.5">
                <Trash2 size={13} /> {t('quar_cleanup')}
              </button>
            </Can>
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
              className={`${bg} rounded-xl p-3 text-left border border-transparent hover:border-line transition-colors`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Icon size={12} className={color} />
                <span className="text-xs text-fg-subtle">{label}</span>
              </div>
              <p className={`text-xl font-bold ${color}`}>{value}</p>
            </button>
          ))}
        </div>
      </div>

      {/* ── List (server-side search + paging; API: search/reason/released/page/limit) ── */}
      <div className="flex-1 overflow-auto px-6 py-4">
        <DataTable<QuarantineItem>
          caption={t('quar_page_title')}
          rows={items}
          columns={columns}
          rowKey={(i) => i.id}
          loading={isLoading}
          server={{ page, pageSize: LIMIT, total, onPageChange: setPage }}
          search={{ placeholder: t('quar_search_placeholder'), value: search, onChange: (q) => { setSearch(q); setPage(1); } }}
          selectable={canWrite}
          onActivate={(i) => setSelectedId(i.id)}
          activeKey={selectedId}
          rowClassName={(i) => (i.released ? 'bg-surface-2' : '')}
          emptyText={
            <span className="inline-flex flex-col items-center gap-2">
              <ShieldAlert size={32} className="text-fg-subtle" aria-hidden="true" />
              {t('quar_empty')}
              {(search || reason) && (
                <button onClick={resetFilters} className="text-xs text-accent-fg hover:underline">{t('quar_reset_filter')}</button>
              )}
            </span>
          }
          filters={
            <>
              <select value={reason} onChange={e => { setReason(e.target.value); setPage(1); }}
                aria-label={t('quar_filter_all_reasons')}
                className="input w-auto py-1.5">
                <option value="">{t('quar_filter_all_reasons')}</option>
                <option value="VIRUS">{t('quar_stat_virus')}</option>
                <option value="SPAM">{t('quar_stat_spam')}</option>
                <option value="POLICY">{t('quar_stat_policy')}</option>
              </select>
              <div className="flex rounded-lg border border-line-strong overflow-hidden text-sm" role="group" aria-label={t('quar_col_status')}>
                {([[`false`, t('quar_filter_pending')],[`true`, t('quar_filter_released')],[``, t('quar_filter_all')]] as [string, string][]).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => { setReleased(val); setPage(1); }}
                    aria-pressed={released === val}
                    className={`px-3 py-1.5 transition-colors ${released === val ? 'bg-accent text-white' : 'text-fg-muted hover:bg-surface-2'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {(search || reason || released !== 'false') && (
                <button onClick={resetFilters} className="text-xs text-fg-subtle hover:text-fg-muted flex items-center gap-1">
                  <X size={12} aria-hidden="true" /> {t('quar_filter_clear')}
                </button>
              )}
            </>
          }
          toolbar={({ selectedRows, clearSelection }) => (
            <>
              <Can area="hygiene" access="write">
                <button
                  onClick={() => releaseManyMut.mutate(selectedRows.filter((i) => !i.released && i.reason !== 'VIRUS').map((i) => i.id), { onSuccess: clearSelection })}
                  disabled={releaseManyMut.isPending || !selectedRows.some((i) => !i.released && i.reason !== 'VIRUS')}
                  className="btn-secondary text-xs gap-1 disabled:opacity-40">
                  <CheckCircle size={12} aria-hidden="true" /> {t('quar_btn_release')}
                </button>
              </Can>
              <Can area="hygiene" access="write">
                <button
                  onClick={() => { if (window.confirm(`${t('tb_delete_selected_confirm')} (${selectedRows.length})`)) bulkDeleteMut.mutate(selectedRows.map((i) => i.id), { onSuccess: clearSelection }); }}
                  disabled={bulkDeleteMut.isPending || selectedRows.length === 0}
                  className="btn-secondary text-xs text-danger-fg gap-1 disabled:opacity-40">
                  <Trash2 size={12} aria-hidden="true" /> {t('quar_bulk_delete')}
                </button>
              </Can>
            </>
          )}
        />
      </div>

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
