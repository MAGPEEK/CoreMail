import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Archive, Plus, Pencil, Trash2, Tag, ListChecks, History,
  X, Folder as FolderIcon, AlertCircle, Check, Play,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type TagType   = 'DPT' | 'RPT' | 'PERSONAL';
type TagAction = 'MOVE_TO_ARCHIVE' | 'DELETE_AND_ALLOW_RECOVERY' | 'PERMANENTLY_DELETE' | 'MARK_AS_PAST_RETENTION_LIMIT';
type FolderTarget = 'INBOX'|'SENT_ITEMS'|'DELETED_ITEMS'|'JUNK_EMAIL'|'DRAFTS'|'OUTBOX'|'RECOVERABLE_ITEMS'|'ARCHIVE'|'ALL_OTHER';

interface RetentionTag {
  id: string;
  name: string;
  description: string;
  type: TagType;
  action: TagAction;
  retentionDays: number;
  folderTarget: FolderTarget | null;
  enabled: boolean;
  isSystem: boolean;
  createdAt: string;
  _count?: { policyTags: number; messages: number; folders: number };
}

interface RetentionPolicy {
  id: string;
  name: string;
  description: string;
  retentionDays: number;
  action: 'ARCHIVE' | 'DELETE' | 'MOVE_TO_FOLDER';
  targetFolder?: string;
  scope: 'ALL_ITEMS' | 'INBOX' | 'SENT_ITEMS' | 'DELETED_ITEMS' | 'JUNK';
  respectLegalHold: boolean;
  enabled: boolean;
  createdAt: string;
  _count?: { assignments: number };
  policyTags?: { policyId: string; tagId: string; tag: RetentionTag }[];
}

interface ManagedFolderRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  mailboxesScanned: number;
  itemsScanned: number;
  itemsArchived: number;
  itemsSoftDeleted: number;
  itemsHardDeleted: number;
  itemsSkippedHold: number;
  throttled: boolean;
  errorMessage: string | null;
}

// ─── Labels ──────────────────────────────────────────────────────────────────

const TAG_TYPE_LABELS: Record<TagType, string> = {
  DPT: 'Default Policy Tag', RPT: 'Retention Policy Tag', PERSONAL: 'Personal Tag',
};
const TAG_TYPE_COLORS: Record<TagType, string> = {
  DPT: 'bg-purple-100 text-purple-700',
  RPT: 'bg-blue-100 text-blue-700',
  PERSONAL: 'bg-amber-100 text-amber-700',
};
const TAG_ACTION_LABELS: Record<TagAction, string> = {
  MOVE_TO_ARCHIVE: 'In Archiv verschieben',
  DELETE_AND_ALLOW_RECOVERY: 'Löschen (wiederherstellbar)',
  PERMANENTLY_DELETE: 'Endgültig löschen',
  MARK_AS_PAST_RETENTION_LIMIT: 'Nur markieren',
};
const FOLDER_TARGET_LABELS: Record<FolderTarget, string> = {
  INBOX: 'Posteingang', SENT_ITEMS: 'Gesendet', DELETED_ITEMS: 'Gelöschte Elemente',
  JUNK_EMAIL: 'Junk-E-Mail', DRAFTS: 'Entwürfe', OUTBOX: 'Postausgang',
  RECOVERABLE_ITEMS: 'Recoverable Items', ARCHIVE: 'Archiv', ALL_OTHER: 'Alle anderen Ordner',
};
const SCOPE_LABELS: Record<RetentionPolicy['scope'], string> = {
  ALL_ITEMS: 'Alle Elemente', INBOX: 'Posteingang', SENT_ITEMS: 'Gesendet',
  DELETED_ITEMS: 'Gelöschte Elemente', JUNK: 'Junk-E-Mail',
};
const LEGACY_ACTION_LABELS: Record<RetentionPolicy['action'], string> = {
  ARCHIVE: 'Archivieren', DELETE: 'Löschen', MOVE_TO_FOLDER: 'In Ordner verschieben',
};
const LEGACY_ACTION_COLORS: Record<RetentionPolicy['action'], string> = {
  ARCHIVE: 'bg-blue-100 text-blue-700', DELETE: 'bg-red-100 text-red-700', MOVE_TO_FOLDER: 'bg-yellow-100 text-yellow-700',
};

