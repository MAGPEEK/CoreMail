import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  HardDriveDownload, Play, RefreshCw, Upload, AlertCircle, CheckCircle2,
  Loader2, Clock, Database, X, User as UserIcon, CalendarClock, Plus, Trash2,
  Pencil, PauseCircle, Archive, ListChecks,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

/**
 * v3.18.28 BackupsPage v3 — Tab-basierte UI mit:
 * - Tab „Backup-Jobs" (Status-Log mit Delete + Download per Stream-Proxy)
 * - Tab „Schnellaktionen" (Vollbackup + Mailbox-Backup)
 * - Tab „Zeitpläne" (Cron CRUD mit Dropdown-Editor)
 * - Tab „Archiv" (alias S3-Snapshots, umbenannt)
 * - Tab „Restore" (MBOX-Import)
 *
 * Fixes:
 * - „S3-Snapshots" → „Backup-Archiv" (AWS-Begriff vermeiden)
 * - Backup-Jobs können gelöscht werden
 * - Download funktioniert (Stream-Proxy via api-gateway)
 * - Cron-Editor mit Wochentag/Stunde/Minute-Dropdowns (statt freitext)
 */

type JobStatus =
  | 'PENDING' | 'SCHEDULED' | 'PROCESSING' | 'RUNNING' | 'RETRYING'
  | 'COMPLETED' | 'FAILED' | 'ABORTED' | 'EXPIRED';

interface BackupJob {
  id: string;
  userId: string | null;
  scope: string;
  format: string;
  status: JobStatus;
  progress: number;
  downloadUrl: string | null;
  expiresAt: string | null;
  errorMsg: string | null;
  errorClass: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  sizeBytes: string | null;
  messageCount: number | null;
  triggeredBy: string;
  createdAt: string;
}

interface BackupSchedule {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  scope: string;
  format: string;
  targetUserId: string | null;
  retentionDays: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  createdAt: string;
}

interface UserItem { id: string; email: string; displayName: string | null }
interface S3BackupObject { key: string; size: number; lastModified: string }

const STATUS_LABEL: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  PENDING:    { label: 'Wartet',      color: 'text-gray-500',  icon: <Clock      size={13} /> },
  SCHEDULED:  { label: 'Geplant',     color: 'text-indigo-500',icon: <CalendarClock size={13} /> },
  PROCESSING: { label: 'Läuft',       color: 'text-blue-600',  icon: <Loader2    size={13} className="animate-spin" /> },
  RUNNING:    { label: 'Läuft',       color: 'text-blue-600',  icon: <Loader2    size={13} className="animate-spin" /> },
  RETRYING:   { label: 'Retry',       color: 'text-amber-600', icon: <RefreshCw  size={13} className="animate-spin" /> },
  COMPLETED:  { label: 'Fertig',      color: 'text-green-600', icon: <CheckCircle2 size={13} /> },
  FAILED:     { label: 'Fehler',      color: 'text-red-600',   icon: <AlertCircle size={13} /> },
  ABORTED:    { label: 'Abgebrochen', color: 'text-gray-400',  icon: <X          size={13} /> },
  EXPIRED:    { label: 'Abgelaufen',  color: 'text-gray-400',  icon: <Clock      size={13} /> },
};

