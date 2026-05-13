import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle2, Circle, Flag, Calendar, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
const PRIORITY_COLOR = {
    LOW: 'text-gray-400',
    NORMAL: 'text-blue-500',
    HIGH: 'text-red-500',
};
export function TasksPage() {
    const qc = useQueryClient();
    const [newTitle, setNewTitle] = useState('');
    const [filter, setFilter] = useState('pending');
    const statusFilter = filter === 'pending'
        ? ['NOT_STARTED', 'IN_PROGRESS', 'DEFERRED']
        : filter === 'completed' ? ['COMPLETED'] : undefined;
    const { data: tasks } = useQuery({
        queryKey: ['tasks', filter],
        queryFn: () => api.get('/tasks'),
        select: (all) => statusFilter ? all.filter((t) => statusFilter.includes(t.status)) : all,
    });
    const createMutation = useMutation({
        mutationFn: (title) => api.post('/tasks', { title }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['tasks'] });
            setNewTitle('');
        },
        onError: (err) => toast.error(err.message),
    });
    const toggleMutation = useMutation({
        mutationFn: ({ id, completed }) => api.put(`/tasks/${id}`, { status: completed ? 'COMPLETED' : 'NOT_STARTED' }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
    });
    const deleteMutation = useMutation({
        mutationFn: (id) => api.delete(`/tasks/${id}`),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
    });
    const handleAddTask = (e) => {
        e.preventDefault();
        if (newTitle.trim())
            createMutation.mutate(newTitle.trim());
    };
    return (_jsx("div", { className: "flex flex-1 overflow-hidden bg-gray-50", children: _jsxs("div", { className: "w-full max-w-2xl mx-auto p-6 flex flex-col gap-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Aufgaben" }), _jsx("div", { className: "flex gap-1 bg-white border border-gray-200 rounded p-0.5", children: ['pending', 'all', 'completed'].map((f) => (_jsx("button", { onClick: () => setFilter(f), className: `text-xs px-3 py-1 rounded transition-colors ${filter === f ? 'bg-accent text-white' : 'text-gray-600 hover:bg-gray-100'}`, children: f === 'pending' ? 'Offen' : f === 'all' ? 'Alle' : 'Erledigt' }, f))) })] }), _jsxs("form", { onSubmit: handleAddTask, className: "flex gap-2", children: [_jsx("input", { value: newTitle, onChange: (e) => setNewTitle(e.target.value), className: "input flex-1", placeholder: "Neue Aufgabe hinzuf\u00FCgen..." }), _jsx("button", { type: "submit", disabled: !newTitle.trim() || createMutation.isPending, className: "btn-primary disabled:opacity-50", children: _jsx(Plus, { size: 15 }) })] }), _jsxs("div", { className: "bg-white rounded-lg border border-gray-200 divide-y divide-gray-100", children: [(tasks ?? []).length === 0 && (_jsx("div", { className: "py-10 text-center text-gray-400 text-sm", children: "Keine Aufgaben" })), (tasks ?? []).map((task) => {
                            const done = task.status === 'COMPLETED';
                            return (_jsxs("div", { className: "flex items-center gap-3 px-4 py-3 group hover:bg-gray-50 transition-colors", children: [_jsx("button", { onClick: () => toggleMutation.mutate({ id: task.id, completed: !done }), className: "shrink-0 transition-colors", children: done
                                            ? _jsx(CheckCircle2, { size: 18, className: "text-green-500" })
                                            : _jsx(Circle, { size: 18, className: "text-gray-300 hover:text-accent" }) }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("p", { className: `text-sm ${done ? 'line-through text-gray-400' : 'text-gray-800'}`, children: task.title }), task.notes && _jsx("p", { className: "text-xs text-gray-400 truncate", children: task.notes })] }), _jsxs("div", { className: "flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity", children: [_jsx(Flag, { size: 14, className: PRIORITY_COLOR[task.priority] }), task.dueDate && (_jsxs("span", { className: "text-xs text-gray-400 flex items-center gap-1", children: [_jsx(Calendar, { size: 12 }), format(new Date(task.dueDate), 'dd.MM.')] })), _jsx("button", { onClick: () => deleteMutation.mutate(task.id), className: "text-gray-300 hover:text-red-500 transition-colors", children: _jsx(Trash2, { size: 14 }) })] })] }, task.id));
                        })] })] }) }));
}
