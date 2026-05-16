import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Trash2, AlertCircle, Mail, ChevronDown, ChevronRight, RotateCcw, Inbox } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';

// ─── Types ────────────────────────────────────────────────────────────────────

interface QueueStat { name: string; count: number }

interface QueueJob {
  index: number;
  data: {
    id?: string;
    messageId?: string;
    from?: string;
    mailfrom?: string;
    envelope?: { from?: string; to?: string[] };
    to?: string | string[];
    rcptto?: string[];
    recipients?: string[];
    subject?: string;
    attempts?: number;
    retries?: number;
    queuedAt?: string;
    createdAt?: string;
    lastError?: string;
    error?: string;
    size?: number;
  };
}

interface JobsResponse { jobs: QueueJob[]; total: number; limit: number; offset: number }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const QUEUE_LABELS: Record<string, { label: string; description: string; color: string }> = {
  'smtp:outbound':       { label: 'Ausgehend',  description: 'Mails warten auf Zustellung',       color: 'blue' },
  'smtp:outbound:retry': { label: 'Retry',      description: 'Fehlgeschlagene Mails im Retry',    color: 'yellow' },
  'smtp:outbound:dead':  { label: 'Dead Letter', description: 'Dauerhaft nicht zustellbar',        color: 'red' },
  'smtp:inbound':        { label: 'Eingehend',   description: 'Mails in Verarbeitung',             color: 'green' },
};

