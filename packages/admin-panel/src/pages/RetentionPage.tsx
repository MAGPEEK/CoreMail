import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, Plus, Pencil, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

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
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<RetentionPolicy['action'], string> = {
  ARCHIVE: 'Archivieren', DELETE: 'Löschen', MOVE_TO_FOLDER: 'In Ordner verschieben',
};
const ACTION_COLORS: Record<RetentionPolicy['action'], string> = {
  ARCHIVE: 'bg-blue-100 text-blue-700',
  DELETE:  'bg-red-100 text-red-700',
  MOVE_TO_FOLDER: 'bg-yellow-100 text-yellow-700',
};
const SCOPE_LABELS: Record<RetentionPolicy['scope'], string> = {
  ALL_ITEMS: 'Alle Elemente', INBOX: 'Posteingang', SENT_ITEMS: 'Gesendet',
  DELETED_ITEMS: 'Gelöschte Elemente', JUNK: 'Junk-E-Mail',
};

function daysLabel(d: number): string {
  if (d % 365 === 0) return `${d / 365} Jahr${d / 365 !== 1 ? 'e' : ''}`;
  if (d % 30 === 0) return `${d / 30} Monat${d / 30 !== 1 ? 'e' : ''}`;
  return `${d} Tag${d !== 1 ? 'e' : ''}`;
}

// ─── Policy Modal ─────────────────────────────────────────────────────────────

function PolicyModal({ policy, onClose }: { policy: RetentionPolicy | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = policy !== null;

  const [form, setForm] = useState({
    name:             policy?.name ?? '',
    description:      policy?.description ?? '',
    retentionDays:    policy?.retentionDays?.toString() ?? '365',
    action:           policy?.action ?? 'ARCHIVE' as RetentionPolicy['action'],
    targetFolder:     policy?.targetFolder ?? '',
    scope:            policy?.scope ?? 'ALL_ITEMS' as RetentionPolicy['scope'],
    respectLegalHold: policy?.respectLegalHold ?? true,
    enabled:          policy?.enabled ?? true,
  });

  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm(f => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        description: form.description,
        retentionDays: parseInt(form.retentionDays),
        action: form.action,
        scope: form.scope,
        respectLegalHold: form.respectLegalHold,
        enabled: form.enabled,
        ...(form.action === 'MOVE_TO_FOLDER' ? { targetFolder: form.targetFolder } : {}),
      };
      return isEdit
        ? api.put(`/admin/compliance/retention/${policy.id}`, body)
        : api.post('/admin/compliance/retention', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      toast.success(isEdit ? 'Richtlinie aktualisiert' : 'Richtlinie erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">{isEdit ? 'Richtlinie bearbeiten' : 'Neue Aufbewahrungsrichtlinie'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
            <input value={form.name} onChange={e => set('name', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="z.B. 7-Jahre-Archivierung" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Aufbewahrungsdauer (Tage)</label>
              <input type="number" min="1" value={form.retentionDays} onChange={e => set('retentionDays', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
              <p className="text-xs text-gray-400 mt-0.5">{daysLabel(parseInt(form.retentionDays) || 0)}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Aktion nach Ablauf</label>
              <select value={form.action} onChange={e => set('action', e.target.value as RetentionPolicy['action'])}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
                {(Object.entries(ACTION_LABELS) as [RetentionPolicy['action'], string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          {form.action === 'MOVE_TO_FOLDER' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Ziel-Ordner</label>
              <input value={form.targetFolder} onChange={e => set('targetFolder', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="Archiv" />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Gilt für</label>
            <select value={form.scope} onChange={e => set('scope', e.target.value as RetentionPolicy['scope'])}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
              {(Object.entries(SCOPE_LABELS) as [RetentionPolicy['scope'], string][]).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Beschreibung</label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)}
              rows={2} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
          </div>

          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.respectLegalHold} onChange={e => set('respectLegalHold', e.target.checked)} className="accent-accent" />
              <span className="text-sm text-gray-700">Legal Hold beachten</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} className="accent-accent" />
              <span className="text-sm text-gray-700">Aktiviert</span>
            </label>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name || !form.retentionDays}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function RetentionPage() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<'create' | RetentionPolicy | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<RetentionPolicy | null>(null);

  const { data: policies = [], isLoading } = useQuery<RetentionPolicy[]>({
    queryKey: ['admin-retention'],
    queryFn: () => api.get('/admin/compliance/retention'),
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
      setDeleteConfirm(null);
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
            <p className="text-sm text-gray-500">Automatisches Archivieren oder Löschen älterer Nachrichten</p>
          </div>
        </div>
        <button onClick={() => setModal('create')}
          className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90">
          <Plus size={15} /> Neue Richtlinie
        </button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3">Richtlinie</th>
              <th className="text-left px-4 py-3">Aufbewahrung</th>
              <th className="text-left px-4 py-3">Aktion</th>
              <th className="text-left px-4 py-3">Scope</th>
              <th className="text-left px-4 py-3">Zuweisungen</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="text-center py-12 text-gray-400">Laden…</td></tr>
            ) : policies.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-12 text-gray-400">Noch keine Aufbewahrungsrichtlinien konfiguriert</td></tr>
            ) : policies.map(p => (
              <tr key={p.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900">{p.name}</p>
                  {p.description && <p className="text-xs text-gray-500">{p.description}</p>}
                </td>
                <td className="px-4 py-3 font-medium text-gray-700">{daysLabel(p.retentionDays)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ACTION_COLORS[p.action]}`}>
                    {ACTION_LABELS[p.action]}
                    {p.action === 'MOVE_TO_FOLDER' && p.targetFolder ? ` → ${p.targetFolder}` : ''}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">{SCOPE_LABELS[p.scope]}</td>
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
                    <button onClick={() => setModal(p)}
                      className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded"><Pencil size={13} /></button>
                    <button onClick={() => setDeleteConfirm(p)}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"><Trash2 size={13} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal !== null && <PolicyModal policy={modal === 'create' ? null : modal} onClose={() => setModal(null)} />}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Richtlinie löschen</h2>
            <p className="text-sm text-gray-600 mb-4">Soll <strong>{deleteConfirm.name}</strong> wirklich gelöscht werden?</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
              <button onClick={() => deletePolicy.mutate(deleteConfirm.id)} disabled={deletePolicy.isPending}
                className="px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50">
                {deletePolicy.isPending ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
