import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { RotateCcw } from 'lucide-react';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { LOG_LEVEL_SERVICES, LOG_LEVELS, effectiveLogLevel, type LogLevel } from '../lib/logLevels.js';

interface Log { id: string; timestamp: string; level: string; service: string; category: string; message: string }
interface LogsResponse { logs: Log[]; total: number }

const LEVEL_BADGE: Record<string, string> = {
  ERROR: 'badge-red',
  WARN: 'badge-yellow',
  INFO: 'badge-blue',
  DEBUG: 'badge-gray',
};

/** Per-service runtime log level (GET/PUT/DELETE /admin/logs/levels). */
function LogLevelPanel() {
  const t = useT();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const writable = can('servers', 'write');
  const { data: levels = {} } = useQuery({
    queryKey: ['admin-log-levels'],
    queryFn: () => api.get<Record<string, string>>('/admin/logs/levels'),
  });
  const done = () => { toast.success(t('log_levels_saved')); void qc.invalidateQueries({ queryKey: ['admin-log-levels'] }); };
  const setLevel = useMutation({
    mutationFn: ({ key, level }: { key: string; level: LogLevel }) => api.put('/admin/logs/levels', { [key]: level }),
    onSuccess: done,
  });
  const reset = useMutation({
    mutationFn: (key: string) => api.delete(`/admin/logs/levels/${encodeURIComponent(key)}`),
    onSuccess: done,
  });
  const busy = setLevel.isPending || reset.isPending;

  const rows = [{ key: '*', aliases: [] as readonly string[] }, ...LOG_LEVEL_SERVICES];
  return (
    <div className="card space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-fg">{t('log_levels_title')}</h2>
        <p className="text-xs text-fg-subtle mt-0.5">{t('log_levels_hint')}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
        {rows.map(({ key, aliases }) => {
          const own = levels[key];
          const eff = effectiveLogLevel(levels, key, aliases);
          return (
            <div key={key} className="flex items-center gap-2 text-xs">
              <span className="flex-1 font-mono text-fg-muted truncate">{key === '*' ? t('log_levels_all_services') : key}</span>
              <select
                className="input w-28 py-1 text-xs"
                aria-label={`${t('log_levels_title')}: ${key}`}
                value={own ?? ''}
                disabled={!writable || busy}
                onChange={(e) => { if (e.target.value) setLevel.mutate({ key, level: e.target.value as LogLevel }); }}
              >
                <option value="">{eff && key !== '*' ? `${t('log_levels_default')} (${eff})` : t('log_levels_default')}</option>
                {LOG_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <button
                type="button"
                onClick={() => reset.mutate(key)}
                disabled={!writable || busy || !own}
                title={t('log_levels_reset')}
                aria-label={`${t('log_levels_reset')}: ${key}`}
                className="p-1 rounded text-fg-subtle hover:text-fg hover:bg-surface-2 disabled:invisible"
              >
                <RotateCcw size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LogsPage() {
  const t = useT();
  const [level, setLevel] = useState('');
  const [service, setService] = useState('');
  const [q, setQ] = useState('');

  const params = new URLSearchParams({ limit: '200' });
  if (level) params.set('level', level);
  if (service.trim()) params.set('service', service.trim());
  if (q.trim()) params.set('q', q.trim());

  const { data } = useQuery({
    queryKey: ['admin-logs', level, service.trim(), q.trim()],
    queryFn: () => api.get<LogsResponse>(`/admin/logs?${params}`),
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  });
  const logs = data?.logs ?? [];

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold text-fg">{t('log_page_title')}</h1>

      <LogLevelPanel />

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <select className="input w-40" value={level} onChange={(e) => setLevel(e.target.value)} aria-label={t('log_col_level')}>
          <option value="">{t('log_filter_all_levels')}</option>
          {LOG_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <input className="input w-44" placeholder={t('log_filter_service')} aria-label={t('log_filter_service')} value={service} onChange={(e) => setService(e.target.value)} />
        <input className="input flex-1 min-w-48" placeholder={t('log_filter_message')} aria-label={t('log_filter_message')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-2 bg-surface-2 border-b border-line text-xs text-fg-subtle">
          {logs.length < (data?.total ?? 0) ? `${logs.length} / ` : ''}{data?.total ?? 0} {t('log_entries')}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-surface-2 border-b border-line">
              <tr>
                {[t('log_col_time'), t('log_col_level'), t('log_col_service'), t('log_col_message')].map((h) => (
                  <th key={h} className="text-left px-3 py-2 font-medium text-fg-subtle">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-surface-2 transition-colors font-mono">
                  <td className="px-3 py-1.5 text-fg-subtle whitespace-nowrap">
                    {format(new Date(log.timestamp), 'dd.MM.yyyy HH:mm:ss.SSS')}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`badge ${LEVEL_BADGE[log.level] ?? 'badge-gray'}`}>{log.level}</span>
                  </td>
                  <td className="px-3 py-1.5 text-fg-subtle whitespace-nowrap">{log.service}</td>
                  <td className="px-3 py-1.5 text-fg-muted max-w-lg truncate" title={log.message}>{log.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && (
            <div className="py-8 text-center text-fg-subtle text-sm">{t('log_empty')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
