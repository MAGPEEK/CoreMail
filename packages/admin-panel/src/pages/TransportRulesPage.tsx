import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Workflow, Plus, Trash2, Pencil, X, Loader2, GripVertical, ToggleLeft, ToggleRight,
  Sparkles, ShieldAlert, ShieldCheck, FileWarning, Mail, AlertTriangle,
  CreditCard, BookOpen, Forward, Ban,
} from 'lucide-react';
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

// ── Vorlagen (Exchange-2019-typische „Aus Vorlage"-Optionen) ────────────────
// Jede Vorlage prefilled die Conditions + Actions. Platzhalter wie
// @firma.com muss der Admin nach Auswahl anpassen.
interface RuleTemplate {
  id:          string;
  category:    'tagging' | 'compliance' | 'security' | 'governance';
  icon:        React.ElementType;
  iconClass:   string;
  name:        string;
  description: string;
  rule: {
    name:        string;
    description: string;
    priority:    number;
    conditions:  Condition[];
    actions:     Action[];
  };
}

const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: 'external-prefix',
    category: 'tagging',
    icon: ShieldAlert, iconClass: 'text-amber-600 bg-amber-50',
    name: '[EXTERN]-Markierung im Betreff',
    description: 'Hängt „[EXTERN] " vor den Betreff aller Mails, die nicht aus der eigenen Domain kommen.',
    rule: {
      name: '[EXTERN]-Markierung',
      description: 'Markiert eingehende Mails von externen Absendern',
      priority: 100,
      conditions: [{ field: 'from', op: 'notContains', value: '@DEINE-DOMAIN.com' }],
      actions:    [{ type: 'setSubjectPrefix', value: '[EXTERN] ' }],
    },
  },
  {
    id: 'outgoing-disclaimer',
    category: 'compliance',
    icon: BookOpen, iconClass: 'text-blue-600 bg-blue-50',
    name: 'Disclaimer für ausgehende Mails',
    description: 'Hängt einen Standard-Haftungsausschluss an alle Mails an externe Empfänger an.',
    rule: {
      name: 'Outgoing Disclaimer',
      description: 'Compliance-Haftungsausschluss für externe Empfänger',
      priority: 200,
      conditions: [{ field: 'to', op: 'notContains', value: '@DEINE-DOMAIN.com' }],
      actions:    [{ type: 'addDisclaimer', value: 'Diese E-Mail enthält vertrauliche Informationen. Wenn Sie nicht der beabsichtigte Empfänger sind, informieren Sie uns bitte und löschen Sie die Mail.' }],
    },
  },
  {
    id: 'spam-quarantine',
    category: 'security',
    icon: ShieldCheck, iconClass: 'text-red-600 bg-red-50',
    name: 'Spam-Score > 5 quarantänieren',
    description: 'Verschiebt Mails mit hoher Spam-Bewertung direkt in die Quarantäne.',
    rule: {
      name: 'Spam-Quarantäne (Score > 5)',
      description: 'rspamd-Score über Schwellwert → Quarantäne',
      priority: 50,
      conditions: [{ field: 'spamScore', op: 'greaterThan', value: '5' }],
      actions:    [{ type: 'quarantine', value: '' }],
    },
  },
  {
    id: 'oversize-reject',
    category: 'governance',
    icon: FileWarning, iconClass: 'text-orange-600 bg-orange-50',
    name: 'Mails > 25 MB ablehnen',
    description: 'Lehnt eingehende Mails ab, die größer als 25 MB sind. Schützt vor Quota-Verbrauch.',
    rule: {
      name: 'Größenlimit 25 MB',
      description: 'Lehnt zu große eingehende Mails ab',
      priority: 150,
      conditions: [{ field: 'size', op: 'greaterThan', value: '26214400' }],
      actions:    [{ type: 'reject', value: 'Nachricht zu groß — max. 25 MB erlaubt.' }],
    },
  },
  {
    id: 'malware-extensions',
    category: 'security',
    icon: Ban, iconClass: 'text-red-700 bg-red-100',
    name: 'Verdächtige Anhang-Endungen quarantänieren',
    description: 'Quarantäne bei Subject- oder Body-Treffer auf .exe, .bat, .scr, .cmd, .vbs, .js, .jar, .hta.',
    rule: {
      name: 'Malware-Endungen',
      description: 'Klassische ausführbare Dateinamen im Betreff oder Body',
      priority: 30,
      conditions: [{ field: 'subject', op: 'regex', value: '\\.(exe|bat|scr|cmd|vbs|js|jar|hta)\\b' }],
      actions:    [{ type: 'quarantine', value: '' }],
    },
  },
  {
    id: 'credit-card-detect',
    category: 'compliance',
    icon: CreditCard, iconClass: 'text-purple-600 bg-purple-50',
    name: 'Kreditkartennummern erkennen',
    description: 'Quarantäne bei Body-Treffer auf 13–16-stellige Zahlenfolgen (möglicher PAN). Hilft bei PCI-DSS.',
    rule: {
      name: 'Kreditkarten-Detection',
      description: 'Quarantäne bei vermuteter PAN im Body',
      priority: 40,
      conditions: [{ field: 'body', op: 'regex', value: '\\b(?:\\d[ -]*?){13,16}\\b' }],
      actions:    [{ type: 'quarantine', value: '' }],
    },
  },
  {
    id: 'compliance-bcc',
    category: 'compliance',
    icon: Mail, iconClass: 'text-indigo-600 bg-indigo-50',
    name: 'BCC an Compliance-Postfach',
    description: 'Kopiert alle Mails an einen festen Compliance-Empfänger zur Aufbewahrung.',
    rule: {
      name: 'Compliance-BCC',
      description: 'Alle Mails als BCC an Compliance-Adresse',
      priority: 500,
      conditions: [{ field: 'to', op: 'contains', value: '@DEINE-DOMAIN.com' }],
      actions:    [{ type: 'addRecipient', value: 'compliance@DEINE-DOMAIN.com' }],
    },
  },
  {
    id: 'ceo-phishing',
    category: 'security',
    icon: AlertTriangle, iconClass: 'text-rose-600 bg-rose-50',
    name: 'CEO-Phishing-Schutz',
    description: 'Markiert verdächtige Mails, deren Absendername „CEO/Geschäftsführer/Chef" enthält, aber von außerhalb der Domain stammt.',
    rule: {
      name: 'CEO-Phishing-Warnung',
      description: 'Klassischer Business-Email-Compromise-Indikator',
      priority: 25,
      conditions: [{ field: 'from', op: 'regex', value: '(ceo|geschäftsführer|chef|director).*@(?!DEINE-DOMAIN\\.com).+' }],
      actions:    [{ type: 'setSubjectPrefix', value: '⚠ MÖGLICHES PHISHING — ' }],
    },
  },
  {
    id: 'block-attachments-external',
    category: 'governance',
    icon: Forward, iconClass: 'text-teal-600 bg-teal-50',
    name: 'Anhänge an Externe X-Header markieren',
    description: 'Setzt einen X-Coremail-External-Attachment-Header wenn Mail mit Anhang an externe Empfänger geht (zur DLP-Auswertung).',
    rule: {
      name: 'DLP-Marker für externe Anhänge',
      description: 'Hilfs-Header für nachgelagertes DLP-Tracking',
      priority: 600,
      conditions: [
        { field: 'hasAttachment', op: 'is',          value: 'true' },
        { field: 'to',            op: 'notContains', value: '@DEINE-DOMAIN.com' },
      ],
      actions: [{ type: 'addHeader', value: 'X-Coremail-External-Attachment: true' }],
    },
  },
];