function fmtBytes(n: number | string | null): string {
  if (n === null || n === undefined) return '—';
  const num = typeof n === 'string' ? Number(n) : n;
  if (!isFinite(num) || num < 0) return '—';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtDuration(ms: number | null): string {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

type Tab = 'jobs' | 'actions' | 'schedules' | 'archive' | 'restore';

export function BackupsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('jobs');
  const [scheduleEditor, setScheduleEditor] = useState<Partial<BackupSchedule> | null>(null);

  const { data: jobsData = [], isLoading: jobsLoading, refetch: refetchJobs } = useQuery<BackupJob[]>({
    queryKey: ['admin-backups-jobs'],
    queryFn:  () => api.get<BackupJob[]>('/admin/backups/jobs?limit=50'),
    refetchInterval: (q) => {
      const data = q.state.data as BackupJob[] | undefined;
      return data?.some((j) => ['RUNNING', 'PROCESSING', 'PENDING', 'RETRYING'].includes(j.status)) ? 3_000 : 60_000;
    },
  });

  const { data: s3Data = [] } = useQuery<S3BackupObject[]>({
    queryKey: ['admin-backups-s3'],
    queryFn:  () => api.get<S3BackupObject[]>('/admin/backups/list?limit=50'),
    staleTime: 60_000,
  });

  const { data: schedules = [] } = useQuery<BackupSchedule[]>({
    queryKey: ['admin-backups-schedules'],
    queryFn:  () => api.get<BackupSchedule[]>('/admin/backups/schedules'),
    staleTime: 30_000,
  });

  const { data: users = [] } = useQuery<UserItem[]>({
    queryKey: ['admin-backups-users'],
    queryFn:  () => api.get<UserItem[]>('/admin/backups/users'),
    staleTime: 5 * 60_000,
  });

  // ─── Mutations ────────────────────────────────────────────────────────────
  const triggerFullBackup = useMutation({
    mutationFn: () => api.post<{ jobId: string }>('/admin/backups/full', {}),
    onSuccess: (r) => {
      toast.success(`Vollbackup gestartet (${r.jobId.slice(0, 8)})`);
      void qc.invalidateQueries({ queryKey: ['admin-backups-jobs'] });
      setTab('jobs');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const triggerMailboxBackup = useMutation({
    mutationFn: (vars: { userId: string; format: 'zip' | 'mbox' }) =>
      api.post<{ jobId: string; userEmail: string }>(`/admin/backups/mailbox/${vars.userId}`, { format: vars.format }),
    onSuccess: (r) => {
      toast.success(`Backup für ${r.userEmail} gestartet`);
      void qc.invalidateQueries({ queryKey: ['admin-backups-jobs'] });
      setTab('jobs');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteJob = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/backups/jobs/${id}`),
    onSuccess: () => {
      toast.success('Backup gelöscht');
      void qc.invalidateQueries({ queryKey: ['admin-backups-jobs'] });
      void qc.invalidateQueries({ queryKey: ['admin-backups-s3'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createSchedule = useMutation({
    mutationFn: (s: Partial<BackupSchedule>) => api.post('/admin/backups/schedules', s),
    onSuccess: () => { toast.success('Zeitplan erstellt'); setScheduleEditor(null); void qc.invalidateQueries({ queryKey: ['admin-backups-schedules'] }); },
    onError: (err: Error) => toast.error(err.message),
  });
  const updateSchedule = useMutation({
    mutationFn: (vars: { id: string; data: Partial<BackupSchedule> }) =>
      api.put(`/admin/backups/schedules/${vars.id}`, vars.data),
    onSuccess: () => { toast.success('Zeitplan aktualisiert'); setScheduleEditor(null); void qc.invalidateQueries({ queryKey: ['admin-backups-schedules'] }); },
    onError: (err: Error) => toast.error(err.message),
  });
  const deleteSchedule = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/backups/schedules/${id}`),
    onSuccess: () => { toast.success('Zeitplan gelöscht'); void qc.invalidateQueries({ queryKey: ['admin-backups-schedules'] }); },
    onError: (err: Error) => toast.error(err.message),
  });
  const runScheduleNow = useMutation({
    mutationFn: (id: string) => api.post(`/admin/backups/schedules/${id}/run-now`, {}),
    onSuccess: () => { toast.success('Zeitplan getriggert'); void qc.invalidateQueries({ queryKey: ['admin-backups-jobs'] }); setTab('jobs'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const userEmailById = (id: string | null): string => {
    if (!id) return '—';
    const u = users.find((x) => x.id === id);
    return u?.email ?? id.slice(0, 8);
  };

  // Download via Auth-Token (kein direct href — backend braucht Bearer)
  const downloadJob = async (jobId: string, filenameHint?: string) => {
    const token = localStorage.getItem('bcp-token') ?? '';
    try {
      const res = await fetch(`/api/v1/admin/backups/download/${encodeURIComponent(jobId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filenameHint ?? `backup-${jobId.slice(0, 8)}.bin`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download fehlgeschlagen');
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <HardDriveDownload size={22} className="text-accent" />
            Backup &amp; Restore
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Backups verwalten, Zeitpläne konfigurieren, Daten wiederherstellen.
          </p>
        </div>
        <button
          onClick={() => { void refetchJobs(); toast.success('Aktualisiert'); }}
          disabled={jobsLoading}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
        >
          <RefreshCw size={14} className={jobsLoading ? 'animate-spin' : ''} />
          Aktualisieren
        </button>
      </div>

      {/* TABS */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex gap-1 overflow-x-auto">
          <TabBtn active={tab === 'jobs'} onClick={() => setTab('jobs')} icon={<ListChecks size={14} />} label="Jobs" badge={jobsData.length} />
          <TabBtn active={tab === 'actions'} onClick={() => setTab('actions')} icon={<Play size={14} />} label="Schnellaktionen" />
          <TabBtn active={tab === 'schedules'} onClick={() => setTab('schedules')} icon={<CalendarClock size={14} />} label="Zeitpläne" badge={schedules.length} />
          <TabBtn active={tab === 'archive'} onClick={() => setTab('archive')} icon={<Archive size={14} />} label="Backup-Archiv" badge={s3Data.length} />
          <TabBtn active={tab === 'restore'} onClick={() => setTab('restore')} icon={<Upload size={14} />} label="Restore (Import)" />
        </nav>
      </div>

      {/* TAB: Jobs */}
      {tab === 'jobs' && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
          {jobsLoading ? (
            <div className="p-8 text-center text-gray-400"><Loader2 size={20} className="animate-spin mx-auto" /></div>
          ) : jobsData.length === 0 ? (
            <div className="p-12 text-center text-gray-400">
              <ListChecks size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">Noch keine Backup-Jobs vorhanden</p>
              <button onClick={() => setTab('actions')} className="mt-3 text-accent hover:underline text-sm">→ Erstes Backup starten</button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800 text-xs uppercase text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Datum</th>
                  <th className="px-3 py-2 text-left font-medium">Scope/User</th>
                  <th className="px-3 py-2 text-left font-medium">Format</th>
                  <th className="px-3 py-2 text-left font-medium">Trigger</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Dauer</th>
                  <th className="px-3 py-2 text-right font-medium">Größe</th>
                  <th className="px-3 py-2 text-right font-medium">Mails</th>
                  <th className="px-3 py-2 text-right font-medium">Aktionen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {jobsData.map((j) => {
                  const st = STATUS_LABEL[j.status] ?? { label: j.status, color: 'text-gray-500', icon: null };
                  return (
                    <tr key={j.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-3 py-2 text-gray-700 dark:text-gray-200 whitespace-nowrap text-xs">{fmtDate(j.createdAt)}</td>
                      <td className="px-3 py-2 text-gray-700 dark:text-gray-200 text-xs">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded">
                          {j.scope}{j.userId ? ` · ${userEmailById(j.userId)}` : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-600 dark:text-gray-300 uppercase text-xs">{j.format}</td>
                      <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{j.triggeredBy}</td>
                      <td className={`px-3 py-2 ${st.color} text-xs`}>
                        <span className="inline-flex items-center gap-1.5">{st.icon} {st.label}</span>
                        {(j.status === 'RUNNING' || j.status === 'PROCESSING') && j.progress > 0 && (
                          <div className="mt-1 w-20 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div className="h-full bg-accent transition-all" style={{ width: `${j.progress}%` }} />
                          </div>
                        )}
                        {j.errorMsg && (
                          <div className="text-[10px] text-red-500 mt-1" title={j.errorMsg}>
                            {j.errorClass ? `[${j.errorClass}] ` : ''}{j.errorMsg.slice(0, 40)}{j.errorMsg.length > 40 ? '…' : ''}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300">{fmtDuration(j.durationMs)}</td>
                      <td className="px-3 py-2 text-right text-xs text-gray-600 dark:text-gray-300">{fmtBytes(j.sizeBytes)}</td>
                      <td className="px-3 py-2 text-right text-xs text-gray-600 dark:text-gray-300">{j.messageCount ?? '—'}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {j.status === 'COMPLETED' && j.downloadUrl && (
                            <button
                              onClick={() => void downloadJob(j.id, j.downloadUrl?.split('/').pop())}
                              className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded"
                              title="Backup herunterladen"
                            >
                              <HardDriveDownload size={13} />
                            </button>
                          )}
                          <button
                            onClick={() => {
                              if (window.confirm(`Backup-Job vom ${fmtDate(j.createdAt)} wirklich löschen? (S3-Object wird auch entfernt)`)) {
                                deleteJob.mutate(j.id);
                              }
                            }}
                            disabled={deleteJob.isPending}
                            className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded disabled:opacity-50"
                            title="Job löschen"
                          >
                            <Trash2 size={13} />
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
      )}

      {/* TAB: Schnellaktionen */}
      {tab === 'actions' && (
        <ActionsTab
          users={users}
          onFullBackup={() => triggerFullBackup.mutate()}
          fullPending={triggerFullBackup.isPending}
          onMailboxBackup={(uid, fmt) => triggerMailboxBackup.mutate({ userId: uid, format: fmt })}
          mailboxPending={triggerMailboxBackup.isPending}
        />
      )}

      {/* TAB: Zeitpläne */}
      {tab === 'schedules' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button
              onClick={() => setScheduleEditor({ name: '', cron: '0 2 * * *', scope: 'full', format: 'zip', retentionDays: 30, enabled: true })}
              className="text-xs px-3 py-1.5 bg-accent text-white rounded hover:bg-accent/90 flex items-center gap-1.5"
            >
              <Plus size={12} /> Neuer Zeitplan
            </button>
          </div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
            {schedules.length === 0 ? (
              <div className="p-12 text-center text-gray-400">
                <CalendarClock size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">Noch keine Zeitpläne — erstelle einen für tägliches oder wöchentliches automatisches Backup</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800 text-xs uppercase text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Name</th>
                    <th className="px-4 py-2 text-left font-medium">Cron</th>
                    <th className="px-4 py-2 text-left font-medium">Scope</th>
                    <th className="px-4 py-2 text-left font-medium">Aktiv</th>
                    <th className="px-4 py-2 text-left font-medium">Letzter Lauf</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {schedules.map((s) => (
                    <tr key={s.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">{s.name}</td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">{s.cron}</td>
                      <td className="px-4 py-2 text-gray-600 dark:text-gray-300 text-xs">
                        {s.scope}{s.targetUserId ? ` (${userEmailById(s.targetUserId)})` : ''} · {s.format}
                      </td>
                      <td className="px-4 py-2">
                        {s.enabled ? <CheckCircle2 size={14} className="text-green-600" /> : <PauseCircle size={14} className="text-gray-400" />}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{fmtDate(s.lastRunAt)}</td>
                      <td className="px-4 py-2 text-xs">{s.lastStatus ?? '—'}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => runScheduleNow.mutate(s.id)} disabled={runScheduleNow.isPending}
                            className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded disabled:opacity-50" title="Jetzt ausführen">
                            <Play size={13} />
                          </button>
                          <button onClick={() => setScheduleEditor(s)}
                            className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded" title="Bearbeiten">
                            <Pencil size={13} />
                          </button>
                          <button onClick={() => { if (window.confirm(`Zeitplan „${s.name}" löschen?`)) deleteSchedule.mutate(s.id); }}
                            className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded" title="Löschen">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* TAB: Backup-Archiv (vorher „S3-Snapshots") */}
      {tab === 'archive' && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
          <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400">
            {s3Data.length} Objekt{s3Data.length === 1 ? '' : 'e'} im Backup-Bucket — werden je nach Retention-Policy automatisch gelöscht.
          </div>
          {s3Data.length === 0 ? (
            <div className="p-12 text-center text-gray-400">
              <Archive size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">Keine Snapshots im Archiv</p>
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800 text-xs uppercase text-gray-500 dark:text-gray-400 sticky top-0">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Speicherort</th>
                    <th className="px-4 py-2 text-right font-medium">Größe</th>
                    <th className="px-4 py-2 text-left font-medium">Geändert</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {s3Data.map((b) => (
                    <tr key={b.key} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200 truncate max-w-md">{b.key}</td>
                      <td className="px-4 py-2 text-right text-gray-600 dark:text-gray-300">{fmtBytes(b.size)}</td>
                      <td className="px-4 py-2 text-gray-600 dark:text-gray-300">{fmtDate(b.lastModified)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB: Restore */}
      {tab === 'restore' && <RestoreTab users={users} />}

      {/* Schedule-Editor */}
      {scheduleEditor && (
        <ScheduleEditorModal
          initial={scheduleEditor}
          users={users}
          onClose={() => setScheduleEditor(null)}
          onSave={(data) => {
            if (scheduleEditor.id) updateSchedule.mutate({ id: scheduleEditor.id, data });
            else createSchedule.mutate(data);
          }}
          saving={createSchedule.isPending || updateSchedule.isPending}
        />
      )}
    </div>
  );
}

// ─── Tab-Button ─────────────────────────────────────────────────────────────
function TabBtn(props: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button
      onClick={props.onClick}
      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        props.active
          ? 'border-accent text-accent'
          : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:border-gray-300'
      }`}
    >
      {props.icon}
      {props.label}
      {props.badge !== undefined && props.badge > 0 && (
        <span className={`ml-1 px-1.5 py-0.5 text-[10px] rounded-full ${props.active ? 'bg-accent/20 text-accent' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
          {props.badge}
        </span>
      )}
    </button>
  );
}

// ─── Tab: Schnellaktionen ───────────────────────────────────────────────────
function ActionsTab(props: {
  users: UserItem[];
  onFullBackup: () => void;
  fullPending: boolean;
  onMailboxBackup: (userId: string, format: 'zip' | 'mbox') => void;
  mailboxPending: boolean;
}) {
  const [mailboxUserId, setMailboxUserId] = useState('');
  const [mailboxFormat, setMailboxFormat] = useState<'zip' | 'mbox'>('zip');

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Vollbackup */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-5">
        <div className="flex items-start gap-3 mb-3">
          <Database size={20} className="text-accent mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Vollbackup aller Mailboxen</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Erstellt einen Snapshot aller aktiven User-Postfächer als ZIP-Archive im Backup-Bucket.
            </p>
          </div>
        </div>
        <button
          onClick={props.onFullBackup}
          disabled={props.fullPending}
          className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-sm bg-accent hover:bg-accent/90 text-white rounded disabled:opacity-50"
        >
          <Play size={14} />
          {props.fullPending ? 'Wird gestartet…' : 'Vollbackup jetzt starten'}
        </button>
      </div>

      {/* Mailbox-Backup */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-5">
        <div className="flex items-start gap-3 mb-3">
          <UserIcon size={20} className="text-accent mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Einzelne Mailbox sichern</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Schneller Snapshot einer einzelnen Mailbox in ZIP (Outlook) oder MBOX (Thunderbird/Apple Mail).
            </p>
          </div>
        </div>
        <div className="space-y-2">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">User</label>
            <select
              value={mailboxUserId}
              onChange={(e) => setMailboxUserId(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="">— bitte wählen —</option>
              {props.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName ? `${u.displayName} — ${u.email}` : u.email}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Format</label>
            <select
              value={mailboxFormat}
              onChange={(e) => setMailboxFormat(e.target.value as 'zip' | 'mbox')}
              className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="zip">ZIP (Outlook-kompatibel, .eml-Dateien)</option>
              <option value="mbox">MBOX (Thunderbird/Apple Mail)</option>
            </select>
          </div>
          <button
            onClick={() => props.onMailboxBackup(mailboxUserId, mailboxFormat)}
            disabled={!mailboxUserId || props.mailboxPending}
            className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-sm bg-accent hover:bg-accent/90 text-white rounded disabled:opacity-50 mt-2"
          >
            <Play size={14} />
            {props.mailboxPending ? 'Wird gestartet…' : 'Mailbox sichern'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tab: Restore (MBOX-Import) ─────────────────────────────────────────────
function RestoreTab(props: { users: UserItem[] }) {
  const [importUserId, setImportUserId] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const handleImport = async () => {
    if (!importUserId.trim()) { toast.error('User erforderlich'); return; }
    const file = fileRef.current?.files?.[0];
    if (!file) { toast.error('Bitte MBOX-Datei auswählen'); return; }
    if (file.size > 500 * 1024 * 1024) { toast.error('Datei zu groß (max 500 MB)'); return; }
    setImporting(true);
    try {
      const text = await file.text();
      const token = localStorage.getItem('bcp-token') ?? '';
      const res = await fetch(`/api/v1/admin/backups/import/${encodeURIComponent(importUserId.trim())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/mbox', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: text,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const result = await res.json() as { imported?: number; failed?: number };
      toast.success(`Import: ${result.imported ?? '?'} importiert${result.failed ? `, ${result.failed} fehlgeschlagen` : ''}`);
      setImportUserId('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import fehlgeschlagen');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-5">
      <div className="flex items-start gap-3 mb-4">
        <Upload size={20} className="text-accent mt-0.5" />
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">MBOX-Import (Wiederherstellung)</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Importiert eine MBOX-Datei (z. B. aus altem Mailserver, Thunderbird-Export) in das Postfach eines Users. Max. 500 MB pro Import.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Ziel-User</label>
          <select
            value={importUserId}
            onChange={(e) => setImportUserId(e.target.value)}
            className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">— bitte wählen —</option>
            {props.users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">MBOX-Datei</label>
          <input ref={fileRef} type="file" accept=".mbox,.txt"
            className="w-full text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-accent/10 file:text-accent hover:file:bg-accent/20" />
        </div>
      </div>
      <div className="flex justify-end">
        <button onClick={() => void handleImport()} disabled={importing || !importUserId}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-accent hover:bg-accent/90 text-white rounded disabled:opacity-50">
          {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {importing ? 'Import läuft…' : 'Import starten'}
        </button>
      </div>
    </div>
  );
}

// ─── Schedule-Editor mit Cron-Dropdowns ─────────────────────────────────────
type ScheduleFreq = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** Parse Cron-String zu ScheduleFreq + Komponenten, oder 'custom' wenn unbekannt. */
function parseCron(cron: string): { freq: ScheduleFreq; minute: number; hour: number; weekday: number; day: number } {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { freq: 'custom', minute: 0, hour: 2, weekday: 1, day: 1 };
  const [m, h, dom, , dow] = parts;
  const minute = m && /^\d+$/.test(m) ? parseInt(m, 10) : 0;
  const hour = h && /^\d+$/.test(h) ? parseInt(h, 10) : 2;
  const weekday = dow && /^\d+$/.test(dow) ? parseInt(dow, 10) : 1;
  const day = dom && /^\d+$/.test(dom) ? parseInt(dom, 10) : 1;

  // Heuristik: hourly = "M * * * *", daily = "M H * * *", weekly = "M H * * D", monthly = "M H D * *"
  if (h === '*' && dom === '*' && dow === '*') return { freq: 'hourly', minute, hour, weekday, day };
  if (dom === '*' && dow === '*') return { freq: 'daily', minute, hour, weekday, day };
  if (dom === '*' && dow && dow !== '*') return { freq: 'weekly', minute, hour, weekday, day };
  if (dow === '*' && dom && dom !== '*') return { freq: 'monthly', minute, hour, weekday, day };
  return { freq: 'custom', minute, hour, weekday, day };
}

function buildCron(freq: ScheduleFreq, minute: number, hour: number, weekday: number, day: number, raw?: string): string {
  if (freq === 'custom') return raw ?? '0 2 * * *';
  switch (freq) {
    case 'hourly':  return `${minute} * * * *`;
    case 'daily':   return `${minute} ${hour} * * *`;
    case 'weekly':  return `${minute} ${hour} * * ${weekday}`;
    case 'monthly': return `${minute} ${hour} ${day} * *`;
  }
}

function ScheduleEditorModal(props: {
  initial: Partial<BackupSchedule>;
  users: UserItem[];
  onClose: () => void;
  onSave: (data: Partial<BackupSchedule>) => void;
  saving: boolean;
}) {
  const initialCron = props.initial.cron ?? '0 2 * * *';
  const parsed = parseCron(initialCron);

  const [name, setName] = useState(props.initial.name ?? '');
  const [freq, setFreq] = useState<ScheduleFreq>(parsed.freq);
  const [minute, setMinute] = useState(parsed.minute);
  const [hour, setHour] = useState(parsed.hour);
  const [weekday, setWeekday] = useState(parsed.weekday);
  const [day, setDay] = useState(parsed.day);
  const [customCron, setCustomCron] = useState(initialCron);
  const [scope, setScope] = useState(props.initial.scope ?? 'full');
  const [format, setFormat] = useState(props.initial.format ?? 'zip');
  const [targetUserId, setTargetUserId] = useState<string | null>(props.initial.targetUserId ?? null);
  const [retentionDays, setRetentionDays] = useState(props.initial.retentionDays ?? 30);
  const [enabled, setEnabled] = useState(props.initial.enabled !== false);

  const effectiveCron = buildCron(freq, minute, hour, weekday, day, customCron);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-lg max-h-[92vh] flex flex-col">
        <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {props.initial.id ? 'Zeitplan bearbeiten' : 'Neuer Zeitplan'}
          </h2>
          <button onClick={props.onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="z. B. Tägliches Vollbackup"
              className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Frequenz */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Wie oft?</label>
            <select
              value={freq}
              onChange={(e) => setFreq(e.target.value as ScheduleFreq)}
              className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm"
            >
              <option value="hourly">Stündlich</option>
              <option value="daily">Täglich</option>
              <option value="weekly">Wöchentlich</option>
              <option value="monthly">Monatlich</option>
              <option value="custom">Benutzerdefiniert (Cron-Expression)</option>
            </select>
          </div>

          {/* Zeit-Dropdowns je nach Frequenz */}
          {freq !== 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              {freq === 'weekly' && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Wochentag</label>
                  <select value={weekday} onChange={(e) => setWeekday(parseInt(e.target.value, 10))}
                    className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm">
                    {WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </div>
              )}
              {freq === 'monthly' && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Tag des Monats</label>
                  <select value={day} onChange={(e) => setDay(parseInt(e.target.value, 10))}
                    className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm">
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}.</option>)}
                  </select>
                </div>
              )}
              {(freq === 'daily' || freq === 'weekly' || freq === 'monthly') && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Stunde (UTC)</label>
                  <select value={hour} onChange={(e) => setHour(parseInt(e.target.value, 10))}
                    className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm">
                    {Array.from({ length: 24 }, (_, i) => i).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Minute</label>
                <select value={minute} onChange={(e) => setMinute(parseInt(e.target.value, 10))}
                  className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm">
                  {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
                </select>
              </div>
            </div>
          )}

          {freq === 'custom' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Cron-Expression (5-Felder, UTC)</label>
              <input
                type="text"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                placeholder="0 2 * * *"
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          )}

          <div className="text-[10px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 px-3 py-2 rounded border border-gray-200 dark:border-gray-700">
            Aktiver Cron: <code className="font-mono">{effectiveCron}</code>
          </div>

          {/* Scope + Format */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Was sichern?</label>
              <select value={scope} onChange={(e) => setScope(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm">
                <option value="full">Alle Mailboxen</option>
                <option value="user">Einzelne Mailbox</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Format</label>
              <select value={format} onChange={(e) => setFormat(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm">
                <option value="zip">ZIP</option>
                <option value="mbox">MBOX</option>
              </select>
            </div>
          </div>

          {scope === 'user' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Ziel-User</label>
              <select value={targetUserId ?? ''} onChange={(e) => setTargetUserId(e.target.value || null)}
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm">
                <option value="">— bitte wählen —</option>
                {props.users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
              </select>
            </div>
          )}

          {/* Retention + Aktiv */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Aufbewahrung (Tage)</label>
              <select value={retentionDays} onChange={(e) => setRetentionDays(parseInt(e.target.value, 10))}
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm">
                {[7, 14, 30, 60, 90, 180, 365, 730, 1825, 3650].map((d) => <option key={d} value={d}>{d} Tage</option>)}
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="rounded border-gray-300" />
                Aktiviert
              </label>
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex justify-end gap-2">
          <button onClick={props.onClose}
            className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
            Abbrechen
          </button>
          <button onClick={() => props.onSave({
              name, cron: effectiveCron, scope, format,
              ...(scope === 'user' && targetUserId ? { targetUserId } : { targetUserId: null }),
              retentionDays, enabled,
            })}
            disabled={!name || (scope === 'user' && !targetUserId) || props.saving}
            className="px-4 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50">
            {props.saving ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  );
}
