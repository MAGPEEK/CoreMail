import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BookText, Plus, Pencil, Trash2, Settings as SettingsIcon, AlertTriangle,
  RotateCcw, X, Check, ListChecks, ShieldAlert,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface JournalingRule {
  id: string;
  name: string;
  description: string;
  journalAddress: string;
  scope: 'ALL' | 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
  recipientType: 'ALL_MAILBOXES' | 'SPECIFIC_USERS' | 'DOMAIN';
  recipientIds: string[];
  wrapAsReport: boolean;
  enabled: boolean;
  createdAt: string;
}

interface JournalingSettings {
  id: string;
  alternativeJournalAddress: string | null;
  holdOnFailure: boolean;
  maxRetries: number;
  initialRetryDelaySec: number;
  updatedAt: string;
}

type FailureStatus = 'PENDING' | 'RETRYING' | 'ALTERNATIVE' | 'RESOLVED' | 'ABANDONED';

interface JournalingFailure {
  id: string;
  ruleId: string;
  envelopeFrom: string;
  envelopeTo: string[];
  direction: string;
  rawStoragePath: string | null;
  rawSizeBytes: number;
  targetAddress: string;
  lastTriedAddress: string | null;
  status: FailureStatus;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  resolvedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  rule?: { id: string; name: string; journalAddress: string };
}

// ─── Labels ──────────────────────────────────────────────────────────────────

const SCOPE_LABELS: Record<JournalingRule['scope'], string> = {
  ALL: 'Alle Nachrichten', INBOUND: 'Eingehend', OUTBOUND: 'Ausgehend', INTERNAL: 'Intern',
};
const RECIPIENT_LABELS: Record<JournalingRule['recipientType'], string> = {
  ALL_MAILBOXES: 'Alle Postfächer', SPECIFIC_USERS: 'Bestimmte User', DOMAIN: 'Domain',
};
const FAILURE_STATUS_LABELS: Record<FailureStatus, string> = {
  PENDING:     'Wartend',
  RETRYING:    'Wiederholung',
  ALTERNATIVE: 'Fallback',
  RESOLVED:    'Zugestellt',
  ABANDONED:   'Abgebrochen',
};
const FAILURE_STATUS_COLORS: Record<FailureStatus, string> = {
  PENDING:     'bg-amber-100 text-amber-700',
  RETRYING:    'bg-blue-100 text-blue-700',
  ALTERNATIVE: 'bg-purple-100 text-purple-700',
  RESOLVED:    'bg-green-100 text-green-700',
  ABANDONED:   'bg-red-100 text-red-700',
};

function fmtDateTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('de-DE') : '—';
}

// ─── Rule Modal ───────────────────────────────────────────────────────────────