function daysLabel(d: number): string {
  if (d <= 0) return '—';
  if (d % 365 === 0) return `${d / 365} Jahr${d / 365 !== 1 ? 'e' : ''}`;
  if (d % 30 === 0) return `${d / 30} Monat${d / 30 !== 1 ? 'e' : ''}`;
  return `${d} Tag${d !== 1 ? 'e' : ''}`;
}

function fmtDateTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('de-DE') : '—';
}

// ─── Tag Modal ────────────────────────────────────────────────────────────────

function TagModal({ tag, onClose }: { tag: RetentionTag | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = tag !== null;
  const [form, setForm] = useState({
    name:          tag?.name ?? '',
    description:   tag?.description ?? '',
    type:          tag?.type ?? 'DPT' as TagType,
    action:        tag?.action ?? 'DELETE_AND_ALLOW_RECOVERY' as TagAction,
    retentionDays: tag?.retentionDays?.toString() ?? '365',
    folderTarget:  tag?.folderTarget ?? 'INBOX' as FolderTarget,
    enabled:       tag?.enabled ?? true,
  });

  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name:          form.name,
        description:   form.description,
        type:          form.type,
        action:        form.action,
        retentionDays: parseInt(form.retentionDays),
        enabled:       form.enabled,
        ...(form.type === 'RPT' ? { folderTarget: form.folderTarget } : {}),
        ...(form.type === 'DPT' ? { folderTarget: 'ALL_OTHER' } : {}),
      };
      return isEdit
        ? api.put(`/admin/compliance/retention/tags/${tag.id}`, body)
        : api.post('/admin/compliance/retention/tags', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-retention-tags'] });
      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      toast.success(isEdit ? 'Tag aktualisiert' : 'Tag erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">{isEdit ? 'Tag bearbeiten' : 'Neuer Retention Tag'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
            <input value={form.name} onChange={(e) => set('name', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="z.B. Default 1 Year Move to Archive" />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Typ *</label>
            <div className="grid grid-cols-3 gap-2">
              {(['DPT', 'RPT', 'PERSONAL'] as const).map((t) => (
                <button key={t} type="button" onClick={() => set('type', t)}
                  className={`px-3 py-2 text-sm rounded border ${
                    form.type === t ? 'bg-accent/10 border-accent text-accent font-medium' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                  }`}>
                  <p className="text-xs font-semibold">{t}</p>
                  <p className="text-[10px] opacity-70 mt-0.5">{TAG_TYPE_LABELS[t]}</p>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-1">
              {form.type === 'DPT' && 'Gilt fürs ganze Postfach — wenn kein spezifischeres Tag passt'}
              {form.type === 'RPT' && 'Bindet an einen Standardordner (Inbox, Sent, …)'}
              {form.type === 'PERSONAL' && 'User kann ihn manuell auf Items/Ordner anwenden'}
            </p>
          </div>

          {form.type === 'RPT' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Standardordner *</label>
              <select value={form.folderTarget} onChange={(e) => set('folderTarget', e.target.value as FolderTarget)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
                {(['INBOX', 'SENT_ITEMS', 'DELETED_ITEMS', 'JUNK_EMAIL', 'DRAFTS', 'OUTBOX', 'ARCHIVE', 'RECOVERABLE_ITEMS'] as FolderTarget[]).map((t) => (
                  <option key={t} value={t}>{FOLDER_TARGET_LABELS[t]}</option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Aufbewahrungsdauer (Tage)</label>
              <input type="number" min="1" value={form.retentionDays}
                onChange={(e) => set('retentionDays', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
              <p className="text-[11px] text-gray-400 mt-0.5">{daysLabel(parseInt(form.retentionDays) || 0)}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Aktion *</label>
              <select value={form.action} onChange={(e) => set('action', e.target.value as TagAction)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
                {(Object.entries(TAG_ACTION_LABELS) as [TagAction, string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Beschreibung</label>
            <textarea value={form.description} onChange={(e) => set('description', e.target.value)}
              rows={2} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} className="accent-accent" />
            <span className="text-sm text-gray-700">Aktiviert</span>
          </label>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Policy Modal mit Tag-Picker ──────────────────────────────────────────────

function PolicyModal({ policy, allTags, onClose }: { policy: RetentionPolicy | null; allTags: RetentionTag[]; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = policy !== null;
  const [form, setForm] = useState({
    name:             policy?.name ?? '',
    description:      policy?.description ?? '',
    respectLegalHold: policy?.respectLegalHold ?? true,
    enabled:          policy?.enabled ?? true,
  });
  const [selectedTags, setSelectedTags] = useState<Set<string>>(
    new Set((policy?.policyTags ?? []).map((pt) => pt.tagId)),
  );

  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleTag = (id: string) => {
    const next = new Set(selectedTags);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedTags(next);
  };

  // DPT-Validierung: maximal 1 DPT
  const dptCount = [...selectedTags].filter((id) => allTags.find((t) => t.id === id)?.type === 'DPT').length;

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        description: form.description,
        respectLegalHold: form.respectLegalHold,
        enabled: form.enabled,
        // Legacy-Defaults — neue Policies steuern alles über Tags
        retentionDays: 0,
        action: 'ARCHIVE',
        scope: 'ALL_ITEMS',
      };
      const saved = isEdit
        ? await api.put<RetentionPolicy>(`/admin/compliance/retention/${policy.id}`, body)
        : await api.post<RetentionPolicy>('/admin/compliance/retention', body);

      // Tags reconcilen
      const existingTagIds = new Set((policy?.policyTags ?? []).map((pt) => pt.tagId));
      const toAdd    = [...selectedTags].filter((id) => !existingTagIds.has(id));
      const toRemove = [...existingTagIds].filter((id) => !selectedTags.has(id));
      await Promise.all([
        ...toAdd.map((tagId) => api.post(`/admin/compliance/retention/${saved.id}/tags/${tagId}`, {})),
        ...toRemove.map((tagId) => api.delete(`/admin/compliance/retention/${saved.id}/tags/${tagId}`)),
      ]);
      return saved;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      toast.success(isEdit ? 'Richtlinie aktualisiert' : 'Richtlinie erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const tagsByType = {
    DPT:      allTags.filter((t) => t.type === 'DPT'),
    RPT:      allTags.filter((t) => t.type === 'RPT'),
    PERSONAL: allTags.filter((t) => t.type === 'PERSONAL'),
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold text-gray-900">{isEdit ? 'Richtlinie bearbeiten' : 'Neue Aufbewahrungsrichtlinie'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
            <input value={form.name} onChange={(e) => set('name', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="z.B. Standard Mitarbeiter" />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Beschreibung</label>
            <textarea value={form.description} onChange={(e) => set('description', e.target.value)}
              rows={2} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
          </div>

          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.respectLegalHold} onChange={(e) => set('respectLegalHold', e.target.checked)} className="accent-accent" />
              <span className="text-sm text-gray-700">Legal Hold respektieren</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} className="accent-accent" />
              <span className="text-sm text-gray-700">Aktiviert</span>
            </label>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Retention Tags zuweisen</p>
              <span className="text-[11px] text-gray-400">{selectedTags.size} ausgewählt</span>
            </div>
            {dptCount > 1 && (
              <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-700">
                <AlertCircle size={13} /> Eine Policy darf nur einen DPT haben — bitte nur einen markieren.
              </div>
            )}

            {(['DPT', 'RPT', 'PERSONAL'] as TagType[]).map((tt) => (
              <div key={tt} className="mb-3">
                <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                  {TAG_TYPE_LABELS[tt]} {tt === 'DPT' && <span className="text-amber-600">(max. 1)</span>}
                </p>
                {tagsByType[tt].length === 0 ? (
                  <p className="text-xs text-gray-400 italic">Keine {tt}-Tags vorhanden</p>
                ) : (
                  <div className="space-y-1">
                    {tagsByType[tt].map((t) => (
                      <label key={t.id} className="flex items-center gap-3 px-3 py-1.5 hover:bg-gray-50 rounded cursor-pointer">
                        <input type="checkbox" checked={selectedTags.has(t.id)} onChange={() => toggleTag(t.id)}
                          className="h-4 w-4 rounded border-gray-300 text-accent focus:ring-accent" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-gray-800">{t.name}</p>
                          <p className="text-[11px] text-gray-500">
                            {TAG_ACTION_LABELS[t.action]} · nach {daysLabel(t.retentionDays)}
                            {t.folderTarget && t.type === 'RPT' ? ` · Ordner: ${FOLDER_TARGET_LABELS[t.folderTarget]}` : ''}
                          </p>
                        </div>
                        {!t.enabled && <span className="text-[10px] bg-gray-200 text-gray-600 rounded px-1.5">deaktiviert</span>}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name || dptCount > 1}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Runs Modal ──────────────────────────────────────────────────────────────

function RunsModal({ onClose }: { onClose: () => void }) {
  const { data: runs = [], isLoading } = useQuery<ManagedFolderRun[]>({
    queryKey: ['admin-retention-runs'],
    queryFn:  () => api.get('/admin/compliance/retention/runs'),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Managed Folder Assistant — Run-Historie</h2>
            <p className="text-xs text-gray-500 mt-0.5">Letzte 30 MFA-Läufe</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="text-center text-sm text-gray-400 py-12">Laden…</p>
          ) : runs.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-12">Noch keine MFA-Läufe</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="text-left px-4 py-2.5">Start</th>
                  <th className="text-left px-4 py-2.5">Dauer</th>
                  <th className="text-right px-4 py-2.5">Postfächer</th>
                  <th className="text-right px-4 py-2.5">Items</th>
                  <th className="text-right px-4 py-2.5">Archiviert</th>
                  <th className="text-right px-4 py-2.5">Soft-Del</th>
                  <th className="text-right px-4 py-2.5">Hard-Del</th>
                  <th className="text-right px-4 py-2.5">Hold-Skip</th>
                  <th className="text-left px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const dur = r.completedAt ? Math.round((new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000) : null;
                  return (
                    <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-2 text-xs text-gray-700 whitespace-nowrap">{fmtDateTime(r.startedAt)}</td>
                      <td className="px-4 py-2 text-xs text-gray-600">{dur !== null ? `${dur}s` : 'läuft…'}</td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums">{r.mailboxesScanned}</td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums">{r.itemsScanned}</td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums text-blue-600">{r.itemsArchived}</td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums text-amber-600">{r.itemsSoftDeleted}</td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums text-red-600">{r.itemsHardDeleted}</td>
                      <td className="px-4 py-2 text-xs text-right tabular-nums text-purple-600">{r.itemsSkippedHold}</td>
                      <td className="px-4 py-2 text-xs">
                        {r.errorMessage ? (
                          <span className="inline-flex items-center gap-1 text-red-600" title={r.errorMessage}><AlertCircle size={12} /> Fehler</span>
                        ) : r.throttled ? (
                          <span className="inline-flex items-center gap-1 text-amber-600"><AlertCircle size={12} /> Gedrosselt</span>
                        ) : r.completedAt ? (
                          <span className="inline-flex items-center gap-1 text-green-600"><Check size={12} /> OK</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-blue-600">läuft…</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function RetentionPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'policies' | 'tags'>('policies');
  const [policyModal, setPolicyModal] = useState<'create' | RetentionPolicy | null>(null);
  const [tagModal, setTagModal] = useState<'create' | RetentionTag | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [deletePolicyConfirm, setDeletePolicyConfirm] = useState<RetentionPolicy | null>(null);
  const [deleteTagConfirm, setDeleteTagConfirm] = useState<RetentionTag | null>(null);

  const { data: policies = [], isLoading: loadingPolicies } = useQuery<RetentionPolicy[]>({
    queryKey: ['admin-retention'],
    queryFn:  () => api.get('/admin/compliance/retention'),
  });

  const { data: tags = [], isLoading: loadingTags } = useQuery<RetentionTag[]>({
    queryKey: ['admin-retention-tags'],
    queryFn:  () => api.get('/admin/compliance/retention/tags'),
  });

  const toggle = useMutation({
    mutationFn: (p: RetentionPolicy) => api.post(`/admin/compliance/retention/${p.id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-retention'] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const deletePolicy = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/compliance/retention/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      toast.success('Richtlinie gelöscht');
      setDeletePolicyConfirm(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteTag = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/compliance/retention/tags/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-retention-tags'] });
      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      toast.success('Tag gelöscht');
      setDeleteTagConfirm(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runNow = useMutation({
    mutationFn: () => api.post('/admin/compliance/retention/run', {}),
    onSuccess: (data: unknown) => {
      const r = data as { mailboxesScanned?: number; itemsScanned?: number };
      toast.success(`MFA-Lauf abgeschlossen — ${r.mailboxesScanned ?? 0} Postfächer, ${r.itemsScanned ?? 0} Items`);
      void qc.invalidateQueries({ queryKey: ['admin-retention-runs'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Archive size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Aufbewahrungsrichtlinien</h1>
            <p className="text-sm text-gray-500">Tag-basiert (DPT/RPT/Personal) · Managed Folder Assistant · Recoverable Items</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowRuns(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">
            <History size={14} /> MFA-Historie
          </button>
          <button onClick={() => runNow.mutate()} disabled={runNow.isPending}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-amber-700 border border-amber-300 bg-amber-50 rounded hover:bg-amber-100 disabled:opacity-50">
            <Play size={14} /> {runNow.isPending ? 'MFA läuft…' : 'MFA jetzt'}
          </button>
          <button onClick={() => tab === 'policies' ? setPolicyModal('create') : setTagModal('create')}
            className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90">
            <Plus size={15} /> {tab === 'policies' ? 'Neue Richtlinie' : 'Neuer Tag'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-4">
        <button onClick={() => setTab('policies')}
          className={`px-4 py-2 text-sm font-medium border-b-2 flex items-center gap-1.5 ${
            tab === 'policies' ? 'border-accent text-accent' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}>
          <ListChecks size={13} /> Richtlinien ({policies.length})
        </button>
        <button onClick={() => setTab('tags')}
          className={`px-4 py-2 text-sm font-medium border-b-2 flex items-center gap-1.5 ${
            tab === 'tags' ? 'border-accent text-accent' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}>
          <Tag size={13} /> Tags ({tags.length})
        </button>
      </div>

      {/* Policies */}
      {tab === 'policies' && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">Richtlinie</th>
                <th className="text-left px-4 py-3">Tags</th>
                <th className="text-left px-4 py-3">Zuweisungen</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loadingPolicies ? (
                <tr><td colSpan={5} className="text-center py-12 text-gray-400">Laden…</td></tr>
              ) : policies.length === 0 ? (
                <tr><td colSpan={5} className="text-center py-12 text-gray-400">Noch keine Richtlinien konfiguriert</td></tr>
              ) : policies.map((p) => (
                <tr key={p.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{p.name}</p>
                    {p.description && <p className="text-xs text-gray-500">{p.description}</p>}
                  </td>
                  <td className="px-4 py-3">
                    {p.policyTags && p.policyTags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {p.policyTags.map((pt) => (
                          <span key={pt.tagId} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${TAG_TYPE_COLORS[pt.tag.type]}`}>
                            <span className="font-semibold">{pt.tag.type}</span> {pt.tag.name}
                          </span>
                        ))}
                      </div>
                    ) : p.retentionDays > 0 ? (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] ${LEGACY_ACTION_COLORS[p.action]}`}>
                        Legacy: {LEGACY_ACTION_LABELS[p.action]} nach {daysLabel(p.retentionDays)} ({SCOPE_LABELS[p.scope]})
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400 italic">keine Tags</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{p._count?.assignments ?? 0}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => toggle.mutate(p)}>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        p.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {p.enabled ? 'Aktiv' : 'Deaktiviert'}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setPolicyModal(p)}
                        className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded"><Pencil size={13} /></button>
                      <button onClick={() => setDeletePolicyConfirm(p)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tags */}
      {tab === 'tags' && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">Tag</th>
                <th className="text-left px-4 py-3">Typ</th>
                <th className="text-left px-4 py-3">Aktion</th>
                <th className="text-left px-4 py-3">Frist</th>
                <th className="text-left px-4 py-3">Ordner / Scope</th>
                <th className="text-left px-4 py-3">Verwendet in</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loadingTags ? (
                <tr><td colSpan={8} className="text-center py-12 text-gray-400">Laden…</td></tr>
              ) : tags.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12 text-gray-400">Noch keine Tags konfiguriert</td></tr>
              ) : tags.map((t) => (
                <tr key={t.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{t.name}</p>
                    {t.description && <p className="text-xs text-gray-500">{t.description}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${TAG_TYPE_COLORS[t.type]}`}>{t.type}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700">{TAG_ACTION_LABELS[t.action]}</td>
                  <td className="px-4 py-3 text-xs text-gray-700 font-medium">{daysLabel(t.retentionDays)}</td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {t.folderTarget ? <span className="inline-flex items-center gap-1"><FolderIcon size={11} /> {FOLDER_TARGET_LABELS[t.folderTarget]}</span> : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {t._count?.policyTags ?? 0} Policies
                    {t._count && t._count.messages > 0 ? <span className="text-gray-400"> · {t._count.messages} Mails</span> : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      t.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {t.enabled ? 'Aktiv' : 'Deaktiviert'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {!t.isSystem && (
                        <>
                          <button onClick={() => setTagModal(t)}
                            className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded"><Pencil size={13} /></button>
                          <button onClick={() => setDeleteTagConfirm(t)}
                            className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"><Trash2 size={13} /></button>
                        </>
                      )}
                      {t.isSystem && (
                        <span className="text-[10px] text-gray-400 italic">System</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {policyModal !== null && <PolicyModal policy={policyModal === 'create' ? null : policyModal} allTags={tags} onClose={() => setPolicyModal(null)} />}
      {tagModal !== null && <TagModal tag={tagModal === 'create' ? null : tagModal} onClose={() => setTagModal(null)} />}
      {showRuns && <RunsModal onClose={() => setShowRuns(false)} />}

      {deletePolicyConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Richtlinie löschen</h2>
            <p className="text-sm text-gray-600 mb-4">Soll <strong>{deletePolicyConfirm.name}</strong> wirklich gelöscht werden?</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeletePolicyConfirm(null)} className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
              <button onClick={() => deletePolicy.mutate(deletePolicyConfirm.id)} disabled={deletePolicy.isPending}
                className="px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50">
                {deletePolicy.isPending ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTagConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Tag löschen</h2>
            <p className="text-sm text-gray-600 mb-4">Soll der Tag <strong>{deleteTagConfirm.name}</strong> wirklich gelöscht werden? Er wird auch aus allen Policies entfernt.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTagConfirm(null)} className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
              <button onClick={() => deleteTag.mutate(deleteTagConfirm.id)} disabled={deleteTag.isPending}
                className="px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50">
                {deleteTag.isPending ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
