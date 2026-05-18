import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X, Search } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
// ─── Color config ─────────────────────────────────────────────────────────────
const COLOR_BG = {
    YELLOW: 'bg-yellow-100 border-yellow-200',
    BLUE: 'bg-blue-100 border-blue-200',
    GREEN: 'bg-green-100 border-green-200',
    PINK: 'bg-pink-100 border-pink-200',
    PURPLE: 'bg-purple-100 border-purple-200',
};
const COLOR_HEADER = {
    YELLOW: 'bg-yellow-200',
    BLUE: 'bg-blue-200',
    GREEN: 'bg-green-200',
    PINK: 'bg-pink-200',
    PURPLE: 'bg-purple-200',
};
const COLOR_DOT = {
    YELLOW: 'bg-yellow-400',
    BLUE: 'bg-blue-400',
    GREEN: 'bg-green-500',
    PINK: 'bg-pink-400',
    PURPLE: 'bg-purple-500',
};
const COLORS = ['YELLOW', 'BLUE', 'GREEN', 'PINK', 'PURPLE'];
function fmtDate(iso) {
    return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
// ─── Note Editor Modal ────────────────────────────────────────────────────────
function NoteEditor({ noteId, onClose }) {
    const qc = useQueryClient();
    const isNew = noteId === null;
    const [form, setForm] = useState({
        subject: '',
        body: '',
        color: 'YELLOW',
    });
    // Load existing note
    const { data: noteData, isLoading } = useQuery({
        queryKey: ['note-detail', noteId],
        queryFn: () => api.get(`/notes/${noteId}`),
        enabled: !isNew,
    });
    useEffect(() => {
        if (noteData)
            setForm({ subject: noteData.subject, body: noteData.body, color: noteData.color });
    }, [noteData]);
    const save = useMutation({
        mutationFn: () => isNew
            ? api.post('/notes', form)
            : api.put(`/notes/${noteId}`, form),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['notes'] });
            if (!isNew)
                void qc.invalidateQueries({ queryKey: ['note-detail', noteId] });
            onClose();
        },
        onError: (e) => toast.error(e.message),
    });
    if (!isNew && isLoading) {
        return (_jsx("div", { className: "fixed inset-0 bg-black/40 z-50 flex items-center justify-center", children: _jsx("div", { className: "bg-white rounded-lg p-8 text-gray-400 text-sm", children: "Laden\u2026" }) }));
    }
    return (_jsx("div", { className: "fixed inset-0 bg-black/40 z-50 flex items-center justify-center", children: _jsxs("div", { className: `rounded-lg shadow-xl w-full max-w-lg border ${COLOR_BG[form.color]}`, children: [_jsxs("div", { className: `flex items-center justify-between px-4 py-2.5 rounded-t-lg ${COLOR_HEADER[form.color]}`, children: [_jsx("div", { className: "flex items-center gap-2", children: COLORS.map(c => (_jsx("button", { onClick: () => setForm(f => ({ ...f, color: c })), className: `w-4 h-4 rounded-full border-2 transition-all ${COLOR_DOT[c]} ${form.color === c ? 'border-gray-600 scale-125' : 'border-transparent hover:border-gray-400'}` }, c))) }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsx("button", { onClick: () => save.mutate(), disabled: save.isPending || !form.subject, className: "text-xs px-3 py-1 bg-white/60 hover:bg-white/80 rounded text-gray-700 font-medium disabled:opacity-50 transition-colors", children: save.isPending ? 'Speichern…' : 'Speichern' }), _jsx("button", { onClick: onClose, className: "ml-1 text-gray-500 hover:text-gray-700", children: _jsx(X, { size: 16 }) })] })] }), _jsxs("div", { className: "p-4 space-y-3", children: [_jsx("input", { value: form.subject, onChange: e => setForm(f => ({ ...f, subject: e.target.value })), className: "w-full bg-transparent border-b border-gray-300 pb-1 text-base font-semibold text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500", placeholder: "Betreff" }), _jsx("textarea", { value: form.body, onChange: e => setForm(f => ({ ...f, body: e.target.value })), rows: 10, className: "w-full bg-transparent text-sm text-gray-700 placeholder-gray-400 focus:outline-none resize-none", placeholder: "Notiz eingeben\u2026" })] })] }) }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function NotesPage() {
    const qc = useQueryClient();
    const [search, setSearch] = useState('');
    const [editId, setEditId] = useState(undefined); // undefined = closed, null = new, string = edit
    const { data: notes = [], isLoading } = useQuery({
        queryKey: ['notes', search],
        queryFn: () => api.get(`/notes${search ? `?q=${encodeURIComponent(search)}` : ''}`),
    });
    const del = useMutation({
        mutationFn: (id) => api.delete(`/notes/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['notes'] }); toast.success('Notiz gelöscht'); },
        onError: (e) => toast.error(e.message),
    });
    return (_jsxs("div", { className: "flex flex-1 flex-col overflow-hidden bg-gray-50", children: [_jsxs("div", { className: "bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3", children: [_jsx("h1", { className: "text-base font-semibold text-gray-900 mr-2", children: "Notizen" }), _jsxs("div", { className: "flex items-center gap-1.5 bg-gray-100 rounded px-2.5 py-1.5 flex-1 max-w-xs", children: [_jsx(Search, { size: 13, className: "text-gray-400 shrink-0" }), _jsx("input", { value: search, onChange: e => setSearch(e.target.value), className: "bg-transparent text-sm focus:outline-none text-gray-700 placeholder-gray-400 w-full", placeholder: "Notizen durchsuchen\u2026" })] }), _jsxs("button", { onClick: () => setEditId(null), className: "flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-accent rounded hover:bg-accent/90 ml-auto", children: [_jsx(Plus, { size: 14 }), " Neue Notiz"] })] }), _jsx("div", { className: "flex-1 overflow-y-auto p-6", children: isLoading ? (_jsx("div", { className: "text-center text-gray-400 py-16 text-sm", children: "Laden\u2026" })) : notes.length === 0 ? (_jsxs("div", { className: "text-center text-gray-400 py-16", children: [_jsx("p", { className: "text-sm", children: search ? 'Keine Notizen gefunden' : 'Noch keine Notizen vorhanden' }), !search && (_jsx("button", { onClick: () => setEditId(null), className: "mt-3 text-sm text-accent hover:underline", children: "Erste Notiz erstellen" }))] })) : (_jsx("div", { className: "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4", children: notes.map(note => (_jsxs("div", { className: `relative rounded-lg border cursor-pointer shadow-sm hover:shadow-md transition-shadow group ${COLOR_BG[note.color]}`, onClick: () => setEditId(note.id), children: [_jsxs("div", { className: `rounded-t-lg px-3 py-1.5 flex items-center justify-between ${COLOR_HEADER[note.color]}`, children: [_jsx("div", { className: `w-2.5 h-2.5 rounded-full ${COLOR_DOT[note.color]}` }), _jsx("button", { onClick: e => { e.stopPropagation(); del.mutate(note.id); }, className: "opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all", children: _jsx(Trash2, { size: 12 }) })] }), _jsxs("div", { className: "px-3 py-2.5 min-h-[100px]", children: [_jsx("p", { className: "text-sm font-medium text-gray-800 line-clamp-2 leading-snug", children: note.subject || '(Kein Betreff)' }), _jsx("p", { className: "text-xs text-gray-500 mt-2", children: fmtDate(note.updatedAt) })] })] }, note.id))) })) }), editId !== undefined && (_jsx(NoteEditor, { noteId: editId, onClose: () => setEditId(undefined) }))] }));
}
