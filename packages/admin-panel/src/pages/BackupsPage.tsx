import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  HardDriveDownload, Play, RefreshCw, Upload, AlertCircle, CheckCircle2,
  Loader2, Clock, Database, X, User as UserIcon, CalendarClock, Plus, Trash2,
  Pencil, PauseCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

/**
 * v3.18.26 D3/BackupsPage v2:
 * - Bugfixes: Vollbackup + Refresh (war kaputt durch listBackups-Crash)
 * - Per-Mailbox-Backup mit User-Picker + Format-Auswahl
 * - Backup-Schedules (Cron-Strings in DB, kein Env-Restart nötig)
 * - Reichhaltige Status-Anzeige (Duration, Size, Trigger, ErrorClass)
 * - PST-Export: bewusst nicht (siehe Banner — Outlook nutzt EML/MBOX)
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
  sizeBytes: string | null;        // BigInt → string über JSON
  messageCount: number | null;
  triggeredBy: string;
  createdAt: string;
  progressMeta?: { phase?: string; current?: number; total?: number; currentUser?: string };
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

interface UserItem {
  id: string;
  email: string;
  displayName: string | null;
}

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

export function BackupsPage() {
  const qc = useQueryClient();
  const [importUserId, setImportUserId] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  // Mailbox-Backup-Form
  const [mailboxUserId, setMailboxUserId] = useState('');
  const [mailboxFormat, setMailboxFormat] = useState<'zip' | 'mbox'>('zip');

  // Schedule-Editor
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

  // Mutations
  const triggerFullBackup = useMutation({
    mutationFn: () => api.post<{ jobId: string }>('/admin/backups/full', {}),
    onSuccess: (r) => {
      toast.success(`Vollbackup gestartet (Job ${r.jobId.slice(0, 8)})`);
      void qc.invalidateQueries({ queryKey: ['admin-backups-jobs'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const triggerMailboxBackup = useMutation({
    mutationFn: (vars: { userId: string; format: 'zip' | 'mbox' }) =>
      api.post<{ jobId: string; userEmail: string }>(
        `/admin/backups/mailbox/${vars.userId}`, { format: vars.format },
      ),
    onSuccess: (r) => {
      toast.success(`Backup für ${r.userEmail} gestartet`);
      setMailboxUserId('');
      void qc.invalidateQueries({ queryKey: ['admin-backups-jobs'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createSchedule = useMutation({
    mutationFn: (s: Partial<BackupSchedule>) => api.post('/admin/backups/schedules', s),
    onSuccess: () => {
      toast.success('Zeitplan erstellt');
      setScheduleEditor(null);
      void qc.invalidateQueries({ queryKey: ['admin-backups-schedules'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateSchedule = useMutation({
    mutationFn: (vars: { id: string; data: Partial<BackupSchedule> }) =>
      api.put(`/admin/backups/schedules/${vars.id}`, vars.data),
    onSuccess: () => {
      toast.success('Zeitplan aktualisiert');
      setScheduleEditor(null);
      void qc.invalidateQueries({ queryKey: ['admin-backups-schedules'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteSchedule = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/backups/schedules/${id}`),
    onSuccess: () => {
      toast.success('Zeitplan gelöscht');
      void qc.invalidateQueries({ queryKey: ['admin-backups-schedules'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const runScheduleNow = useMutation({
    mutationFn: (id: string) => api.post(`/admin/backups/schedules/${id}/run-now`, {}),
    onSuccess: () => {
      toast.success('Zeitplan getriggert');
      void qc.invalidateQueries({ queryKey: ['admin-backups-jobs'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleImport = async () => {
    if (!importUserId.trim()) { toast.error('User-ID erforderlich'); return; }
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

  const userEmailById = (id: string | null): string => {
    if (!id) return '—';
    const u = users.find((x) => x.id === id);
    return u?.email ?? id.slice(0, 8);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <HardDriveDownload size={22} className="text-accent" />
            Backup &amp; Restore
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Vollbackups, Per-Mailbox-Snapshots, Zeitpläne und MBOX-Import verwalten.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { void refetchJobs(); toast.success('Aktualisiert'); }}
            disabled={jobsLoading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            <RefreshCw size={14} className={jobsLoading ? 'animate-spin' : ''} />
            Aktualisieren
          </button>
          <button
            onClick={() => triggerFullBackup.mutate()}
            disabled={triggerFullBackup.isPending}
            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-accent hover:bg-accent/90 text-white rounded disabled:opacity-50"
          >
            <Play size={14} />
            {triggerFullBackup.isPending ? 'Wird gestartet…' : 'Vollbackup starten'}
          </button>
        </div>
      </div>

      {/* PST-Hinweis */}
      <div className="bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded p-3 text-xs text-blue-700 dark:text-blue-300">
        <strong>Hinweis Outlook-Kompatibilität:</strong> PST-Format wird bewusst nicht unterstützt (proprietäres Microsoft-Binärformat). Outlook akzeptiert das ZIP-Backup per Drag&amp;Drop direkt in beliebige Ordner — die enthaltenen .eml-Dateien werden nativ importiert. Für Thunderbird/Apple Mail: MBOX-Format wählen.
      </div>

      {/* Per-Mailbox-Backup */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wide flex items-center gap-2">
          <UserIcon size={14} /> Einzelne Mailbox sichern
        </h2>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">User auswählen</label>
              <select
                value={mailboxUserId}
                onChange={(e) => setMailboxUserId(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">— bitte wählen —</option>
                {users.map((u) => (
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
                <option value="zip">ZIP (Outlook-kompatibel)</option>
                <option value="mbox">MBOX (Thunderbird/Apple)</option>
              </select>
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => triggerMailboxBackup.mutate({ userId: mailboxUserId, format: mailboxFormat })}
              disabled={!mailboxUserId || triggerMailboxBackup.isPending}
              className="px-4 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 flex items-center gap-1.5"
            >
              <Play size={14} />
              {triggerMailboxBackup.isPending ? 'Wird gestartet…' : 'Mailbox sichern'}
            </button>
          </div>
        </div>
      </section>

      {/* Zeitpläne */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide flex items-center gap-2">
            <CalendarClock size={14} /> Backup-Zeitpläne
          </h2>
          <button
            onClick={() => setScheduleEditor({ name: '', cron: '0 2 * * *', scope: 'full', format: 'zip', retentionDays: 30, enabled: true })}
            className="text-xs px-3 py-1.5 bg-accent text-white rounded hover:bg-accent/90 flex items-center gap-1.5"
          >
            <Plus size={12} /> Neuer Zeitplan
          </button>
        </div>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
          {schedules.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-400">
              Noch keine Zeitpläne — neuer Plan z. B. „0 2 * * *" für tägliches Backup um 02:00 UTC
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
                    <td className="px-4 py-2 text-gray-600 dark:text-gray-300">
                      {s.scope}{s.targetUserId ? ` (${userEmailById(s.targetUserId)})` : ''} · {s.format}
                    </td>
                    <td className="px-4 py-2">
                      {s.enabled ? <CheckCircle2 size={14} className="text-green-600" /> : <PauseCircle size={14} className="text-gray-400" />}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{fmtDate(s.lastRunAt)}</td>
                    <td className="px-4 py-2 text-xs">{s.lastStatus ?? '—'}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => runScheduleNow.mutate(s.id)}
                          disabled={runScheduleNow.isPending}
                          className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded disabled:opacity-50"
                          title="Jetzt ausführen"
                        >
                          <Play size={13} />
                        </button>
                        <button
                          onClick={() => setScheduleEditor(s)}
                          className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded"
                          title="Bearbeiten"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`Zeitplan „${s.name}" löschen?`)) deleteSchedule.mutate(s.id);
                          }}
                          className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded"
                          title="Löschen"
                        >
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
      </section>

      {/* Backup-Jobs Tabelle */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wide">
          Backup-Jobs (Status &amp; Logs)
        </h2>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
          {jobsLoading ? (
            <div className="p-8 text-center text-gray-400"><Loader2 size={20} className="animate-spin mx-auto" /></div>
          ) : jobsData.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">Noch keine Backup-Jobs vorhanden</div>
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
                  <th className="px-3 py-2 text-left font-medium">Download</th>
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
                        {j.downloadUrl && j.status === 'COMPLETED' ? (
                          <a href={j.downloadUrl} target="_blank" rel="noopener noreferrer"
                            className="text-accent hover:underline text-xs inline-flex items-center gap-1">
                            <HardDriveDownload size={12} /> Download
                          </a>
                        ) : <span className="text-xs text-gray-400">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* S3-Snapshots */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wide flex items-center gap-2">
          <Database size={14} /> S3-Snapshots ({s3Data.length})
        </h2>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-hidden max-h-72 overflow-y-auto">
          {s3Data.length === 0 ? (
            <div className="p-6 text-center text-gray-400 text-sm">Keine Snapshots im S3-Bucket</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800 text-xs uppercase text-gray-500 dark:text-gray-400 sticky top-0">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Key</th>
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
          )}
        </div>
      </section>

      {/* MBOX Import */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wide flex items-center gap-2">
          <Upload size={14} /> MBOX-Import (Restore)
        </h2>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-4 space-y-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Importiert eine MBOX-Datei (z. B. aus altem Mailserver, Thunderbird-Export) in das Postfach eines Users. Max. 500 MB pro Import.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Ziel-User</label>
              <select
                value={importUserId}
                onChange={(e) => setImportUserId(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">— bitte wählen —</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
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
      </section>

      {/* Schedule Editor Modal */}
      {scheduleEditor && (
        <ScheduleEditorModal
          initial={scheduleEditor}
          users={users}
          onClose={() => setScheduleEditor(null)}
          onSave={(data) => {
            if (scheduleEditor.id) {
              updateSchedule.mutate({ id: scheduleEditor.id, data });
            } else {
              createSchedule.mutate(data);
            }
          }}
          saving={createSchedule.isPending || updateSchedule.isPending}
        />
      )}
    </div>
  );
}

// ─── Schedule-Editor-Modal ───────────────────────────────────────────────────
const CRON_PRESETS = [
  { label: 'Täglich 02:00 UTC', cron: '0 2 * * *' },
  { label: 'Wöchentlich Mo 03:00', cron: '0 3 * * 1' },
  { label: 'Stündlich', cron: '0 * * * *' },
  { label: 'Alle 6 Stunden', cron: '0 */6 * * *' },
  { label: 'Monatlich 1. um 04:00', cron: '0 4 1 * *' },
];

function ScheduleEditorModal(props: {
  initial: Partial<BackupSchedule>;
  users: UserItem[];
  onClose: () => void;
  onSave: (data: Partial<BackupSchedule>) => void;
  saving: boolean;
}) {
  const [data, setData] = useState<Partial<BackupSchedule>>({
    name: props.initial.name ?? '',
    cron: props.initial.cron ?? '0 2 * * *',
    scope: props.initial.scope ?? 'full',
    format: props.initial.format ?? 'zip',
    targetUserId: props.initial.targetUserId ?? null,
    retentionDays: props.initial.retentionDays ?? 30,
    enabled: props.initial.enabled ?? true,
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-lg p-6">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">
          {props.initial.id ? 'Zeitplan bearbeiten' : 'Neuer Zeitplan'}
        </h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
            <input
              type="text"
              value={data.name ?? ''}
              onChange={(e) => setData({ ...data, name: e.target.value })}
              placeholder="z. B. Tägliches Vollbackup"
              className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Cron-Expression (UTC)</label>
            <input
              type="text"
              value={data.cron ?? ''}
              onChange={(e) => setData({ ...data, cron: e.target.value })}
              className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <div className="mt-1 flex flex-wrap gap-1">
              {CRON_PRESETS.map((p) => (
                <button key={p.cron} onClick={() => setData({ ...data, cron: p.cron })}
                  className="text-[10px] px-2 py-0.5 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-800">
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Scope</label>
              <select value={data.scope ?? 'full'}
                onChange={(e) => setData({ ...data, scope: e.target.value })}
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm">
                <option value="full">Voll (alle User)</option>
                <option value="user">Einzelne Mailbox</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Format</label>
              <select value={data.format ?? 'zip'}
                onChange={(e) => setData({ ...data, format: e.target.value })}
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm">
                <option value="zip">ZIP</option>
                <option value="mbox">MBOX</option>
              </select>
            </div>
          </div>
          {data.scope === 'user' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Ziel-User</label>
              <select value={data.targetUserId ?? ''}
                onChange={(e) => setData({ ...data, targetUserId: e.target.value || null })}
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm">
                <option value="">— bitte wählen —</option>
                {props.users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Retention (Tage)</label>
              <input type="number" min={1} max={3650}
                value={data.retentionDays ?? 30}
                onChange={(e) => setData({ ...data, retentionDays: parseInt(e.target.value, 10) || 30 })}
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm" />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={data.enabled !== false}
                  onChange={(e) => setData({ ...data, enabled: e.target.checked })}
                  className="rounded border-gray-300" />
                Aktiviert
              </label>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={props.onClose}
            className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-50 dark:hover:bg-gray-800">
            Abbrechen
          </button>
          <button onClick={() => props.onSave(data)}
            disabled={!data.name || !data.cron || (data.scope === 'user' && !data.targetUserId) || props.saving}
            className="px-4 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50">
            {props.saving ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  );
}
