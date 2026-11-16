import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { X, Plus, Trash2, Save, ChevronDown, ChevronUp, Info } from 'lucide-react';
import { Modal } from './Modal.js';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type {
  MailRule, RuleCondition, RuleAction, RuleField, RuleOperator, RulePreset,
} from '../api/rule-types.js';
import type { Folder, Category } from '../api/types.js';

interface Props {
  rule: MailRule | null;            // null = new rule
  preset?: RulePreset;              // Prefill when creating from a mail
  onClose: () => void;
  onSaved: () => void;
}

// ── Labels ────────────────────────────────────────────────────────────────────
const FIELD_LABEL: Record<RuleField, string> = {
  from:          'Von',
  to:            'An',
  cc:            'CC',
  bcc:           'BCC',
  recipient:     'Empfänger (An/CC/BCC)',
  subject:       'Betreff',
  body:          'Body',
  hasAttachment: 'Hat Anhang',
  size:          'Größe (Bytes)',
  importance:    'Wichtigkeit',
  sentOnlyToMe:  'Nur an mich gesendet',
};

const OP_LABEL: Record<RuleOperator, string> = {
  contains:    'enthält',
  notContains: 'enthält nicht',
  equals:      'ist gleich',
  notEquals:   'ist ungleich',
  startsWith:  'beginnt mit',
  endsWith:    'endet mit',
  regex:       'matched Regex',
  greaterThan: 'größer als',
  lessThan:    'kleiner als',
  is:          'ist',
};

const ACTION_LABEL: Record<RuleAction['type'], string> = {
  moveTo:        'Verschieben in Ordner',
  copyTo:        'Kopieren in Ordner',
  delete:        'In Papierkorb verschieben',
  hardDelete:    'Endgültig löschen',
  markRead:      'Als gelesen markieren',
  markFlagged:   'Kennzeichnen',
  pin:           'Anheften',
  categorize:    'Kategorie zuweisen',
  forward:       'Weiterleiten an',
  redirect:      'Umleiten an',
  markJunk:      'Als Junk markieren',
  setImportance: 'Wichtigkeit setzen',
};

// Fields grouped by value type (for operator/input selection)
const NUM_FIELDS:  RuleField[] = ['size'];
const BOOL_FIELDS: RuleField[] = ['hasAttachment', 'sentOnlyToMe'];
const ENUM_FIELDS: RuleField[] = ['importance'];

function defaultOperator(field: RuleField): RuleOperator {
  if (NUM_FIELDS.includes(field)) return 'greaterThan';
  if (BOOL_FIELDS.includes(field)) return 'is';
  if (ENUM_FIELDS.includes(field)) return 'equals';
  return 'contains';
}

function operatorsFor(field: RuleField): RuleOperator[] {
  if (NUM_FIELDS.includes(field))  return ['equals', 'notEquals', 'greaterThan', 'lessThan'];
  if (BOOL_FIELDS.includes(field)) return ['is'];
  if (ENUM_FIELDS.includes(field)) return ['equals', 'notEquals'];
  return ['contains', 'notContains', 'equals', 'notEquals', 'startsWith', 'endsWith', 'regex'];
}

