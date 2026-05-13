import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Trash2, AlertCircle } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
export function QueuesPage() {
    const qc = useQueryClient();
    const { data: queues, refetch } = useQuery({
        queryKey: ['admin-queues'],
        queryFn: () => api.get('/admin/queues'),
        refetchInterval: 5_000,
    });
    const flushMutation = useMutation({
        mutationFn: (name) => api.post(`/admin/queues/${name}/flush`),
        onSuccess: () => { toast.success('Queue geleert'); qc.invalidateQueries({ queryKey: ['admin-queues'] }); },
        onError: (err) => toast.error(err.message),
    });
    const queueColor = (q) => {
        if (q.name.includes('dead') && q.count > 0)
            return 'badge-red';
        if (q.count > 100)
            return 'badge-yellow';
        return 'badge-green';
    };
    return (_jsxs("div", { className: "p-6 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "SMTP-Warteschlangen" }), _jsxs("button", { onClick: () => refetch(), className: "btn-secondary text-xs", children: [_jsx(RefreshCw, { size: 13 }), " Aktualisieren"] })] }), _jsx("div", { className: "grid grid-cols-2 gap-4", children: (queues ?? []).map((q) => (_jsxs("div", { className: "card flex items-center justify-between gap-4", children: [_jsxs("div", { children: [_jsx("p", { className: "font-mono text-sm text-gray-700", children: q.name }), _jsx("p", { className: "text-2xl font-bold text-gray-900 mt-1", children: q.count }), _jsx("span", { className: `badge mt-1 ${queueColor(q)}`, children: q.name.includes('dead') && q.count > 0 ? 'Fehler' : q.count > 100 ? 'Hoch' : 'Normal' })] }), _jsx("div", { className: "flex flex-col gap-1", children: q.name.includes('dead') && (_jsxs("button", { onClick: () => { if (confirm(`Queue "${q.name}" leeren?`))
                                    flushMutation.mutate(q.name); }, className: "btn-danger text-xs", children: [_jsx(Trash2, { size: 13 }), " Leeren"] })) })] }, q.name))) }), queues?.some((q) => q.name.includes('dead') && q.count > 0) && (_jsxs("div", { className: "flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700", children: [_jsx(AlertCircle, { size: 16, className: "shrink-0 mt-0.5" }), _jsxs("div", { children: [_jsx("p", { className: "font-medium", children: "Dead-Letter-Queue nicht leer" }), _jsx("p", { className: "text-xs mt-0.5 text-red-600", children: "Nachrichten konnten nicht zugestellt werden. Bitte pr\u00FCfen Sie die Protokolle." })] })] }))] }));
}
