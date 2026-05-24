import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Plus, Pencil, Trash2, GripVertical, Play, CheckCircle2,
  ListFilter, AlertCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { RuleEditorModal } from './RuleEditorModal.js';
import type { MailRule, RuleAction, RuleCondition } from '../api/rule-types.js';

function summarizeConditions(rule: MailRule): string {
  if (rule.conditions.length === 0) return 'Alle Nachrichten';
  const parts = rule.conditions.slice(0, 2).map((c) => {
    switch (c.field) {
      case 'from':     return `Von „${String(c.value)}"`;
      case 'to':       return `An „${String(c.value)}"`;
      case 'subject':  return `Betreff enthält „${String(c.value)}"`;
      case 'body':     return `Body enthält „${String(c.value)}"`;
      case 'hasAttachment': return 'Hat Anhang';
      case 'size':     return `Größe ${c.operator} ${String(c.value)}`;
      case 'sentOnlyToMe': return 'Nur an mich';
      default:         return `${c.field} ${c.operator}`;
    }
  });
  const more = rule.conditions.length - 2 > 0 ? ` +${rule.conditions.length - 2}` : '';
  return parts.join(rule.matchAll ? ' UND ' : ' ODER ') + more;
}

function summarizeActions(actions: RuleAction[]): string {
  return actions.slice(0, 2).map((a) => {
    switch (a.type) {
      case 'moveTo':       return 'Verschieben →';
      case 'copyTo':       return 'Kopieren →';
      case 'delete':       return 'In Papierkorb';
      case 'hardDelete':   return 'Endgültig löschen';
      case 'markRead':     return 'Als gelesen';
      case 'markFlagged':  return 'Kennzeichnen';
      case 'pin':          return 'Anheften';
      case 'categorize':   return 'Kategorisieren';
      case 'forward':      return `Weiterleiten an ${a.address}`;
      case 'redirect':     return `Umleiten an ${a.address}`;
      case 'markJunk':     return 'Als Junk';
      case 'setImportance':return `Wichtigkeit: ${a.value}`;
    }
  }).join(', ') + (actions.length > 2 ? ` +${actions.length - 2}` : '');
}

