import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Download, Loader2, ArrowRight } from 'lucide-react';
import { api } from '../api/client.js';

interface TraceItem {
  id: string; timestamp: string; level: string; message: string;
  metadata: Record<string, string> | null;
}

function StatusBadge({ status }: { status: string }) {
  const base = 'px-2 py-0.5 rounded text-xs font-medium';
  if (status === 'ACCEPTED')  return <span className={`${base} bg-blue-100 text-blue-700`}>Angenommen</span>;
  if (status === 'DELIVERED') return <span className={`${base} bg-green-100 text-green-700`}>Zugestellt</span>;
  if (status === 'REJECTED')  return <span className={`${base} bg-red-100 text-red-700`}>Abgelehnt</span>;
  if (status === 'DEFERRED')  return <span className={`${base} bg-amber-100 text-amber-700`}>Zurückgestellt</span>;
  if (status === 'QUARANTINE') return <span className={`${base} bg-orange-100 text-orange-700`}>Quarantäne</span>;
  return <span className={`${base} bg-gray-100 text-gray-600`}>{status || '–'}</span>;
}

export function MessageTracePage() {
  const [sender, setSender]       = useState('');
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject]     = useState('');
  const [status, setStatus]       = useState('');
  const [fromDate, setFromDate]   = useState('');
  const [toDate, setToDate]       = useState('');
  const [page, setPage]           = useState(1);
  const [limit]                   = useState(100);
  const [triggered, setTriggered] = useState(false);

  const { data, isLoading, isFetching } = useQuery<{ items: TraceItem[]; total: number }>({
    queryKey: ['message-trace', sender, recipient, subject, status, fromDate, toDate, page],
    queryFn: () => api.get(
      `/api/v1/admin/message-trace?sender=${encodeURIComponent(sender)}&recipient=${encodeURIComponent(recipient)}&subject=${encodeURIComponent(subject)}&status=${status}&from=${fromDate}&to=${toDate}&page=${page}&limit=${limit}`
    ),
    enabled: triggered,
  });

  function handleSearch() { setPage(1); setTriggered(true); }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  function exportCsv() {
    const url = `/api/v1/admin/message-trace/export?sender=${encodeURIComponent(sender)}&recipient=${encodeURIComponent(recipient)}&from=${fromDate}&to=${toDate}`;
    window.open(url, '_blank');
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <Search size={22} className="text-blue-600" />
        <div>
          <h1 className="text-xl font-bold text-gray-900">Nachrichtenablaufverfolgung</h1>
          <p className="text-sm text-gray-500">E-Mail-Zustellungspfade nachverfolgen</p>
        </div>
      </div>

      {/* Suchmaske */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div>
            <label className="field-label">Absender</label>
            <input value={sender} onChange={e => setSender(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="input" placeholder="user@domain.com" />
          </div>
          <div>
            <label className="field-label">Empfänger</label>
            <input value={recipient} onChange={e => setRecipient(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="input" placeholder="user@domain.com" />
          </div>
          <div>
            <label className="field-label">Betreff (enthält)</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="input" placeholder="Re: Meeting" />
          </div>
          <div>
            <label className="field-label">Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)} className="input">
              <option value="">Alle</option>
              <option value="ACCEPTED">Angenommen</option>
              <option value="DELIVERED">Zugestellt</option>
              <option value="REJECTED">Abgelehnt</option>
              <option value="DEFERRED">Zurückgestellt</option>
              <option value="QUARANTINE">Quarantäne</option>
            </select>
          </div>
          <div>
            <label className="field-label">Von Datum</label>
            <input type="datetime-local" value={fromDate} onChange={e => setFromDate(e.target.value)} className="input" />
          </div>
          <div>
            <label className="field-label">Bis Datum</label>
            <input type="datetime-local" value={toDate} onChange={e => setToDate(e.target.value)} className="input" />
          </div>
        </div>
        <div className="flex justify-between items-center">
          <button onClick={exportCsv} className="btn-secondary flex items-center gap-1.5 text-xs">
            <Download size={13} /> CSV exportieren
          </button>
          <button onClick={handleSearch} disabled={isLoading || isFetching}
            className="btn-primary flex items-center gap-1.5">
            {(isLoading || isFetching) ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            Suchen
          </button>
        </div>
      </div>

      {/* Ergebnistabelle */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {!triggered ? (
          <div className="text-center py-12 text-gray-400 text-sm">
            <Search size={28} className="mx-auto mb-2 opacity-30" />
            Filter ausfüllen und Suchen klicken
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" /> Suche läuft…
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">Keine Nachrichten gefunden</div>
        ) : (
          <>
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Zeitstempel</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Von → An</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Betreff</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map(item => {
                  const m = item.metadata ?? {};
                  return (
                    <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                        {new Date(item.timestamp).toLocaleString('de-DE')}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 text-sm">
                          <span className="text-gray-700">{m['sender'] || '–'}</span>
                          <ArrowRight size={12} className="text-gray-400 shrink-0" />
                          <span className="text-gray-700">{m['recipient'] || '–'}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm text-gray-700 truncate max-w-[200px]">{m['subject'] || '(kein Betreff)'}</p>
                        {m['messageId'] && <p className="text-xs text-gray-400 font-mono">{m['messageId'].slice(0, 30)}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={m['status'] ?? ''} />
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {m['reason'] && <span className="text-red-600">{m['reason']}</span>}
                        {m['spamScore'] && <span> Spam: {m['spamScore']}</span>}
                        {m['size'] && <span> {Math.round(parseInt(m['size']) / 1024)} KB</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {pages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 text-sm text-gray-500">
                <span>{total} Einträge</span>
                <div className="flex gap-1">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                    className="px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">‹</button>
                  <span className="px-3 py-1">Seite {page} / {pages}</span>
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