const COLOR_CLASSES = {
  blue:   { card: 'border-blue-200 bg-blue-50',   badge: 'bg-blue-100 text-blue-700',   dot: 'bg-blue-400' },
  yellow: { card: 'border-yellow-200 bg-yellow-50', badge: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-400' },
  red:    { card: 'border-red-200 bg-red-50',     badge: 'bg-red-100 text-red-700',     dot: 'bg-red-400' },
  green:  { card: 'border-green-200 bg-green-50', badge: 'bg-green-100 text-green-700', dot: 'bg-green-400' },
};

function extractField(job: QueueJob): { from: string; to: string; subject: string; attempts: number; date: string; error: string } {
  const d = job.data;
  const from =
    d.envelope?.from ?? d.from ?? d.mailfrom ?? '—';
  const toArr =
    d.envelope?.to ?? d.rcptto ?? d.recipients ?? (d.to ? (Array.isArray(d.to) ? d.to : [d.to]) : []);
  const to = toArr.length > 0 ? toArr.join(', ') : '—';
  const subject = d.subject ?? '(kein Betreff)';
  const attempts = d.attempts ?? d.retries ?? 0;
  const date = d.queuedAt ?? d.createdAt ?? '';
  const error = d.lastError ?? d.error ?? '';
  return { from, to, subject, attempts, date, error };
}

function fmtDt(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const PAGE_SIZE = 50;

// ─── Queue Detail Table ───────────────────────────────────────────────────────

function QueueDetail({ queueName, onClose }: { queueName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const encodedName = encodeURIComponent(queueName);

  const { data, isLoading, refetch } = useQuery<JobsResponse>({
    queryKey: ['admin-queue-jobs', queueName, offset],
    queryFn: () => api.get(`/admin/queues/${encodedName}/jobs?limit=${PAGE_SIZE}&offset=${offset}`),
    refetchInterval: 10_000,
  });

  const del = useMutation({
    mutationFn: (index: number) => api.delete(`/admin/queues/${encodedName}/jobs/${index}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-queue-jobs', queueName] });
      void qc.invalidateQueries({ queryKey: ['admin-queues'] });
      toast.success('Mail aus Queue entfernt');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const flush = useMutation({
    mutationFn: () => api.post(`/admin/queues/${encodedName}/flush`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-queue-jobs', queueName] });
      void qc.invalidateQueries({ queryKey: ['admin-queues'] });
      toast.success('Queue geleert');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const info = QUEUE_LABELS[queueName];
  const jobs = data?.jobs ?? [];
  const total = data?.total ?? 0;
  const pages = Math.ceil(total / PAGE_SIZE);
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="mt-6 bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <ChevronDown size={16} />
          </button>
          <div>
            <p className="text-sm font-semibold text-gray-900">{info?.label ?? queueName}</p>
            <p className="text-xs text-gray-500 font-mono">{queueName} · {total} Nachrichten</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} className="flex items-center gap-1 px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded hover:bg-gray-50">
            <RefreshCw size={12} /> Aktualisieren
          </button>
          {queueName.includes('dead') && (
            <button onClick={() => { if (confirm('Alle Nachrichten aus der Dead-Letter-Queue löschen?')) flush.mutate(); }}
              className="flex items-center gap-1 px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50">
              <Trash2 size={12} /> Queue leeren
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <th className="text-left px-4 py-2.5 w-6" />
            <th className="text-left px-4 py-2.5">Absender</th>
            <th className="text-left px-4 py-2.5">Empfänger</th>
            <th className="text-left px-4 py-2.5">Betreff</th>
            <th className="text-left px-4 py-2.5">Eingestellt</th>
            <th className="text-center px-4 py-2.5">Versuche</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <tr><td colSpan={7} className="text-center py-10 text-gray-400">Laden…</td></tr>
          ) : jobs.length === 0 ? (
            <tr><td colSpan={7} className="text-center py-10 text-gray-400">Keine Nachrichten in dieser Queue</td></tr>
          ) : jobs.map(job => {
            const { from, to, subject, attempts, date, error } = extractField(job);
            const isExpanded = expandedIdx === job.index;
            return (
              <>
                <tr key={job.index}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedIdx(isExpanded ? null : job.index)}>
                  <td className="px-4 py-2.5 text-gray-400">
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <Mail size={12} className="text-gray-400 shrink-0" />
                      <span className="text-xs font-mono text-gray-700 truncate max-w-[160px]">{from}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono text-gray-700 truncate max-w-[160px]">{to}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-800 truncate max-w-[180px]">{subject}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{fmtDt(date)}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                      attempts > 3 ? 'bg-red-100 text-red-700' : attempts > 0 ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'
                    }`}>{attempts}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <button onClick={e => { e.stopPropagation(); del.mutate(job.index); }}
                      className="text-gray-400 hover:text-red-500 transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr key={`${job.index}-detail`}>
                    <td colSpan={7} className="p-0">
                      <div className="bg-gray-50 border-t border-gray-100 px-8 py-3 text-xs space-y-1">
                        <div><span className="text-gray-500 w-24 inline-block">Von:</span><span className="font-mono text-gray-800">{from}</span></div>
                        <div><span className="text-gray-500 w-24 inline-block">An:</span><span className="font-mono text-gray-800">{to}</span></div>
                        <div><span className="text-gray-500 w-24 inline-block">Betreff:</span><span className="text-gray-800">{subject}</span></div>
                        {date && <div><span className="text-gray-500 w-24 inline-block">Eingestellt:</span><span className="text-gray-800">{new Date(date).toLocaleString('de-DE')}</span></div>}
                        {attempts > 0 && <div><span className="text-gray-500 w-24 inline-block">Versuche:</span><span className="text-gray-800">{attempts}</span></div>}
                        {error && (
                          <div className="mt-1 p-2 bg-red-50 border border-red-100 rounded">
                            <span className="text-red-500 font-medium">Fehler: </span>
                            <span className="text-red-700">{error}</span>
                          </div>
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

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
          <span>{total} Nachrichten · Seite {page} / {pages}</span>
          <div className="flex gap-1">
            <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}
              className="px-3 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">← Zurück</button>
            <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}
              className="px-3 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">Weiter →</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function QueuesPage() {
  const qc = useQueryClient();
  const [selectedQueue, setSelectedQueue] = useState<string | null>(null);

  const { data: queues, refetch } = useQuery<QueueStat[]>({
    queryKey: ['admin-queues'],
    queryFn: () => api.get('/admin/queues'),
    refetchInterval: 5_000,
  });

  const flush = useMutation({
    mutationFn: (name: string) => api.post(`/admin/queues/${encodeURIComponent(name)}/flush`),
    onSuccess: (_d, name) => {
      void qc.invalidateQueries({ queryKey: ['admin-queues'] });
      if (selectedQueue === name) setSelectedQueue(null);
      toast.success('Queue geleert');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const hasDeadLetters = queues?.some(q => q.name.includes('dead') && q.count > 0);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Inbox size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">SMTP-Warteschlangen</h1>
            <p className="text-sm text-gray-500">Ausgehende und eingehende Nachrichten in Echtzeit</p>
          </div>
        </div>
        <button onClick={() => refetch()}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">
          <RefreshCw size={13} /> Aktualisieren
        </button>
      </div>

      {/* Queue cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-2">
        {(queues ?? []).map(q => {
          const meta = QUEUE_LABELS[q.name] ?? { label: q.name, description: '', color: 'blue' };
          const colorKey = (q.name.includes('dead') && q.count > 0) ? 'red'
            : q.count > 100 ? 'yellow'
            : meta.color as keyof typeof COLOR_CLASSES;
          const cls = COLOR_CLASSES[colorKey] ?? COLOR_CLASSES.blue;
          const isSelected = selectedQueue === q.name;

          return (
            <button key={q.name}
              onClick={() => setSelectedQueue(isSelected ? null : q.name)}
              className={`text-left rounded-lg border p-4 transition-all hover:shadow-md ${cls.card} ${
                isSelected ? 'ring-2 ring-accent ring-offset-1' : ''
              }`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${cls.dot}`} />
                  <span className="text-xs font-semibold text-gray-700">{meta.label}</span>
                </div>
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${cls.badge}`}>
                  {q.count > 0 ? q.count : 'leer'}
                </span>
              </div>
              <p className="text-2xl font-bold text-gray-900">{q.count.toLocaleString('de-DE')}</p>
              <p className="text-xs text-gray-500 mt-1 truncate">{meta.description}</p>
              <div className="flex items-center gap-2 mt-3">
                <span className="text-xs text-accent font-medium">
                  {isSelected ? '▲ Schließen' : '▼ Öffnen'}
                </span>
                {q.name.includes('dead') && q.count > 0 && (
                  <button onClick={e => { e.stopPropagation(); if (confirm(`Queue „${meta.label}" leeren?`)) flush.mutate(q.name); }}
                    className="ml-auto text-xs text-red-600 hover:underline flex items-center gap-1">
                    <RotateCcw size={11} /> Leeren
                  </button>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Dead letter warning */}
      {hasDeadLetters && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 mb-4">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Dead-Letter-Queue nicht leer</p>
            <p className="text-xs mt-0.5 text-red-600">
              Nachrichten konnten dauerhaft nicht zugestellt werden. Queue öffnen und Fehlerursache prüfen.
            </p>
          </div>
        </div>
      )}

      {/* Detail panel */}
      {selectedQueue && (
        <QueueDetail
          queueName={selectedQueue}
          onClose={() => setSelectedQueue(null)}
        />
      )}
    </div>
  );
}
