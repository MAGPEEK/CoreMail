import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Download, Loader2, ArrowRight, RefreshCw } from 'lucide-react';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';

interface TraceItem {
  id: string; timestamp: string; level: string; message: string;
  metadata: Record<string, string> | null;
}

// Status-Labels mit Übersetzung
const STATUS_LABELS: Record<string, { de: string; en: string; color: string }> = {
  ACCEPTED:   { de: 'Angenommen',   en: 'Accepted',    color: 'blue'   },
  DELIVERED:  { de: 'Zugestellt',   en: 'Delivered',   color: 'green'  },
  JUNK:       { de: 'Spam-Ordner',  en: 'Junk',        color: 'purple' },
  REJECTED:   { de: 'Abgelehnt',   en: 'Rejected',    color: 'red'    },
  DEFERRED:   { de: 'Zurückgest.', en: 'Deferred',    color: 'amber'  },
  QUARANTINE: { de: 'Quarantäne',   en: 'Quarantine',  color: 'orange' },
};

const COLOR_CLASS: Record<string, string> = {
  blue:   'bg-blue-100 text-blue-700',
  green:  'bg-green-100 text-green-700',
  purple: 'bg-purple-100 text-purple-700',
  red:    'bg-red-100 text-red-700',
  amber:  'bg-amber-100 text-amber-700',
  orange: 'bg-orange-100 text-orange-700',
  gray:   'bg-gray-100 text-gray-600',
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
  // useLanguageStore nicht direkt verfügbar → lang aus t() ableiten
  const lang = t('nav_overview') === 'Overview' ? 'en' : 'de';

  const [sender, setSender]       = useState('');
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject]     = useState('');
  const [status, setStatus]       = useState('');
  const [fromDate, setFromDate]   = useState('');
  const [toDate, setToDate]       = useState('');
  const [page, setPage]           = useState(1);
  const [limit]                   = useState(100);
  const [triggered, setTriggered] = useState(false);

  // Beim ersten Laden automatisch die letzten Einträge anzeigen (ohne Filter)
  useEffect(() => {
    setTriggered(true);
  }, []);

  const { data, isLoading, isFetching, refetch } = useQuery<{ items: TraceItem[]; total: number }>({
    queryKey: ['message-trace', sender, recipient, subject, status, fromDate, toDate, page],
    // WICHTIG: API-Client fügt /api/v1 automatisch hinzu → Pfad ohne /api/v1
    queryFn: () => api.get(
      `/admin/message-trace?sender=${encodeURIComponent(sender)}&recipient=${encodeURIComponent(recipient)}&subject=${encodeURIComponent(subject)}&status=${status}&from=${fromDate}&to=${toDate}&page=${page}&limit=${limit}`
    ),
    enabled: triggered,
  });

  function handleSearch() { setPage(1); setTriggered(true); void refetch(); }
  function handleReset() {
    setSender(''); setRecipient(''); setSubject('');
    setStatus(''); setFromDate(''); setToDate('');
    setPage(1); setTriggered(true);
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  function exportCsv() {
    const url = `/api/v1/admin/message-trace/export?sender=${encodeURIComponent(sender)}&recipient=${encodeURIComponent(recipient)}&from=${fromDate}&to=${toDate}`;
    window.open(url, '_blank');
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
          <Search size={22} className="text-blue-600" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">{pageTitle}</h1>
            <p className="text-sm text-gray-500">{pageSubtitle}</p>
          </div>
        </div>
        <button
          onClick={() => void refetch()}
          disabled={isLoading || isFetching}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw size={13} className={(isLoading || isFetching) ? 'animate-spin' : ''} />
          {labelRefresh}
        </button>
      </div>

      {/* Suchmaske */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
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
            <select value={status} onChange={e => setStatus(e.target.value)} className="input">
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
            <button onClick={exportCsv}
              className="btn-secondary flex items-center gap-1.5 text-xs">
              <Download size={13} /> {labelExport}
            </button>
            <button onClick={handleReset}
              className="btn-secondary flex items-center gap-1.5 text-xs text-gray-500">
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

      {/* Ergebnistabelle */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" /> {labelRunning}
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">
            <Search size={28} className="mx-auto mb-2 opacity-30" />
            {labelNoResults}
          </div>
        ) : (
          <>
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{labelTimestamp}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{labelFromTo}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{labelSubject}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{labelStatus}</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{labelDetails}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map(item => {
                  const m = item.metadata ?? {};
                  return (
                    <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                        {new Date(item.timestamp).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE')}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 text-sm">
                          <span className="text-gray-700">{m['sender'] || '–'}</span>
                          <ArrowRight size={12} className="text-gray-400 shrink-0" />
                          <span className="text-gray-700">{m['recipient'] || '–'}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm text-gray-700 truncate max-w-[200px]">
                          {m['subject'] || `(${labelNoSubject.replace('(', '').replace(')', '')})`}
                        </p>
                        {m['messageId'] && (
                          <p className="text-xs text-gray-400 font-mono">
                            {m['messageId'].slice(0, 30)}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={m['status'] ?? ''} lang={lang} />
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {m['reason'] && <span className="text-red-600">{m['reason']}</span>}
                        {m['spamScore'] && <span> {labelSpam} {m['spamScore']}</span>}
                        {m['size'] && <span> {Math.round(parseInt(m['size']) / 1024)} KB</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {pages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 text-sm text-gray-500">
                <span>{total} {labelEntries}</span>
                <div className="flex gap-1">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                    className="px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">‹</button>
                  <span className="px-3 py-1">{labelPage} {page} {labelOf} {pages}</span>
                  <button onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page === pages}
                    className="px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">›</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
