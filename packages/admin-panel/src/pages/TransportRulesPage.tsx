import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Workflow, Plus, Trash2, Pencil, X, Loader2, GripVertical, ToggleLeft, ToggleRight } from 'lucide-react';
import { api } from '../api/client.js';

interface Condition { field: string; op: string; value: string }
interface Action    { type: string; value: string }
interface TransportRule {
  id: string; name: string; description: string; enabled: boolean;
  priority: number; conditions: Condition[]; actions: Action[];
  createdAt: string;
}

const CONDITION_FIELDS = [
  { value: 'from', label: 'Absender' }, { value: 'to', label: 'Empfänger' },
  { value: 'subject', label: 'Betreff' }, { value: 'body', label: 'Nachrichtentext' },
  { value: 'hasAttachment', label: 'Hat Anhang' }, { value: 'size', label: 'Größe (Bytes)' },
  { value: 'spamScore', label: 'Spam-Score' },
];
const CONDITION_OPS = [
  { value: 'contains', label: 'enthält' }, { value: 'notContains', label: 'enthält nicht' },
  { value: 'equals', label: 'ist gleich' }, { value: 'startsWith', label: 'beginnt mit' },
  { value: 'regex', label: 'Regex' }, { value: 'greaterThan', label: '>' },
  { value: 'lessThan', label: '<' }, { value: 'is', label: 'ist' },
];
const ACTION_TYPES = [
  { value: 'addHeader', label: 'Header hinzufügen' }, { value: 'removeHeader', label: 'Header entfernen' },
  { value: 'redirect', label: 'Umleiten an' }, { value: 'reject', label: 'Ablehnen' },
  { value: 'addRecipient', label: 'Empfänger hinzufügen' }, { value: 'setSubjectPrefix', label: 'Betreff-Präfix' },
  { value: 'setSubjectSuffix', label: 'Betreff-Suffix' }, { value: 'quarantine', label: 'Quarantäne' },
  { value: 'addDisclaimer', label: 'Haftungsausschluss anhängen' },
];

