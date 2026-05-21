import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';

interface Log { id: string; timestamp: string; level: string; service: string; category: string; message: string }
interface LogsResponse { logs: Log[]; total: number }

const LEVEL_BADGE: Record<string, string> = {
  ERROR: 'badge-red',
  WARN: 'badge-yellow',
  INFO: 'badge-blue',
  DEBUG: 'badge-gray',
};

export function LogsPage() {
  const t = useT();
  const [level, setLevel] = useState('');
  const [service, setService] = useState('');
  const [q, setQ] = useState('');

  const params = new URLSearchParams({ limit: '100' });
  if (level) params.set('level', level);
  if (service) params.set('service', service);
  if (q) params.set('q', q);

  const { data } = useQuery({
    queryKey: ['admin-logs', level, service, q],
    queryFn: () => api.get<LogsResponse>(`/admin/logs?${params}`),
    refetchInterval: 15_000,
  });

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">{t('log_page_title')}</h1>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <select className="input w-40" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">{t('log_filter_all_levels')}</option>
          {['ERROR', 'WARN', 'INFO', 'DEBUG'].map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <input className="input w-44" placeholder={t('log_filter_service')} value={service} onChange={(e) => setService(e.target.value)} />
        <input className="input flex-1 min-w-48" placeholder={t('log_filter_message')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500">
          {data?.total ?? 0} {t('log_entries')}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {[t('log_col_time'), t('log_col_level'), t('log_col_service'), t('log_col_message')].map((h) => (
                  <th key={h} className="text-left px-3 py-2 font-medium text-gray-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {(data?.logs ?? []).map((log) => (
                <tr key={log.id} className="hover:bg-gray-50 transition-colors font-mono">
                  <td className="px-3 py-1.5 text-gray-400 whitespace-nowrap">
                    {format(new Date(log.timestamp), 'HH:mm:ss.SSS')}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`badge ${LEVEL_BADGE[log.level] ?? 'badge-gray'}`}>{log.level}</span>
                  </td>
                  <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{log.service}</td>
                  <td className="px-3 py-1.5 text-gray-700 max-w-lg truncate">{log.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data?.logs ?? []).length === 0 && (
            <div className="py-8 text-center text-gray-400 text-sm">{t('log_empty')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
