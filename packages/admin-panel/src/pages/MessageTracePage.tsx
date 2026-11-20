import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Download, Loader2, ArrowRight, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, downloadFile } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import { MessageTraceDetail } from '../components/MessageTraceDetail.js';

interface TraceItem {
  id: string; timestamp: string; level: string; message: string;
  metadata: Record<string, string> | null;
}

// Status labels with translation
const STATUS_LABELS: Record<string, { de: string; en: string; color: string }> = {
  ACCEPTED:   { de: 'Angenommen',   en: 'Accepted',    color: 'blue'   },
  DELIVERED:  { de: 'Zugestellt',   en: 'Delivered',   color: 'green'  },
  JUNK:       { de: 'Spam-Ordner',  en: 'Junk',        color: 'purple' },
  REJECTED:   { de: 'Abgelehnt',   en: 'Rejected',    color: 'red'    },
  DEFERRED:   { de: 'Zurückgest.', en: 'Deferred',    color: 'amber'  },
  QUARANTINE: { de: 'Quarantäne',   en: 'Quarantine',  color: 'orange' },
};

const COLOR_CLASS: Record<string, string> = {
  blue:   'bg-info-bg text-info-fg',
  green:  'bg-success-bg text-success-fg',
  purple: 'bg-info-bg text-info-fg',
  red:    'bg-danger-bg text-danger-fg',
  amber:  'bg-warning-bg text-warning-fg',
  orange: 'bg-warning-bg text-warning-fg',
  gray:   'bg-surface-2 text-fg-muted',
};

function StatusBadge({ status, lang }: { status: string; lang: string }) {
  const base = 'px-2 py-0.5 rounded text-xs font-medium';
  const info = STATUS_LABELS[status];
  if (!info) return <span className={`${base} ${COLOR_CLASS['gray']}`}>{status || '–'}</span>;
  const label = lang === 'en' ? info.en : info.de;
  return <span className={`${base} ${COLOR_CLASS[info.color]}`}>{label}</span>;
}

