import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookText, Plus, Pencil, Trash2 } from 'lucide-react';
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SCOPE_LABELS: Record<JournalingRule['scope'], string> = {
  ALL: 'Alle Nachrichten', INBOUND: 'Eingehend', OUTBOUND: 'Ausgehend', INTERNAL: 'Intern',
};
const RECIPIENT_LABELS: Record<JournalingRule['recipientType'], string> = {
  ALL_MAILBOXES: 'Alle Postfächer', SPECIFIC_USERS: 'Bestimmte User', DOMAIN: 'Domain',
};

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
    wrapAsReport:   rule?.wrapAsReport ?? true,
    enabled:        rule?.enabled ?? true,
  });

  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm(f => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => isEdit
      ? api.put(`/admin/compliance/journaling/${rule.id}`, form)
      : api.post('/admin/compliance/journaling', form),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-journaling'] });
      toast.success(isEdit ? 'Regel aktualisiert' : 'Regel erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">{isEdit ? 'Regel bearbeiten' : 'Neue Journaling-Regel'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
            <input value={form.name} onChange={e => set('name', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="z.B. Compliance-Archivierung" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Journal-Adresse * (Ziel für Kopien)</label>
            <input value={form.journalAddress} onChange={e => set('journalAddress', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="archiv@compliance.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Scope</label>
              <select value={form.scope} onChange={e => set('scope', e.target.value as JournalingRule['scope'])}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
                {(Object.entries(SCOPE_LABELS) as [JournalingRule['scope'], string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Gilt für</label>
              <select value={form.recipientType} onChange={e => set('recipientType', e.target.value as JournalingRule['recipientType'])}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
                {(Object.entries(RECIPIENT_LABELS) as [JournalingRule['recipientType'], string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Beschreibung</label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)}
              rows={2} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.wrapAsReport} onChange={e => set('wrapAsReport', e.target.checked)} className="accent-accent" />
              <span className="text-sm text-gray-700">Als RFC 3462 Journal-Report einhüllen</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} className="accent-accent" />
              <span className="text-sm text-gray-700">Aktiviert</span>
            </label>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name || !form.journalAddress}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function JournalingPage() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<'create' | JournalingRule | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<JournalingRule | null>(null);

  const { data: rules = [], isLoading } = useQuery<JournalingRule[]>({
    queryKey: ['admin-journaling'],
    queryFn: () => api.get('/admin/compliance/journaling'),
  });

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
            <h1 className="text-xl font-semibold text-gray-900">Journaling-Regeln</h1>
            <p className="text-sm text-gray-500">Kopien aller Nachrichten an eine Compliance-Adresse senden (RFC 3462)</p>
          </div>
        </div>
        <button onClick={() => setModal('create')}
          className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90">
          <Plus size={15} /> Neue Regel
        </button>
      </div>

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
            ) : rules.map(r => (
              <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900">{r.name}</p>
                  {r.description && <p className="text-xs text-gray-500">{r.description}</p>}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-gray-700">{r.journalAddress}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">{SCOPE_LABELS[r.scope]}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">{RECIPIENT_LABELS[r.recipientType]}</td>
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