function SortableRuleRow({ rule, onEdit, onRunNow }: {
  rule: MailRule;
  onEdit: (r: MailRule) => void;
  onRunNow: (r: MailRule) => void;
}) {
  const qc = useQueryClient();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: rule.id });

  const toggle = useMutation({
    mutationFn: () => api.patch<MailRule>(`/user/rules/${rule.id}/toggle`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/user/rules/${rule.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rules'] }); toast.success('Regel gelöscht'); },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 px-3 py-2.5 border-b border-gray-100 dark:border-gray-700 group ${
        rule.enabled ? '' : 'opacity-60'
      } hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors`}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500"
        title="Reihenfolge ändern"
      >
        <GripVertical size={16} />
      </button>

      <button
        onClick={() => toggle.mutate()}
        className={`shrink-0 w-9 h-5 rounded-full transition-colors ${
          rule.enabled ? 'bg-accent' : 'bg-gray-300 dark:bg-gray-600'
        }`}
        title={rule.enabled ? 'Deaktivieren' : 'Aktivieren'}
      >
        <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${
          rule.enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`} />
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">{rule.name}</p>
          {rule.stopProcessing && (
            <span title="Stop processing" className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">STOP</span>
          )}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
          <span className="text-gray-400">Wenn:</span> {summarizeConditions(rule)}
          <span className="mx-1.5 text-gray-300">→</span>
          <span className="text-gray-400">Dann:</span> {summarizeActions(rule.actions)}
        </p>
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={() => onRunNow(rule)} className="btn-ghost p-1.5" title="Jetzt auf Posteingang anwenden">
          <Play size={13} />
        </button>
        <button onClick={() => onEdit(rule)} className="btn-ghost p-1.5" title="Bearbeiten">
          <Pencil size={13} />
        </button>
        <button
          onClick={() => { if (confirm(`Regel „${rule.name}" wirklich löschen?`)) remove.mutate(); }}
          className="btn-ghost p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
          title="Löschen"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

export function RulesSection() {
  const qc = useQueryClient();
  const [editor, setEditor] = useState<{ open: boolean; rule: MailRule | null }>({ open: false, rule: null });

  const { data: rules = [], isLoading } = useQuery<MailRule[]>({
    queryKey: ['rules'],
    queryFn: () => api.get<MailRule[]>('/user/rules'),
  });

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.post('/user/rules/reorder', { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => api.post<{ scanned: number; matched: number; moved: number; flagged: number }>(`/user/rules/${id}/run-now`, {}),
    onSuccess: (r) => toast.success(`Regel ausgeführt — ${r.matched} von ${r.scanned} Nachrichten getroffen, ${r.moved} verschoben`),
    onError: () => toast.error('Regel-Ausführung fehlgeschlagen'),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const sortedIds = useMemo(() => rules.map((r) => r.id), [rules]);

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = sortedIds.indexOf(active.id as string);
    const newIdx = sortedIds.indexOf(over.id as string);
    const newOrder = arrayMove(sortedIds, oldIdx, newIdx);
    qc.setQueryData<MailRule[]>(['rules'], (old) => {
      if (!old) return old;
      const map = new Map(old.map((r) => [r.id, r]));
      return newOrder.map((id) => map.get(id)!).filter(Boolean);
    });
    reorder.mutate(newOrder);
  };

  return (
    <section className="p-6 max-w-4xl">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <ListFilter size={20} /> Regeln
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Posteingangs-Regeln werden serverseitig auf eingehende Nachrichten angewendet.
            Reihenfolge bestimmt Priorität — die erste passende Regel gewinnt.
          </p>
        </div>
        <button
          onClick={() => setEditor({ open: true, rule: null })}
          className="btn-primary text-sm"
        >
          <Plus size={14} /> Neue Regel
        </button>
      </div>

      {isLoading ? (
        <p className="text-gray-400 text-sm mt-8">Lade Regeln…</p>
      ) : rules.length === 0 ? (
        <div className="mt-12 text-center py-12 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg">
          <ListFilter size={32} className="mx-auto text-gray-300 dark:text-gray-600 mb-3" />
          <p className="text-gray-600 dark:text-gray-300 font-medium">Noch keine Regeln</p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-1 mb-4">
            Erstellen Sie eine Regel, um eingehende Nachrichten automatisch zu organisieren.
          </p>
          <button
            onClick={() => setEditor({ open: true, rule: null })}
            className="btn-primary text-sm"
          >
            <Plus size={14} /> Erste Regel erstellen
          </button>
        </div>
      ) : (
        <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-900">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sortedIds} strategy={verticalListSortingStrategy}>
              {rules.map((rule) => (
                <SortableRuleRow
                  key={rule.id}
                  rule={rule}
                  onEdit={(r) => setEditor({ open: true, rule: r })}
                  onRunNow={(r) => runNow.mutate(r.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}

      <div className="mt-6 px-4 py-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg flex gap-2.5 text-sm">
        <AlertCircle size={16} className="text-blue-600 dark:text-blue-300 shrink-0 mt-0.5" />
        <p className="text-blue-900 dark:text-blue-200 leading-relaxed">
          <strong>Stop-Processing:</strong> Aktiviere die Option <CheckCircle2 size={12} className="inline" /> „Verarbeitung weiterer Regeln beenden" um zu verhindern, dass nachfolgende Regeln dieselbe Nachricht erneut bearbeiten — wie in Outlook.
        </p>
      </div>

      {editor.open && (
        <RuleEditorModal
          rule={editor.rule}
          onClose={() => setEditor({ open: false, rule: null })}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['rules'] });
            setEditor({ open: false, rule: null });
          }}
        />
      )}
    </section>
  );
}

// Type re-exports for parent imports
export type { MailRule, RuleAction, RuleCondition };
