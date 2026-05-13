import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Trash2, AlertCircle } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';

interface QueueStat { name: string; count: number }

export function QueuesPage() {
  const qc = useQueryClient();

  const { data: queues, refetch } = useQuery({
    queryKey: ['admin-queues'],
    queryFn: () => api.get<QueueStat[]>('/admin/queues'),
    refetchInterval: 5_000,
  });

  const flushMutation = useMutation({
    mutationFn: (name: string) => api.post(`/admin/queues/${name}/flush`),
    onSuccess: () => { toast.success('Queue geleert'); qc.invalidateQueries({ queryKey: ['admin-queues'] }); },
    onError: (err: Error) => toast.error(err.message),
  });

  const queueColor = (q: QueueStat) => {
    if (q.name.includes('dead') && q.count > 0) return 'badge-red';
    if (q.count > 100) return 'badge-yellow';
    return 'badge-green';
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">SMTP-Warteschlangen</h1>
        <button onClick={() => refetch()} className="btn-secondary text-xs"><RefreshCw size={13} /> Aktualisieren</button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {(queues ?? []).map((q) => (
          <div key={q.name} className="card flex items-center justify-between gap-4">
            <div>
              <p className="font-mono text-sm text-gray-700">{q.name}</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{q.count}</p>
              <span className={`badge mt-1 ${queueColor(q)}`}>
                {q.name.includes('dead') && q.count > 0 ? 'Fehler' : q.count > 100 ? 'Hoch' : 'Normal'}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {q.name.includes('dead') && (
                <button
                  onClick={() => { if (confirm(`Queue "${q.name}" leeren?`)) flushMutation.mutate(q.name); }}
                  className="btn-danger text-xs">
                  <Trash2 size={13} /> Leeren
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {queues?.some((q) => q.name.includes('dead') && q.count > 0) && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Dead-Letter-Queue nicht leer</p>
            <p className="text-xs mt-0.5 text-red-600">Nachrichten konnten nicht zugestellt werden. Bitte prüfen Sie die Protokolle.</p>
          </div>
        </div>
      )}
    </div>
  );
}
