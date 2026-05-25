import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  HardDriveDownload, Play, RefreshCw, Upload, AlertCircle, CheckCircle2,
  Loader2, Clock, Database, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

/**
 * v3.18.23 D3: Backup-Restore-UI
 *
 * BCP-Seite zum:
 *  - Anzeigen aller Backup-Jobs (Status, Progress, Download-Link)
 *  - Triggern eines neuen Vollbackups
 *  - MBOX-Datei für einen User importieren (Restore)
 *
 * Backend: /api/v1/admin/backups/* (Wrapper über backup-service)
 */

type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

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
  createdAt: string;
  completedAt: string | null;
}

interface JobsResponse {
  jobs: BackupJob[];
  total?: number;
}

interface S3BackupObject {
  key: string;
  size: number;
  lastModified: string;
}

interface S3ListResponse {
  backups: S3BackupObject[];
  total?: number;
}

const STATUS_LABEL: Record<JobStatus, { label: string; color: string; icon: React.ReactNode }> = {
  PENDING:   { label: 'Wartet',        color: 'text-gray-500',  icon: <Clock      size={13} /> },
  RUNNING:   { label: 'Läuft',         color: 'text-blue-600',  icon: <Loader2    size={13} className="animate-spin" /> },
  COMPLETED: { label: 'Fertig',        color: 'text-green-600', icon: <CheckCircle2 size={13} /> },
  FAILED:    { label: 'Fehler',        color: 'text-red-600',   icon: <AlertCircle size={13} /> },
  CANCELLED: { label: 'Abgebrochen',   color: 'text-gray-400',  icon: <X          size={13} /> },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

export function BackupsPage() {
  const qc = useQueryClient();
  const [importUserId, setImportUserId] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const { data: jobsData, isLoading: jobsLoading, refetch: refetchJobs } = useQuery<JobsResponse>({
    queryKey: ['admin-backups-jobs'],
    queryFn:  () => api.get<JobsResponse>('/admin/backups/jobs?limit=50'),
    // Wenn ein Job RUNNING ist: alle 5s pollen, sonst alle 60s
    refetchInterval: (q) => {
      const data = q.state.data as JobsResponse | undefined;
      return data?.jobs?.some((j) => j.status === 'RUNNING' || j.status === 'PENDING') ? 5_000 : 60_000;
    },
  });

  const { data: s3Data } = useQuery<S3ListResponse>({
    queryKey: ['admin-backups-s3'],
    queryFn:  () => api.get<S3ListResponse>('/admin/backups/list?limit=50'),
    staleTime: 60_000,
  });

  const triggerFullBackup = useMutation({
    mutationFn: () => api.post<unknown>('/admin/backups/full', {}),
    onSuccess: () => {
      toast.success('Vollbackup gestartet');
      void qc.invalidateQueries({ queryKey: ['admin-backups-jobs'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleImport = async () => {
    if (!importUserId.trim()) { toast.error('User-ID erforderlich'); return; }
    const file = fileRef.current?.files?.[0];
    if (!file) { toast.error('Bitte MBOX-Datei auswählen'); return; }
    if (file.size > 500 * 1024 * 1024) {
      toast.error('Datei zu groß (max 500 MB)');
      return;
    }
    setImporting(true);
    try {
      const text = await file.text();
      const token = localStorage.getItem('bcp-token') ?? '';
      const res = await fetch(`/api/v1/admin/backups/import/${encodeURIComponent(importUserId.trim())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/mbox',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: text,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const result = await res.json() as { imported?: number; failed?: number };
      toast.success(`Import abgeschlossen — ${result.imported ?? '?'} Nachrichten importiert${result.failed ? `, ${result.failed} fehlgeschlagen` : ''}`);
      setImportUserId('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import fehlgeschlagen');
    } finally {
      setImporting(false);
    }
  };

  const jobs = jobsData?.jobs ?? [];
  const s3Backups = s3Data?.backups ?? [];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <HardDriveDownload size={22} className="text-accent" />
            Backup &amp; Restore
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Vollbackups, MBOX-Imports und S3-Snapshots verwalten.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void refetchJobs()}
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

      {/* Backup-Jobs Tabelle */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wide">
          Backup-Jobs
        </h2>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
          {jobsLoading ? (
            <div className="p-8 text-center text-gray-400">
              <Loader2 size={20} className="animate-spin mx-auto" />
            </div>
          ) : jobs.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              Noch keine Backup-Jobs vorhanden
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800 text-xs uppercase text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Erstellt</th>
                  <th className="px-4 py-2 text-left font-medium">Scope</th>
                  <th className="px-4 py-2 text-left font-medium">Format</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Fortschritt</th>
                  <th className="px-4 py-2 text-left font-medium">Download</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {jobs.map((j) => {
                  const st = STATUS_LABEL[j.status];
                  return (
                    <tr key={j.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <td className="px-4 py-2 text-gray-700 dark:text-gray-200 whitespace-nowrap">
                        {formatDate(j.createdAt)}
                      </td>
                      <td className="px-4 py-2 text-gray-700 dark:text-gray-200">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-gray-100 dark:bg-gray-800 rounded">
                          {j.scope}{j.userId ? ` (${j.userId.slice(0, 8)})` : ''}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-600 dark:text-gray-300 uppercase text-xs">
                        {j.format}
                      </td>
                      <td className={`px-4 py-2 ${st.color}`}>
                        <span className="inline-flex items-center gap-1.5">
                          {st.icon} {st.label}
                        </span>
                        {j.errorMsg && (
                          <p className="text-xs text-red-500 mt-1" title={j.errorMsg}>
                            {j.errorMsg.slice(0, 50)}{j.errorMsg.length > 50 ? '…' : ''}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2 text-gray-600 dark:text-gray-300">
                        {j.status === 'RUNNING' || j.status === 'PENDING' ? (
                          <div className="w-24 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-accent transition-all"
                              style={{ width: `${j.progress}%` }}
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">{j.progress}%</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {j.downloadUrl && j.status === 'COMPLETED' ? (
                          <a
                            href={j.downloadUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent hover:underline text-xs inline-flex items-center gap-1"
                          >
                            <HardDriveDownload size={12} /> Download
                          </a>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* S3-Backup-Objekte */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wide flex items-center gap-2">
          <Database size={14} />
          S3-Snapshots ({s3Backups.length})
        </h2>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
          {s3Backups.length === 0 ? (
            <div className="p-6 text-center text-gray-400 text-sm">
              Keine Snapshots im S3-Bucket
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800 text-xs uppercase text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Key</th>
                  <th className="px-4 py-2 text-right font-medium">Größe</th>
                  <th className="px-4 py-2 text-left font-medium">Geändert</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {s3Backups.map((b) => (
                  <tr key={b.key} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">{b.key}</td>
                    <td className="px-4 py-2 text-right text-gray-600 dark:text-gray-300">{formatBytes(b.size)}</td>
                    <td className="px-4 py-2 text-gray-600 dark:text-gray-300">{formatDate(b.lastModified)}</td>
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
          <Upload size={14} />
          MBOX-Import (Wiederherstellung)
        </h2>
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-4 space-y-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Importiert eine MBOX-Datei (z. B. aus altem Mailserver, Thunderbird-Export) in das Postfach eines Users.
            Max. 500 MB pro Import.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Ziel-User-ID
              </label>
              <input
                type="text"
                value={importUserId}
                onChange={(e) => setImportUserId(e.target.value)}
                placeholder="z. B. cuid…"
                className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                MBOX-Datei
              </label>
              <input
                ref={fileRef}
                type="file"
                accept=".mbox,.txt"
                className="w-full text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-accent/10 file:text-accent hover:file:bg-accent/20"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => void handleImport()}
              disabled={importing || !importUserId.trim()}
              className="flex items-center gap-1.5 px-4 py-2 text-sm bg-accent hover:bg-accent/90 text-white rounded disabled:opacity-50"
            >
              {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {importing ? 'Import läuft…' : 'Import starten'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