const CATEGORY_LABELS: Record<RuleTemplate['category'], string> = {
  tagging:    'Kennzeichnung',
  compliance: 'Compliance',
  security:   'Sicherheit',
  governance: 'Governance',
};

// ── Template Picker Modal ────────────────────────────────────────────────────
function TemplatePickerModal({
  onSelect, onClose,
}: {
  onSelect: (tpl: RuleTemplate) => void;
  onClose:  () => void;
}) {
  const [filter, setFilter] = useState<'all' | RuleTemplate['category']>('all');
  const visible = filter === 'all' ? RULE_TEMPLATES : RULE_TEMPLATES.filter((t) => t.category === filter);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 shrink-0">
          <div>
            <h2 className="font-semibold text-gray-900 flex items-center gap-2">
              <Sparkles size={17} className="text-blue-600" /> Regel aus Vorlage erstellen
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Wähle eine Vorlage als Ausgangsbasis — Bedingungen und Aktionen werden vorgefüllt, du passt sie danach an.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="px-5 py-2 border-b border-gray-100 shrink-0 flex items-center gap-1.5 text-xs flex-wrap">
          <span className="text-gray-500 mr-1">Filter:</span>
          {(['all', 'tagging', 'compliance', 'security', 'governance'] as const).map((c) => (
            <button key={c} type="button" onClick={() => setFilter(c)}
              className={`px-2.5 py-1 rounded border ${
                filter === c ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}>
              {c === 'all' ? `Alle (${RULE_TEMPLATES.length})` : `${CATEGORY_LABELS[c]} (${RULE_TEMPLATES.filter((t) => t.category === c).length})`}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visible.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onSelect(t)}
                  className="text-left p-3 border border-gray-200 rounded-lg hover:border-blue-400 hover:bg-blue-50/30 transition-colors group"
                >
                  <div className="flex items-start gap-2.5">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${t.iconClass}`}>
                      <Icon size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-medium text-gray-900 truncate group-hover:text-blue-700">{t.name}</p>
                      </div>
                      <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">{CATEGORY_LABELS[t.category]}</p>
                      <p className="text-xs text-gray-600 leading-relaxed">{t.description}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between shrink-0">
          <p className="text-xs text-gray-400">
            Platzhalter wie <code className="bg-gray-100 px-1 rounded">@DEINE-DOMAIN.com</code> bitte nach Auswahl anpassen.
          </p>
          <button onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}

export function TransportRulesPage() {
  const qc = useQueryClient();
  const [editItem, setEditItem] = useState<TransportRule | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Initial-State, wenn die Regel aus einer Vorlage gestartet wird:
  const [createInitial, setCreateInitial] = useState<RuleTemplate['rule'] | null>(null);

  const { data: rules = [], isLoading } = useQuery<TransportRule[]>({
    queryKey: ['admin-transport-rules'],
    queryFn: () => api.get<TransportRule[]>('/admin/transport-rules'),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/transport-rules/${id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-transport-rules'] }),
    onError: () => toast.error('Fehler'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/transport-rules/${id}`),
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
        <div className="flex items-center gap-2">
          <button onClick={() => setPickerOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-blue-700 bg-blue-50 border border-blue-200 text-sm font-medium rounded-lg hover:bg-blue-100 transition-colors">
            <Sparkles size={14} /> Aus Vorlage
          </button>
          <button onClick={() => { setCreateInitial(null); setCreateOpen(true); }}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
            <Plus size={14} /> Neue Regel
          </button>
        </div>
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

      {pickerOpen && (
        <TemplatePickerModal
          onSelect={(tpl) => {
            setCreateInitial(tpl.rule);
            setPickerOpen(false);
            setCreateOpen(true);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {createOpen && (
        <RuleModal
          initial={createInitial}
          onClose={() => { setCreateOpen(false); setCreateInitial(null); }}
        />
      )}
      {editItem && <RuleModal rule={editItem} onClose={() => setEditItem(null)} />}
    </div>
  );
}

// ── Rule Modal ────────────────────────────────────────────────────────────────
function RuleModal({ rule, initial, onClose }: {
  rule?: TransportRule;
  /** Vorbefüllt aus einer Template-Auswahl. Wird ignoriert wenn `rule` (Edit-Modus) gesetzt ist. */
  initial?: RuleTemplate['rule'] | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName]         = useState(rule?.name ?? initial?.name ?? '');
  const [description, setDesc]  = useState(rule?.description ?? initial?.description ?? '');
  const [priority, setPriority] = useState(rule?.priority ?? initial?.priority ?? 0);
  const [enabled, setEnabled]   = useState(rule?.enabled ?? true);
  const [conditions, setConds]  = useState<Condition[]>(
    rule?.conditions ?? initial?.conditions ?? [{ field: 'from', op: 'contains', value: '' }],
  );
  const [actions, setActions]   = useState<Action[]>(
    rule?.actions ?? initial?.actions ?? [{ type: 'addHeader', value: '' }],
  );

  const mutation = useMutation({
    mutationFn: () => {
      const body = { name, description, priority, enabled, conditions, actions };
      return rule
        ? api.put(`/admin/transport-rules/${rule.id}`, body)
        : api.post('/admin/transport-rules', body);
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
