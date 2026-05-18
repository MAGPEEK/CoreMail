import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Workflow, Plus, Trash2, Pencil, X, Loader2, GripVertical, ToggleLeft, ToggleRight } from 'lucide-react';
import { api } from '../api/client.js';
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
    const [editItem, setEditItem] = useState(null);
    const [createOpen, setCreateOpen] = useState(false);
    const { data: rules = [], isLoading } = useQuery({
        queryKey: ['admin-transport-rules'],
        queryFn: () => api.get('/api/v1/admin/transport-rules'),
    });
    const toggleMutation = useMutation({
        mutationFn: (id) => api.patch(`/api/v1/admin/transport-rules/${id}/toggle`, {}),
        onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-transport-rules'] }),
        onError: () => toast.error('Fehler'),
    });
    const deleteMutation = useMutation({
        mutationFn: (id) => api.delete(`/api/v1/admin/transport-rules/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-transport-rules'] }); toast.success('Gelöscht'); },
        onError: () => toast.error('Löschen fehlgeschlagen'),
    });
    return (_jsxs("div", { className: "p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Workflow, { size: 22, className: "text-blue-600" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-bold text-gray-900", children: "Transportregeln" }), _jsxs("p", { className: "text-sm text-gray-500", children: [rules.length, " Regel", rules.length !== 1 ? 'n' : ''] })] })] }), _jsxs("button", { onClick: () => setCreateOpen(true), className: "flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors", children: [_jsx(Plus, { size: 14 }), " Neue Regel"] })] }), _jsx("div", { className: "bg-white rounded-xl border border-gray-200 overflow-hidden", children: isLoading ? (_jsxs("div", { className: "flex items-center justify-center py-12 text-gray-400", children: [_jsx(Loader2, { size: 20, className: "animate-spin mr-2" }), " Lade\u2026"] })) : rules.length === 0 ? (_jsxs("div", { className: "text-center py-12 text-gray-400 text-sm", children: [_jsx(Workflow, { size: 28, className: "mx-auto mb-2 opacity-30" }), "Keine Transportregeln. Erstelle deine erste Regel."] })) : (_jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "w-8 px-4 py-3" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Priorit\u00E4t" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Name / Beschreibung" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Bedingungen" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Aktionen" }), _jsx("th", { className: "text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Status / Aktionen" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: rules.map(rule => (_jsxs("tr", { className: `hover:bg-gray-50 transition-colors ${!rule.enabled ? 'opacity-60' : ''}`, children: [_jsx("td", { className: "px-4 py-3 text-gray-300", children: _jsx(GripVertical, { size: 14 }) }), _jsx("td", { className: "px-4 py-3", children: _jsx("span", { className: "text-sm font-mono text-gray-500", children: rule.priority }) }), _jsxs("td", { className: "px-4 py-3", children: [_jsx("p", { className: "font-medium text-gray-900 text-sm", children: rule.name }), rule.description && _jsx("p", { className: "text-xs text-gray-400", children: rule.description })] }), _jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "space-y-0.5", children: [rule.conditions.slice(0, 2).map((c, i) => (_jsxs("p", { className: "text-xs text-gray-600", children: [_jsx("span", { className: "font-medium", children: CONDITION_FIELDS.find(f => f.value === c.field)?.label ?? c.field }), ' ', CONDITION_OPS.find(o => o.value === c.op)?.label ?? c.op, ' ', _jsx("span", { className: "font-mono bg-gray-100 px-1 rounded", children: c.value })] }, i))), rule.conditions.length > 2 && _jsxs("p", { className: "text-xs text-gray-400", children: ["+", rule.conditions.length - 2, " weitere"] })] }) }), _jsx("td", { className: "px-4 py-3", children: _jsx("div", { className: "space-y-0.5", children: rule.actions.slice(0, 2).map((a, i) => (_jsxs("p", { className: "text-xs text-gray-600", children: [_jsx("span", { className: "font-medium", children: ACTION_TYPES.find(t => t.value === a.type)?.label ?? a.type }), a.value && _jsx("span", { className: "font-mono bg-gray-100 px-1 rounded ml-1", children: a.value.slice(0, 30) })] }, i))) }) }), _jsx("td", { className: "px-4 py-3 text-right", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx("button", { onClick: () => toggleMutation.mutate(rule.id), title: rule.enabled ? 'Deaktivieren' : 'Aktivieren', className: `p-1.5 rounded transition-colors ${rule.enabled ? 'text-green-500 hover:text-green-700 hover:bg-green-50' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`, children: rule.enabled ? _jsx(ToggleRight, { size: 16 }) : _jsx(ToggleLeft, { size: 16 }) }), _jsx("button", { onClick: () => setEditItem(rule), title: "Bearbeiten", className: "p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors", children: _jsx(Pencil, { size: 14 }) }), _jsx("button", { onClick: () => { if (window.confirm(`Regel "${rule.name}" löschen?`))
                                                        deleteMutation.mutate(rule.id); }, title: "L\u00F6schen", className: "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors", children: _jsx(Trash2, { size: 14 }) })] }) })] }, rule.id))) })] })) }), createOpen && _jsx(RuleModal, { onClose: () => setCreateOpen(false) }), editItem && _jsx(RuleModal, { rule: editItem, onClose: () => setEditItem(null) })] }));
}
// ── Rule Modal ────────────────────────────────────────────────────────────────
function RuleModal({ rule, onClose }) {
    const qc = useQueryClient();
    const [name, setName] = useState(rule?.name ?? '');
    const [description, setDesc] = useState(rule?.description ?? '');
    const [priority, setPriority] = useState(rule?.priority ?? 0);
    const [enabled, setEnabled] = useState(rule?.enabled ?? true);
    const [conditions, setConds] = useState(rule?.conditions ?? [{ field: 'from', op: 'contains', value: '' }]);
    const [actions, setActions] = useState(rule?.actions ?? [{ type: 'addHeader', value: '' }]);
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
    function updateCond(i, field) { setConds(cs => cs.map((c, j) => j === i ? { ...c, ...field } : c)); }
    function updateAction(i, field) { setActions(as => as.map((a, j) => j === i ? { ...a, ...field } : a)); }
    return (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4", children: _jsxs("div", { className: "bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto", children: [_jsxs("div", { className: "flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white", children: [_jsx("h2", { className: "font-semibold text-gray-900", children: rule ? 'Regel bearbeiten' : 'Neue Transportregel' }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600", children: _jsx(X, { size: 18 }) })] }), _jsxs("div", { className: "p-5 space-y-5", children: [_jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { className: "col-span-2", children: [_jsx("label", { className: "field-label", children: "Name" }), _jsx("input", { value: name, onChange: e => setName(e.target.value), className: "input", placeholder: "z.B. Spam-Disclaimer anf\u00FCgen" })] }), _jsxs("div", { className: "col-span-2", children: [_jsx("label", { className: "field-label", children: "Beschreibung (optional)" }), _jsx("input", { value: description, onChange: e => setDesc(e.target.value), className: "input" })] }), _jsxs("div", { children: [_jsx("label", { className: "field-label", children: "Priorit\u00E4t (niedriger = zuerst)" }), _jsx("input", { type: "number", value: priority, onChange: e => setPriority(Number(e.target.value)), className: "input", min: 0, max: 9999 })] }), _jsx("div", { className: "flex items-end", children: _jsxs("label", { className: "flex items-center gap-2 text-sm cursor-pointer select-none", children: [_jsx("input", { type: "checkbox", checked: enabled, onChange: e => setEnabled(e.target.checked), className: "rounded" }), "Aktiv"] }) })] }), _jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase", children: "Bedingungen (alle m\u00FCssen zutreffen)" }), _jsx("button", { onClick: () => setConds(cs => [...cs, { field: 'from', op: 'contains', value: '' }]), className: "text-xs text-blue-600 hover:text-blue-800", children: "+ Bedingung" })] }), conditions.map((c, i) => (_jsxs("div", { className: "flex gap-2 mb-2 items-center", children: [_jsx("select", { value: c.field, onChange: e => updateCond(i, { field: e.target.value }), className: "input w-36", children: CONDITION_FIELDS.map(f => _jsx("option", { value: f.value, children: f.label }, f.value)) }), _jsx("select", { value: c.op, onChange: e => updateCond(i, { op: e.target.value }), className: "input w-32", children: CONDITION_OPS.map(o => _jsx("option", { value: o.value, children: o.label }, o.value)) }), _jsx("input", { value: c.value, onChange: e => updateCond(i, { value: e.target.value }), className: "input flex-1", placeholder: "Wert" }), _jsx("button", { onClick: () => setConds(cs => cs.filter((_, j) => j !== i)), className: "p-1.5 text-gray-400 hover:text-red-500", children: _jsx(X, { size: 14 }) })] }, i)))] }), _jsxs("div", { children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase", children: "Aktionen" }), _jsx("button", { onClick: () => setActions(as => [...as, { type: 'addHeader', value: '' }]), className: "text-xs text-blue-600 hover:text-blue-800", children: "+ Aktion" })] }), actions.map((a, i) => (_jsxs("div", { className: "flex gap-2 mb-2 items-center", children: [_jsx("select", { value: a.type, onChange: e => updateAction(i, { type: e.target.value }), className: "input w-48", children: ACTION_TYPES.map(t => _jsx("option", { value: t.value, children: t.label }, t.value)) }), _jsx("input", { value: a.value, onChange: e => updateAction(i, { value: e.target.value }), className: "input flex-1", placeholder: "Wert (optional)" }), _jsx("button", { onClick: () => setActions(as => as.filter((_, j) => j !== i)), className: "p-1.5 text-gray-400 hover:text-red-500", children: _jsx(X, { size: 14 }) })] }, i)))] }), _jsxs("div", { className: "flex justify-end gap-2 pt-2", children: [_jsx("button", { onClick: onClose, className: "btn-secondary", children: "Abbrechen" }), _jsxs("button", { onClick: () => mutation.mutate(), disabled: mutation.isPending || !name || conditions.length === 0 || actions.length === 0, className: "btn-primary flex items-center gap-1.5", children: [mutation.isPending && _jsx(Loader2, { size: 14, className: "animate-spin" }), rule ? 'Speichern' : 'Erstellen'] })] })] })] }) }));
}