export function TransportRulesPage() {
  const qc = useQueryClient();
  const [editItem, setEditItem] = useState<TransportRule | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: rules = [], isLoading } = useQuery<TransportRule[]>({
    queryKey: ['admin-transport-rules'],
    queryFn: () => api.get<TransportRule[]>('/api/v1/admin/transport-rules'),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/api/v1/admin/transport-rules/${id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-transport-rules'] }),
    onError: () => toast.error('Fehler'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/transport-rules/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-transport-rules'] }); toast.success('Gelöscht'); },
    onError: () => toast.error('Löschen fehlgeschlagen'),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Workflow size={22} className="text-blue-600" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">Transportregeln</h1>
            <p className="text-sm text-gray-500">{rules.length} Regel{rules.length !== 1 ? 'n' : ''}</p>
          </div>
        </div>
        <button onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
          <Plus size={14} /> Neue Regel
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" /> Lade…
          </div>
        ) : rules.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">
            <Workflow size={28} className="mx-auto mb-2 opacity-30" />
            Keine Transportregeln. Erstelle deine erste Regel.
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="w-8 px-4 py-3"></th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Priorität</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name / Beschreibung</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Bedingungen</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Aktionen</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status / Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rules.map(rule => (
                <tr key={rule.id} className={`hover:bg-gray-50 transition-colors ${!rule.enabled ? 'opacity-60' : ''}`}>
                  <td className="px-4 py-3 text-gray-300"><GripVertical size={14} /></td>
                  <td className="px-4 py-3">
                    <span className="text-sm font-mono text-gray-500">{rule.priority}</span>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900 text-sm">{rule.name}</p>
                    {rule.description && <p className="text-xs text-gray-400">{rule.description}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-y-0.5">
                      {rule.conditions.slice(0, 2).map((c, i) => (
                        <p key={i} className="text-xs text-gray-600">
                          <span className="font-medium">{CONDITION_FIELDS.find(f => f.value === c.field)?.label ?? c.field}</span>
                          {' '}{CONDITION_OPS.find(o => o.value === c.op)?.label ?? c.op}
                          {' '}<span className="font-mono bg-gray-100 px-1 rounded">{c.value}</span>
                        </p>
                      ))}
                      {rule.conditions.length > 2 && <p className="text-xs text-gray-400">+{rule.conditions.length - 2} weitere</p>}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-y-0.5">
                      {rule.actions.slice(0, 2).map((a, i) => (
                        <p key={i} className="text-xs text-gray-600">
                          <span className="font-medium">{ACTION_TYPES.find(t => t.value === a.type)?.label ?? a.type}</span>
                          {a.value && <span className="font-mono bg-gray-100 px-1 rounded ml-1">{a.value.slice(0, 30)}</span>}
                        </p>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => toggleMutation.mutate(rule.id)} title={rule.enabled ? 'Deaktivieren' : 'Aktivieren'}
                        className={`p-1.5 rounded transition-colors ${rule.enabled ? 'text-green-500 hover:text-green-700 hover:bg-green-50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}>
                        {rule.enabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                      </button>
                      <button onClick={() => setEditItem(rule)} title="Bearbeiten"
                        className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => { if (window.confirm(`Regel "${rule.name}" löschen?`)) deleteMutation.mutate(rule.id); }}
                        title="Löschen"
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {createOpen && <RuleModal onClose={() => setCreateOpen(false)} />}
      {editItem   && <RuleModal rule={editItem} onClose={() => setEditItem(null)} />}
    </div>
  );
}

// ── Rule Modal ────────────────────────────────────────────────────────────────
function RuleModal({ rule, onClose }: { rule?: TransportRule; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName]         = useState(rule?.name ?? '');
  const [description, setDesc]  = useState(rule?.description ?? '');
  const [priority, setPriority] = useState(rule?.priority ?? 0);
  const [enabled, setEnabled]   = useState(rule?.enabled ?? true);
  const [conditions, setConds]  = useState<Condition[]>(rule?.conditions ?? [{ field: 'from', op: 'contains', value: '' }]);
  const [actions, setActions]   = useState<Action[]>(rule?.actions ?? [{ type: 'addHeader', value: '' }]);

  const mutation = useMutation({
    mutationFn: () => {
      const body = { name, description, priority, enabled, conditions, actions };
      return rule
        ? api.put(`/api/v1/admin/transport-rules/${rule.id}`, body)
        : api.post('/api/v1/admin/transport-rules', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-transport-rules'] });
      toast.success(rule ? 'Gespeichert' : 'Erstellt');
      onClose();
    },
    onError: () => toast.error('Fehler'),
  });

  function updateCond(i: number, field: Partial<Condition>) { setConds(cs => cs.map((c, j) => j === i ? { ...c, ...field } : c)); }
  function updateAction(i: number, field: Partial<Action>) { setActions(as => as.map((a, j) => j === i ? { ...a, ...field } : a)); }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white">
          <h2 className="font-semibold text-gray-900">{rule ? 'Regel bearbeiten' : 'Neue Transportregel'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-5">
          {/* Grunddaten */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="field-label">Name</label>
              <input value={name} onChange={e => setName(e.target.value)} className="input" placeholder="z.B. Spam-Disclaimer anfügen" />
            </div>
            <div className="col-span-2">
              <label className="field-label">Beschreibung (optional)</label>
              <input value={description} onChange={e => setDesc(e.target.value)} className="input" />
            </div>
            <div>
              <label className="field-label">Priorität (niedriger = zuerst)</label>
              <input type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} className="input" min={0} max={9999} />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="rounded" />
                Aktiv
              </label>
            </div>
          </div>

          {/* Bedingungen */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-500 uppercase">Bedingungen (alle müssen zutreffen)</p>
              <button onClick={() => setConds(cs => [...cs, { field: 'from', op: 'contains', value: '' }])}
                className="text-xs text-blue-600 hover:text-blue-800">+ Bedingung</button>
            </div>
            {conditions.map((c, i) => (
              <div key={i} className="flex gap-2 mb-2 items-center">
                <select value={c.field} onChange={e => updateCond(i, { field: e.target.value })} className="input w-36">
                  {CONDITION_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <select value={c.op} onChange={e => updateCond(i, { op: e.target.value })} className="input w-32">
                  {CONDITION_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input value={c.value} onChange={e => updateCond(i, { value: e.target.value })} className="input flex-1" placeholder="Wert" />
                <button onClick={() => setConds(cs => cs.filter((_, j) => j !== i))} className="p-1.5 text-gray-400 hover:text-red-500">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>

          {/* Aktionen */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-500 uppercase">Aktionen</p>
              <button onClick={() => setActions(as => [...as, { type: 'addHeader', value: '' }])}
                className="text-xs text-blue-600 hover:text-blue-800">+ Aktion</button>
            </div>
            {actions.map((a, i) => (
              <div key={i} className="flex gap-2 mb-2 items-center">
                <select value={a.type} onChange={e => updateAction(i, { type: e.target.value })} className="input w-48">
                  {ACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <input value={a.value} onChange={e => updateAction(i, { value: e.target.value })} className="input flex-1" placeholder="Wert (optional)" />
                <button onClick={() => setActions(as => as.filter((_, j) => j !== i))} className="p-1.5 text-gray-400 hover:text-red-500">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="btn-secondary">Abbrechen</button>
            <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name || conditions.length === 0 || actions.length === 0}
              className="btn-primary flex items-center gap-1.5">
              {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {rule ? 'Speichern' : 'Erstellen'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