export function MessageTracePage() {
  const t = useT();
  // useLanguageStore not directly available → derive lang from t()
  const lang = t('nav_overview') === 'Overview' ? 'en' : 'de';

  const [sender, setSender]       = useState('');
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject]     = useState('');
  const [status, setStatus]       = useState('');
  const [fromDate, setFromDate]   = useState('');
  const [toDate, setToDate]       = useState('');
  const [page, setPage]           = useState(1);
  const [limit]                   = useState(100);
  // 10.2: entry shown in the detail side panel
  const [detailId, setDetailId]   = useState<string | null>(null);
  // The table follows the APPLIED filters (Search / Enter), not every keystroke.
  // datetime-local values are local time → sent as ISO instants.
  const currentFilters = () => {
    const iso = (v: string) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : ''; };
    return { sender: sender.trim(), recipient: recipient.trim(), subject: subject.trim(), status, from: iso(fromDate), to: iso(toDate) };
  };
  const [applied, setApplied] = useState(currentFilters);

  const { data, isLoading, isFetching, refetch } = useQuery<{ items: TraceItem[]; total: number; truncated?: boolean }>({
    queryKey: ['message-trace', applied, page],
    // API client adds /api/v1 automatically → path without /api/v1
    queryFn: () => api.get(`/admin/message-trace?${new URLSearchParams({ ...applied, page: String(page), limit: String(limit) }).toString()}`),
    placeholderData: (prev) => prev,
  });

  function handleSearch() {
    const next = currentFilters();
    setPage(1);
    if (JSON.stringify(next) === JSON.stringify(applied)) void refetch(); else setApplied(next);
  }
  function handleReset() {
    setSender(''); setRecipient(''); setSubject('');
    setStatus(''); setFromDate(''); setToDate('');
    setPage(1);
    setApplied({ sender: '', recipient: '', subject: '', status: '', from: '', to: '' });
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  const [exporting, setExporting] = useState(false);
  // Authenticated download (Authorization header) with the same filters as the
  // table — window.open() could not send the token and dropped subject/status.
  function exportCsv() {
    const qs = new URLSearchParams(applied);
    setExporting(true);
    downloadFile(`/admin/message-trace/export?${qs.toString()}`, 'message-trace.csv')
      .catch((err: unknown) => { toast.error(err instanceof Error ? err.message : String(err)); })
      .finally(() => setExporting(false));
  }

  const pageTitle       = lang === 'en' ? 'Message Trace'               : 'Nachrichtenablaufverfolgung';
  const pageSubtitle    = lang === 'en' ? 'Track email delivery paths'  : 'E-Mail-Zustellungspfade nachverfolgen';
  const labelSender     = lang === 'en' ? 'Sender'                      : 'Absender';
  const labelRecipient  = lang === 'en' ? 'Recipient'                   : 'Empfänger';
  const labelSubject    = lang === 'en' ? 'Subject (contains)'          : 'Betreff (enthält)';
  const labelStatus     = lang === 'en' ? 'Status'                      : 'Status';
  const labelFrom       = lang === 'en' ? 'From date'                   : 'Von Datum';
  const labelTo         = lang === 'en' ? 'To date'                     : 'Bis Datum';
  const labelSearch     = lang === 'en' ? 'Search'                      : 'Suchen';
  const labelReset      = lang === 'en' ? 'All (reset)'                 : 'Alle (zurücksetzen)';
  const labelExport     = lang === 'en' ? 'Export CSV'                  : 'CSV exportieren';
  const labelTimestamp  = lang === 'en' ? 'Timestamp'                   : 'Zeitstempel';
  const labelFromTo     = lang === 'en' ? 'From → To'                   : 'Von → An';
  const labelDetails    = lang === 'en' ? 'Details'                     : 'Details';
  const labelNoSubject  = lang === 'en' ? '(no subject)'                : '(kein Betreff)';
  const labelNoResults  = lang === 'en' ? 'No messages found'           : 'Keine Nachrichten gefunden';
  const labelEntries    = lang === 'en' ? 'entries'                     : 'Einträge';
  const labelPage       = lang === 'en' ? 'Page'                        : 'Seite';
  const labelOf         = lang === 'en' ? 'of'                          : '/';
  const labelSpam       = lang === 'en' ? 'Spam:'                       : 'Spam:';
  const labelRunning    = lang === 'en' ? 'Searching…'                  : 'Suche läuft…';
  const labelRefresh    = lang === 'en' ? 'Refresh'                     : 'Aktualisieren';

  const statusOptions = lang === 'en' ? [
    { value: '',           label: 'All' },
    { value: 'ACCEPTED',   label: 'Accepted' },
    { value: 'DELIVERED',  label: 'Delivered' },
    { value: 'JUNK',       label: 'Junk' },
    { value: 'REJECTED',   label: 'Rejected' },
    { value: 'DEFERRED',   label: 'Deferred' },
    { value: 'QUARANTINE', label: 'Quarantine' },
  ] : [
    { value: '',           label: 'Alle' },
    { value: 'ACCEPTED',   label: 'Angenommen' },
    { value: 'DELIVERED',  label: 'Zugestellt' },
    { value: 'JUNK',       label: 'Spam-Ordner' },
    { value: 'REJECTED',   label: 'Abgelehnt' },
    { value: 'DEFERRED',   label: 'Zurückgestellt' },
    { value: 'QUARANTINE', label: 'Quarantäne' },
  ];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Search size={22} className="text-info-fg" />
          <div>
            <h1 className="text-xl font-bold text-fg">{pageTitle}</h1>
            <p className="text-sm text-fg-subtle">{pageSubtitle}</p>
          </div>
        </div>
        <button
          onClick={() => void refetch()}
          disabled={isLoading || isFetching}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-fg-muted border border-line-strong rounded hover:bg-surface-2 disabled:opacity-50"
        >
          <RefreshCw size={13} className={(isLoading || isFetching) ? 'animate-spin' : ''} />
          {labelRefresh}
        </button>
      </div>

      {/* Search form */}
      <div className="bg-surface rounded-xl border border-line p-4 mb-4">
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div>
            <label className="field-label">{labelSender}</label>
            <input value={sender} onChange={e => setSender(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="input" placeholder="user@domain.com" />
          </div>
          <div>
            <label className="field-label">{labelRecipient}</label>
            <input value={recipient} onChange={e => setRecipient(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="input" placeholder="user@domain.com" />
          </div>
          <div>
            <label className="field-label">{labelSubject}</label>
            <input value={subject} onChange={e => setSubject(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="input" placeholder="Re: Meeting" />
          </div>
          <div>
            <label className="field-label">{labelStatus}</label>
            <select value={status} onChange={e => setStatus(e.target.value)} className="input" aria-label={labelStatus}>
              {statusOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">{labelFrom}</label>
            <input type="datetime-local" value={fromDate}
              onChange={e => setFromDate(e.target.value)} className="input" />
          </div>
          <div>
            <label className="field-label">{labelTo}</label>
            <input type="datetime-local" value={toDate}
              onChange={e => setToDate(e.target.value)} className="input" />
          </div>
        </div>
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <button onClick={exportCsv} disabled={exporting}
              className="btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-50">
              {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} {labelExport}
            </button>
            <button onClick={handleReset}
              className="btn-secondary flex items-center gap-1.5 text-xs text-fg-subtle">
              {labelReset}
            </button>
          </div>
          <button onClick={handleSearch} disabled={isLoading || isFetching}
            className="btn-primary flex items-center gap-1.5">
            {(isLoading || isFetching)
              ? <Loader2 size={14} className="animate-spin" />
              : <Search size={14} />}
            {labelSearch}
          </button>
        </div>
      </div>

      {/* Results table */}
      <div className="bg-surface rounded-xl border border-line overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-fg-subtle">
            <Loader2 size={20} className="animate-spin mr-2" /> {labelRunning}
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-fg-subtle text-sm">
            <Search size={28} className="mx-auto mb-2 text-fg-subtle" aria-hidden="true" />
            {labelNoResults}
          </div>
        ) : (
          <>
            <table className="w-full">
              <thead className="bg-surface-2 border-b border-line">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-fg-subtle uppercase tracking-wide">{labelTimestamp}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-fg-subtle uppercase tracking-wide">{labelFromTo}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-fg-subtle uppercase tracking-wide">{labelSubject}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-fg-subtle uppercase tracking-wide">{labelStatus}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-fg-subtle uppercase tracking-wide">{labelDetails}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map(item => {
                  const m = item.metadata ?? {};
                  return (
                    <tr key={item.id} tabIndex={0}
                      title={t('mt_open_details')}
                      aria-current={detailId === item.id ? 'true' : undefined}
                      onClick={() => setDetailId(item.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); setDetailId(item.id); } }}
                      className={`cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-fg transition-colors ${
                        detailId === item.id ? 'bg-accent/10' : 'hover:bg-surface-2'}`}>
                      <td className="px-4 py-3 text-xs text-fg-subtle whitespace-nowrap">
                        {new Date(item.timestamp).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE')}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 text-sm">
                          <span className="text-fg-muted">{m['sender'] || '–'}</span>
                          <ArrowRight size={12} className="text-fg-subtle shrink-0" />
                          <span className="text-fg-muted">{m['recipient'] || '–'}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm text-fg-muted truncate max-w-[200px]">
                          {m['subject'] || `(${labelNoSubject.replace('(', '').replace(')', '')})`}
                        </p>
                        {m['messageId'] && (
                          <p className="text-xs text-fg-subtle font-mono">
                            {m['messageId'].slice(0, 30)}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={m['status'] ?? ''} lang={lang} />
                      </td>
                      <td className="px-4 py-3 text-xs text-fg-subtle">
                        {m['reason'] && <span className="text-danger-fg">{m['reason']}</span>}
                        {m['spamScore'] && <span> {labelSpam} {m['spamScore']}</span>}
                        {m['size'] && <span> {Math.round(parseInt(m['size']) / 1024)} KB</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {(pages > 1 || data?.truncated) && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-line text-sm text-fg-subtle">
                <span>{total} {labelEntries}{data?.truncated ? (lang === 'en' ? ' (newest 5,000 searched: narrow the date range)' : ' (die neuesten 5.000 durchsucht: Zeitraum eingrenzen)') : ''}</span>
                <div className="flex gap-1">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                    className="px-2 py-1 border border-line-strong rounded text-fg-muted hover:bg-surface-2 disabled:text-fg-subtle disabled:cursor-not-allowed">‹</button>
                  <span className="px-3 py-1">{labelPage} {page} {labelOf} {pages}</span>
                  <button onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page === pages}
                    className="px-2 py-1 border border-line-strong rounded text-fg-muted hover:bg-surface-2 disabled:text-fg-subtle disabled:cursor-not-allowed">›</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {detailId && (
        <MessageTraceDetail id={detailId} onClose={() => setDetailId(null)} onOpen={setDetailId}
          renderStatus={(s) => <StatusBadge status={s} lang={lang} />} />
      )}
    </div>
  );
}