function RuleModal({ rule, onClose }: { rule: JournalingRule | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = rule !== null;
  const [form, setForm] = useState({
    name:           rule?.name ?? '',
    description:    rule?.description ?? '',
    journalAddress: rule?.journalAddress ?? '',
    scope:          rule?.scope ?? 'ALL' as JournalingRule['scope'],
    recipientType:  rule?.recipientType ?? 'ALL_MAILBOXES' as JournalingRule['recipientType'],
    recipientIds:   rule?.recipientIds.join(', ') ?? '',
    wrapAsReport:   rule?.wrapAsReport ?? true,
    enabled:        rule?.enabled ?? true,
  });
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name, description: form.description,
        journalAddress: form.journalAddress, scope: form.scope,
        recipientType: form.recipientType,
        recipientIds: form.recipientIds.split(',').map((s) => s.trim()).filter(Boolean),
        wrapAsReport: form.wrapAsReport, enabled: form.enabled,
      };
      return isEdit
        ? api.put(`/admin/compliance/journaling/${rule.id}`, body)
        : api.post('/admin/compliance/journaling', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-journaling'] });
      toast.success(isEdit ? 'Regel aktualisiert' : 'Regel erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold text-gray-900">{isEdit ? 'Regel bearbeiten' : 'Neue Journaling-Regel'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="px-6 py-4 space-y-3 overflow-y-auto flex-1">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
            <input value={form.name} onChange={(e) => set('name', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="z.B. Compliance-Archivierung" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Journal-Adresse * (Ziel-Postfach)</label>
            <input value={form.journalAddress} onChange={(e) => set('journalAddress', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="archiv@compliance.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Scope</label>
              <select value={form.scope} onChange={(e) => set('scope', e.target.value as JournalingRule['scope'])}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
                {(Object.entries(SCOPE_LABELS) as [JournalingRule['scope'], string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Empfänger-Filter</label>
              <select value={form.recipientType} onChange={(e) => set('recipientType', e.target.value as JournalingRule['recipientType'])}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
                {(Object.entries(RECIPIENT_LABELS) as [JournalingRule['recipientType'], string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>
          {(form.recipientType === 'SPECIFIC_USERS' || form.recipientType === 'DOMAIN') && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {form.recipientType === 'SPECIFIC_USERS' ? 'E-Mail-Adressen (kommagetrennt)' : 'Domains (kommagetrennt)'}
              </label>
              <textarea value={form.recipientIds} onChange={(e) => set('recipientIds', e.target.value)}
                rows={2} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none font-mono"
                placeholder={form.recipientType === 'SPECIFIC_USERS' ? 'user1@domain.com, user2@domain.com' : 'firma.com, partner.com'} />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Beschreibung</label>
            <textarea value={form.description} onChange={(e) => set('description', e.target.value)}
              rows={2} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.wrapAsReport} onChange={(e) => set('wrapAsReport', e.target.checked)} className="accent-accent" />
              <span className="text-sm text-gray-700">Als RFC-3462-Report verpacken</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} className="accent-accent" />
              <span className="text-sm text-gray-700">Aktiviert</span>
            </label>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name || !form.journalAddress.includes('@')}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

function SettingsPanel() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery<JournalingSettings>({
    queryKey: ['admin-journaling-settings'],
    queryFn:  () => api.get('/admin/compliance/journaling/settings'),
  });

  const [form, setForm] = useState({
    alternativeJournalAddress: '',
    holdOnFailure: false,
    maxRetries: 3,
    initialRetryDelaySec: 30,
  });

  useEffect(() => {
    if (settings) {
      setForm({
        alternativeJournalAddress: settings.alternativeJournalAddress ?? '',
        holdOnFailure: settings.holdOnFailure,
        maxRetries: settings.maxRetries,
        initialRetryDelaySec: settings.initialRetryDelaySec,
      });
    }
  }, [settings]);

  const save = useMutation({
    mutationFn: () => api.put('/admin/compliance/journaling/settings', {
      alternativeJournalAddress: form.alternativeJournalAddress.trim() || null,
      holdOnFailure: form.holdOnFailure,
      maxRetries: form.maxRetries,
      initialRetryDelaySec: form.initialRetryDelaySec,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-journaling-settings'] });
      toast.success('Einstellungen gespeichert');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-sm text-gray-400 py-12 text-center">Laden…</p>;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 max-w-2xl space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Alternatives Journal-Postfach</h3>
        <p className="text-xs text-gray-500 mb-3">
          Fallback wenn das primäre Journal-Ziel nicht erreichbar ist. Reports werden hierhin umgeleitet,
          wenn alle Retry-Versuche an die Regel-Adresse scheitern. Leer lassen = kein Fallback.
        </p>
        <input
          type="email"
          value={form.alternativeJournalAddress}
          onChange={(e) => setForm((f) => ({ ...f, alternativeJournalAddress: e.target.value }))}
          className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          placeholder="alternative-archiv@firma.com"
        />
      </div>

      <div className="border-t border-gray-100 pt-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Submission-Queue-Hold</h3>
        <p className="text-xs text-gray-500 mb-3">
          Wenn aktiviert, wird der eingehende Mailfluss gestoppt, sobald ein Journal-Report
          nicht zugestellt werden kann (auch nicht über das Fallback) — die Nachricht bleibt
          in der SMTP-Queue. Schützt vor un-protokollierten Mails (Non-Repudiation), kann aber
          den gesamten Mailfluss zum Stillstand bringen, wenn das Journal-Postfach längere Zeit
          ausfällt. Für kleine Organisationen meist nicht empfehlenswert.
        </p>
        <label className="flex items-center gap-3 cursor-pointer p-3 rounded border border-gray-200 hover:bg-gray-50">
          <input
            type="checkbox"
            checked={form.holdOnFailure}
            onChange={(e) => setForm((f) => ({ ...f, holdOnFailure: e.target.checked }))}
            className="accent-accent w-4 h-4"
          />
          <div>
            <p className="text-sm font-medium text-gray-800">Mailfluss bei Journal-Fehler anhalten</p>
            <p className="text-xs text-gray-500">Non-Repudiation: keine Mail wird zugestellt, wenn sie nicht protokolliert werden kann</p>
          </div>
        </label>
        {form.holdOnFailure && (
          <div className="mt-3 flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-700">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>Achtung: bei längerem Ausfall des Journal-Postfachs werden eingehende Mails NICHT zugestellt. Nur aktivieren, wenn ein zuverlässiges Fallback-Postfach konfiguriert ist.</span>
          </div>
        )}
      </div>

      <div className="border-t border-gray-100 pt-5 grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Max. Wiederholungsversuche</label>
          <input
            type="number" min="0" max="50"
            value={form.maxRetries}
            onChange={(e) => setForm((f) => ({ ...f, maxRetries: parseInt(e.target.value || '0', 10) }))}
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <p className="text-[11px] text-gray-400 mt-0.5">Default: 3</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Erstes Retry-Intervall (Sek.)</label>
          <input
            type="number" min="5" max="3600"
            value={form.initialRetryDelaySec}
            onChange={(e) => setForm((f) => ({ ...f, initialRetryDelaySec: parseInt(e.target.value || '30', 10) }))}
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <p className="text-[11px] text-gray-400 mt-0.5">Verdoppelt sich mit jedem Versuch (exp. Backoff)</p>
        </div>
      </div>

      <div className="flex justify-end pt-3 border-t border-gray-100">
        <button onClick={() => save.mutate()} disabled={save.isPending}
          className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
          {save.isPending ? 'Speichern…' : 'Einstellungen speichern'}
        </button>
      </div>
    </div>
  );
}

// ─── Failures Tab ─────────────────────────────────────────────────────────────

function FailuresPanel() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<FailureStatus | 'ALL'>('ALL');

  const { data: failures = [], isLoading } = useQuery<JournalingFailure[]>({
    queryKey: ['admin-journaling-failures', statusFilter],
    queryFn:  () => api.get(`/admin/compliance/journaling/failures${statusFilter !== 'ALL' ? `?status=${statusFilter}` : ''}`),
    refetchInterval: 15_000,
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/admin/compliance/journaling/failures/${id}/retry`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-journaling-failures'] }); toast.success('Retry in die Warteschlange gestellt'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/compliance/journaling/failures/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-journaling-failures'] }); toast.success('Eintrag entfernt'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const counts = {
    PENDING:     failures.filter((f) => f.status === 'PENDING').length,
    ABANDONED:   failures.filter((f) => f.status === 'ABANDONED').length,
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 mr-1">Filter:</span>
        {(['ALL', 'PENDING', 'RETRYING', 'ALTERNATIVE', 'RESOLVED', 'ABANDONED'] as const).map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`px-2.5 py-1 text-xs rounded border ${
              statusFilter === s ? 'bg-accent text-white border-accent' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}>
            {s === 'ALL' ? 'Alle' : FAILURE_STATUS_LABELS[s]}
          </button>
        ))}
        {(counts.PENDING > 0 || counts.ABANDONED > 0) && (
          <span className="ml-auto text-xs text-gray-500">
            {counts.PENDING > 0 && <span className="text-amber-600">{counts.PENDING} wartend</span>}
            {counts.PENDING > 0 && counts.ABANDONED > 0 && ' · '}
            {counts.ABANDONED > 0 && <span className="text-red-600">{counts.ABANDONED} abgebrochen</span>}
          </span>
        )}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3">Regel · Ziel</th>
              <th className="text-left px-4 py-3">Original</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-right px-4 py-3">Versuche</th>
              <th className="text-left px-4 py-3">Letzter Fehler</th>
              <th className="text-left px-4 py-3">Nächster Versuch</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="text-center py-12 text-gray-400">Laden…</td></tr>
            ) : failures.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-12 text-gray-400 flex flex-col items-center gap-2">
                <Check size={20} className="text-green-500" />
                <span>Keine Journal-Fehler {statusFilter !== 'ALL' ? `(${FAILURE_STATUS_LABELS[statusFilter]})` : ''}</span>
              </td></tr>
            ) : failures.map((f) => (
              <tr key={f.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="text-xs font-medium text-gray-900">{f.rule?.name ?? '(unbekannt)'}</p>
                  <p className="text-[11px] font-mono text-gray-500">{f.targetAddress}</p>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  <p className="font-mono truncate max-w-xs">{f.envelopeFrom}</p>
                  <p className="text-[11px] text-gray-400">→ {f.envelopeTo.slice(0, 2).join(', ')}{f.envelopeTo.length > 2 ? ` +${f.envelopeTo.length - 2}` : ''}</p>
                  <p className="text-[11px] text-gray-400">{(f.rawSizeBytes / 1024).toFixed(1)} KB · {f.direction}</p>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${FAILURE_STATUS_COLORS[f.status]}`}>
                    {FAILURE_STATUS_LABELS[f.status]}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-right tabular-nums text-gray-700">{f.attempts}</td>
                <td className="px-4 py-3 text-xs text-gray-600 max-w-[240px] truncate" title={f.errorMessage ?? ''}>{f.errorMessage ?? '—'}</td>
                <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDateTime(f.nextAttemptAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {(f.status === 'ABANDONED' || f.status === 'PENDING' || f.status === 'RETRYING') && (
                      <button onClick={() => retry.mutate(f.id)} disabled={retry.isPending}
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="Erneut versuchen">
                        <RotateCcw size={13} />
                      </button>
                    )}
                    <button onClick={() => dismiss.mutate(f.id)} disabled={dismiss.isPending}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded" title="Eintrag entfernen">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function JournalingPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'rules' | 'settings' | 'failures'>('rules');
  const [modal, setModal] = useState<'create' | JournalingRule | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<JournalingRule | null>(null);

  const { data: rules = [], isLoading } = useQuery<JournalingRule[]>({
    queryKey: ['admin-journaling'],
    queryFn:  () => api.get('/admin/compliance/journaling'),
  });

  // Failure-Count für Tab-Badge
  const { data: failures = [] } = useQuery<JournalingFailure[]>({
    queryKey: ['admin-journaling-failures', 'ALL'],
    queryFn:  () => api.get('/admin/compliance/journaling/failures'),
    refetchInterval: 30_000,
  });
  const openFailures = failures.filter((f) => f.status === 'PENDING' || f.status === 'RETRYING' || f.status === 'ABANDONED').length;

  const toggle = useMutation({
    mutationFn: (r: JournalingRule) => api.post(`/admin/compliance/journaling/${r.id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-journaling'] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/compliance/journaling/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-journaling'] });
      toast.success('Regel gelöscht');
      setDeleteConfirm(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <BookText size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Journaling</h1>
            <p className="text-sm text-gray-500">Compliance-Kopien via RFC 3462 Journal Reports · Submission-Queue-Hold · Fallback-Postfach</p>
          </div>
        </div>
        {tab === 'rules' && (
          <button onClick={() => setModal('create')}
            className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90">
            <Plus size={15} /> Neue Regel
          </button>
        )}
      </div>

      <div className="flex border-b border-gray-200 mb-4">
        <button onClick={() => setTab('rules')}
          className={`px-4 py-2 text-sm font-medium border-b-2 flex items-center gap-1.5 ${
            tab === 'rules' ? 'border-accent text-accent' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}>
          <ListChecks size={13} /> Regeln ({rules.length})
        </button>
        <button onClick={() => setTab('settings')}
          className={`px-4 py-2 text-sm font-medium border-b-2 flex items-center gap-1.5 ${
            tab === 'settings' ? 'border-accent text-accent' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}>
          <SettingsIcon size={13} /> Einstellungen
        </button>
        <button onClick={() => setTab('failures')}
          className={`px-4 py-2 text-sm font-medium border-b-2 flex items-center gap-1.5 ${
            tab === 'failures' ? 'border-accent text-accent' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}>
          <ShieldAlert size={13} /> Fehler
          {openFailures > 0 && (
            <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold">{openFailures}</span>
          )}
        </button>
      </div>

      {tab === 'rules' && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">Regel</th>
                <th className="text-left px-4 py-3">Journal-Adresse</th>
                <th className="text-left px-4 py-3">Scope</th>
                <th className="text-left px-4 py-3">Gilt für</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400">Laden…</td></tr>
              ) : rules.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400">Noch keine Journaling-Regeln konfiguriert</td></tr>
              ) : rules.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{r.name}</p>
                    {r.description && <p className="text-xs text-gray-500">{r.description}</p>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{r.journalAddress}</td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{SCOPE_LABELS[r.scope]}</td>
                  <td className="px-4 py-3 text-gray-600 text-xs">
                    {RECIPIENT_LABELS[r.recipientType]}
                    {r.recipientType !== 'ALL_MAILBOXES' && r.recipientIds.length > 0 && (
                      <span className="text-gray-400"> ({r.recipientIds.length})</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => toggle.mutate(r)}>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        r.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {r.enabled ? 'Aktiv' : 'Deaktiviert'}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setModal(r)}
                        className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded"><Pencil size={13} /></button>
                      <button onClick={() => setDeleteConfirm(r)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'settings' && <SettingsPanel />}
      {tab === 'failures' && <FailuresPanel />}

      {modal !== null && <RuleModal rule={modal === 'create' ? null : modal} onClose={() => setModal(null)} />}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Regel löschen</h2>
            <p className="text-sm text-gray-600 mb-4">Soll <strong>{deleteConfirm.name}</strong> wirklich gelöscht werden?</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
              <button onClick={() => deleteRule.mutate(deleteConfirm.id)} disabled={deleteRule.isPending}
                className="px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50">
                {deleteRule.isPending ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