// ── Condition-Row ─────────────────────────────────────────────────────────────
function ConditionRow({ value, onChange, onRemove }: {
  value: RuleCondition;
  onChange: (next: RuleCondition) => void;
  onRemove: () => void;
}) {
  const ops = operatorsFor(value.field);

  return (
    <div className="flex items-center gap-2 mb-1.5">
      <select
        value={value.field}
        onChange={(e) => {
          const newField = e.target.value as RuleField;
          onChange({ field: newField, operator: defaultOperator(newField), value: BOOL_FIELDS.includes(newField) ? true : '' });
        }}
        className="text-sm border border-line-strong rounded px-2 py-1.5 min-w-[140px]"
      >
        {Object.entries(FIELD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>

      <select
        value={value.operator}
        onChange={(e) => onChange({ ...value, operator: e.target.value as RuleOperator })}
        className="text-sm border border-line-strong rounded px-2 py-1.5 min-w-[120px]"
      >
        {ops.map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
      </select>

      {BOOL_FIELDS.includes(value.field) ? (
        <select
          value={String(value.value)}
          onChange={(e) => onChange({ ...value, value: e.target.value === 'true' })}
          className="text-sm border border-line-strong rounded px-2 py-1.5"
        >
          <option value="true">ja</option>
          <option value="false">nein</option>
        </select>
      ) : ENUM_FIELDS.includes(value.field) ? (
        <select
          value={String(value.value)}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
          className="text-sm border border-line-strong rounded px-2 py-1.5"
        >
          <option value="high">Hoch</option>
          <option value="normal">Normal</option>
          <option value="low">Niedrig</option>
        </select>
      ) : (
        <input
          type={NUM_FIELDS.includes(value.field) ? 'number' : 'text'}
          value={String(value.value)}
          onChange={(e) => onChange({ ...value, value: NUM_FIELDS.includes(value.field) ? Number(e.target.value) : e.target.value })}
          className="flex-1 text-sm border border-line-strong rounded px-2 py-1.5"
          placeholder={NUM_FIELDS.includes(value.field) ? 'Bytes' : 'Wert eingeben…'}
        />
      )}

      <button aria-label="Bedingung entfernen"
        onClick={onRemove}
        className="p-1.5 text-fg-subtle hover:text-danger-fg hover:bg-danger-bg rounded"
        title="Bedingung entfernen"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

// ── Action-Row ────────────────────────────────────────────────────────────────
function ActionRow({ value, onChange, onRemove, folders, categories }: {
  value: RuleAction;
  onChange: (next: RuleAction) => void;
  onRemove: () => void;
  folders: Folder[];
  categories: Category[];
}) {
  const changeType = (type: RuleAction['type']) => {
    switch (type) {
      case 'moveTo':
      case 'copyTo':       onChange({ type, folderId: folders[0]?.id ?? '' });   break;
      case 'categorize':   onChange({ type, categoryId: categories[0]?.id ?? '' }); break;
      case 'forward':
      case 'redirect':     onChange({ type, address: '' });                       break;
      case 'setImportance': onChange({ type, value: 'high' });                    break;
      default:             onChange({ type } as RuleAction);
    }
  };

  return (
    <div className="flex items-center gap-2 mb-1.5">
      <select
        value={value.type}
        onChange={(e) => changeType(e.target.value as RuleAction['type'])}
        className="text-sm border border-line-strong rounded px-2 py-1.5 min-w-[200px]"
      >
        {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>

      {(value.type === 'moveTo' || value.type === 'copyTo') && (
        <select
          value={value.folderId}
          onChange={(e) => onChange({ ...value, folderId: e.target.value })}
          className="flex-1 text-sm border border-line-strong rounded px-2 py-1.5"
        >
          <option value="">— Ordner wählen —</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.displayName ?? f.name}</option>)}
        </select>
      )}

      {value.type === 'categorize' && (
        <select
          value={value.categoryId}
          onChange={(e) => onChange({ ...value, categoryId: e.target.value })}
          className="flex-1 text-sm border border-line-strong rounded px-2 py-1.5"
        >
          <option value="">— Kategorie wählen —</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}

      {(value.type === 'forward' || value.type === 'redirect') && (
        <input
          type="email"
          value={value.address}
          onChange={(e) => onChange({ ...value, address: e.target.value })}
          placeholder="empfänger@beispiel.de"
          className="flex-1 text-sm border border-line-strong rounded px-2 py-1.5"
        />
      )}

      {value.type === 'setImportance' && (
        <select
          value={value.value}
          onChange={(e) => onChange({ ...value, value: e.target.value as 'high' | 'normal' | 'low' })}
          className="flex-1 text-sm border border-line-strong rounded px-2 py-1.5"
        >
          <option value="high">Hoch</option>
          <option value="normal">Normal</option>
          <option value="low">Niedrig</option>
        </select>
      )}

      <button aria-label="Aktion entfernen"
        onClick={onRemove}
        className="p-1.5 text-fg-subtle hover:text-danger-fg hover:bg-danger-bg rounded"
        title="Aktion entfernen"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

// ── Editor-Modal ──────────────────────────────────────────────────────────────
export function RuleEditorModal({ rule, preset, onClose, onSaved }: Props) {
  const isNew = rule === null;

  const [name, setName] = useState(rule?.name ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [matchAll, setMatchAll] = useState(rule?.matchAll ?? true);
  const [stopProcessing, setStopProcessing] = useState(rule?.stopProcessing ?? false);
  const [conditions, setConditions] = useState<RuleCondition[]>(rule?.conditions ?? []);
  const [exceptions, setExceptions] = useState<RuleCondition[]>(rule?.exceptions ?? []);
  const [actions, setActions] = useState<RuleAction[]>(rule?.actions ?? []);
  const [showExceptions, setShowExceptions] = useState((rule?.exceptions?.length ?? 0) > 0);

  // Preset for "create from mail": From address as condition
  useEffect(() => {
    if (isNew && preset && conditions.length === 0) {
      const init: RuleCondition[] = [];
      if (preset.fromAddr) init.push({ field: 'from', operator: 'contains', value: preset.fromAddr });
      if (init.length > 0) {
        setConditions(init);
        setName(`Regel für ${preset.fromAddr ?? preset.subject ?? ''}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: folders = [] } = useQuery<Folder[]>({
    queryKey: ['folders'],
    queryFn: () => api.get<Folder[]>('/mail/folders'),
  });
  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
  });

  // Server-side validation message (e.g. a refused regex pattern) shown inline
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      setSaveError(null);
      const body = { name, enabled, matchAll, stopProcessing, conditions, exceptions, actions, priority: rule?.priority ?? 0 };
      if (isNew) return api.post<MailRule>('/user/rules', body);
      return api.put<MailRule>(`/user/rules/${rule.id}`, body);
    },
    onSuccess: () => { toast.success(isNew ? 'Regel erstellt' : 'Regel aktualisiert'); onSaved(); },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Speichern fehlgeschlagen';
      setSaveError(msg);
      toast.error(msg);
    },
  });

  const canSave = name.trim().length > 0 && actions.length > 0;

  return (
    <Modal
      onClose={onClose}
      label="Regel bearbeiten"
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-4"
      className="bg-surface rounded-lg shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <h2 className="text-lg font-semibold text-fg">
            {isNew ? 'Neue Regel' : 'Regel bearbeiten'}
          </h2>
          <button aria-label="Schließen" onClick={onClose} className="btn-ghost p-1.5"><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-fg-muted mb-1.5">
              Name der Regel
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="z.B. Newsletter in Archiv verschieben"
              className="w-full text-sm border border-line-strong rounded px-3 py-2"
              autoFocus
            />
          </div>

          {/* Conditions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-fg-muted">
                <span className="inline-block w-6 h-6 rounded-full bg-accent text-white text-xs font-bold leading-6 text-center mr-2">1</span>
                Wenn die Nachricht eintrifft und …
              </h3>
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                <span>Verknüpfung:</span>
                <select
                  value={matchAll ? 'all' : 'any'}
                  onChange={(e) => setMatchAll(e.target.value === 'all')}
                  className="border border-line-strong rounded px-2 py-1 text-xs"
                >
                  <option value="all">UND (alle Bedingungen)</option>
                  <option value="any">ODER (irgendeine)</option>
                </select>
              </label>
            </div>
            {conditions.length === 0 && (
              <p className="text-xs text-fg-subtle italic mb-2">Keine Bedingungen — die Regel greift bei JEDER eingehenden Nachricht.</p>
            )}
            {conditions.map((c, i) => (
              <ConditionRow
                key={i}
                value={c}
                onChange={(next) => setConditions(conditions.map((x, j) => j === i ? next : x))}
                onRemove={() => setConditions(conditions.filter((_, j) => j !== i))}
              />
            ))}
            <button
              onClick={() => setConditions([...conditions, { field: 'from', operator: 'contains', value: '' }])}
              className="text-xs text-accent-fg hover:underline flex items-center gap-1 mt-1"
            >
              <Plus size={12} /> Bedingung hinzufügen
            </button>
          </div>

          {/* Actions */}
          <div>
            <h3 className="text-sm font-semibold text-fg-muted mb-2">
              <span className="inline-block w-6 h-6 rounded-full bg-accent text-white text-xs font-bold leading-6 text-center mr-2">2</span>
              Folgendes tun:
            </h3>
            {actions.length === 0 && (
              <p className="text-xs text-danger-fg italic mb-2 flex items-center gap-1">
                <Info size={12} /> Mindestens eine Aktion erforderlich.
              </p>
            )}
            {actions.map((a, i) => (
              <ActionRow
                key={i}
                value={a}
                onChange={(next) => setActions(actions.map((x, j) => j === i ? next : x))}
                onRemove={() => setActions(actions.filter((_, j) => j !== i))}
                folders={folders}
                categories={categories}
              />
            ))}
            <button
              onClick={() => setActions([...actions, { type: 'moveTo', folderId: folders[0]?.id ?? '' }])}
              className="text-xs text-accent-fg hover:underline flex items-center gap-1 mt-1"
            >
              <Plus size={12} /> Aktion hinzufügen
            </button>
          </div>

          {/* Exceptions (collapsible) */}
          <div>
            <button
              onClick={() => setShowExceptions((s) => !s)}
              className="flex items-center gap-1.5 text-sm font-semibold text-fg-muted hover:text-accent-fg"
            >
              {showExceptions ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              <span className="inline-block w-6 h-6 rounded-full bg-surface-3 text-fg-muted text-xs font-bold leading-6 text-center">3</span>
              Außer wenn … (Ausnahmen, optional)
            </button>
            {showExceptions && (
              <div className="mt-2 ml-6">
                {exceptions.length === 0 && (
                  <p className="text-xs text-fg-subtle italic mb-2">Keine Ausnahmen.</p>
                )}
                {exceptions.map((e, i) => (
                  <ConditionRow
                    key={i}
                    value={e}
                    onChange={(next) => setExceptions(exceptions.map((x, j) => j === i ? next : x))}
                    onRemove={() => setExceptions(exceptions.filter((_, j) => j !== i))}
                  />
                ))}
                <button
                  onClick={() => setExceptions([...exceptions, { field: 'from', operator: 'contains', value: '' }])}
                  className="text-xs text-accent-fg hover:underline flex items-center gap-1 mt-1"
                >
                  <Plus size={12} /> Ausnahme hinzufügen
                </button>
              </div>
            )}
          </div>

          {/* Footer options */}
          <div className="space-y-2 pt-3 border-t border-line">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={stopProcessing}
                onChange={(e) => setStopProcessing(e.target.checked)}
                className="rounded border-line-strong text-accent-fg focus:ring-accent-fg"
              />
              <span className="text-fg-muted">Verarbeitung weiterer Regeln beenden</span>
              <span className="text-xs text-fg-subtle">(Stop-Processing)</span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="rounded border-line-strong text-accent-fg focus:ring-accent-fg"
              />
              <span className="text-fg-muted">Regel ist aktiviert</span>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line shrink-0">
          {saveError && (
            <p role="alert" className="mr-auto text-xs text-danger-fg flex items-center gap-1 break-all">
              <Info size={12} className="shrink-0" /> {saveError}
            </p>
          )}
          <button onClick={onClose} className="btn-secondary text-sm">Abbrechen</button>
          <button
            onClick={() => save.mutate()}
            disabled={!canSave || save.isPending}
            className="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save size={14} /> {save.isPending ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
    </Modal>
  );
}
