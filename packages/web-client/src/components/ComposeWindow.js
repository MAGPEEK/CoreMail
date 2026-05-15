import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Minus, Maximize2, Send, Paperclip, Save } from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { api } from '../api/client.js';
import { useUiStore } from '../store/ui.js';
import toast from 'react-hot-toast';
export function ComposeWindow() {
    const qc = useQueryClient();
    const { closeCompose, composeReplyTo } = useUiStore();
    const [minimized, setMinimized] = useState(false);
    const [to, setTo] = useState(composeReplyTo?.fromAddr ?? '');
    const [cc, setCc] = useState('');
    const [subject, setSubject] = useState(composeReplyTo ? `Re: ${composeReplyTo.subject}` : '');
    const [inReplyTo] = useState(composeReplyTo?.id);
    const editor = useEditor({
        extensions: [StarterKit, Underline, Link.configure({ openOnClick: false })],
        content: '',
    });
    const sendMutation = useMutation({
        mutationFn: () => api.post('/mail/send', {
            to: to.split(',').map((s) => s.trim()).filter(Boolean),
            cc: cc.split(',').map((s) => s.trim()).filter(Boolean),
            subject,
            bodyHtml: editor?.getHTML() ?? '',
            bodyText: editor?.getText() ?? '',
            ...(inReplyTo && { inReplyTo }),
        }),
        onSuccess: () => {
            toast.success('Nachricht gesendet');
            qc.invalidateQueries({ queryKey: ['messages'] });
            closeCompose();
        },
        onError: (err) => toast.error(err.message),
    });
    if (minimized) {
        return (_jsx("div", { className: "fixed bottom-0 right-4 w-72 bg-gray-800 text-white rounded-t-lg shadow-xl z-50", children: _jsxs("div", { className: "flex items-center justify-between px-3 py-2", children: [_jsx("span", { className: "text-sm font-medium truncate", children: subject || 'Neue Nachricht' }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsx("button", { onClick: () => setMinimized(false), className: "p-0.5 hover:bg-white/20 rounded", children: _jsx(Maximize2, { size: 13 }) }), _jsx("button", { onClick: closeCompose, className: "p-0.5 hover:bg-white/20 rounded", children: _jsx(X, { size: 13 }) })] })] }) }));
    }
    return (_jsxs("div", { className: "fixed bottom-0 right-4 w-[580px] bg-white shadow-2xl border border-gray-300 rounded-t-lg z-50 flex flex-col", style: { maxHeight: '70vh' }, children: [_jsxs("div", { className: "flex items-center justify-between px-3 py-2 bg-gray-800 text-white rounded-t-lg cursor-default", children: [_jsx("span", { className: "text-sm font-medium", children: subject || 'Neue Nachricht' }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsx("button", { onClick: () => setMinimized(true), className: "p-0.5 hover:bg-white/20 rounded", children: _jsx(Minus, { size: 13 }) }), _jsx("button", { onClick: closeCompose, className: "p-0.5 hover:bg-white/20 rounded", children: _jsx(X, { size: 13 }) })] })] }), _jsxs("div", { className: "border-b border-gray-100", children: [_jsxs("div", { className: "flex items-center border-b border-gray-100 px-3 py-1.5 gap-2", children: [_jsx("span", { className: "text-xs text-gray-400 w-6 shrink-0", children: "An:" }), _jsx("input", { value: to, onChange: (e) => setTo(e.target.value), className: "flex-1 text-sm outline-none", placeholder: "Empf\u00E4nger..." })] }), _jsxs("div", { className: "flex items-center border-b border-gray-100 px-3 py-1.5 gap-2", children: [_jsx("span", { className: "text-xs text-gray-400 w-6 shrink-0", children: "CC:" }), _jsx("input", { value: cc, onChange: (e) => setCc(e.target.value), className: "flex-1 text-sm outline-none", placeholder: "CC..." })] }), _jsxs("div", { className: "flex items-center px-3 py-1.5 gap-2", children: [_jsx("span", { className: "text-xs text-gray-400 w-16 shrink-0", children: "Betreff:" }), _jsx("input", { value: subject, onChange: (e) => setSubject(e.target.value), className: "flex-1 text-sm outline-none", placeholder: "Betreff..." })] })] }), _jsx("div", { className: "flex items-center gap-0.5 px-2 py-1 border-b border-gray-100", children: [['bold', 'B'], ['italic', 'I'], ['underline', 'U']].map(([cmd, label]) => (_jsx("button", { onMouseDown: (e) => { e.preventDefault(); editor?.chain().focus().toggleMark(cmd).run(); }, className: "w-6 h-6 text-xs font-medium rounded hover:bg-gray-100 transition-colors", children: label }, cmd))) }), _jsx("div", { className: "flex-1 overflow-y-auto", children: _jsx(EditorContent, { editor: editor, className: "min-h-[160px] px-3 py-2 text-sm [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[120px]" }) }), _jsxs("div", { className: "flex items-center justify-between px-3 py-2 border-t border-gray-100 shrink-0", children: [_jsxs("div", { className: "flex items-center gap-1", children: [_jsxs("button", { className: "btn-ghost text-xs", children: [_jsx(Paperclip, { size: 14 }), " Anhang"] }), _jsxs("button", { className: "btn-ghost text-xs", children: [_jsx(Save, { size: 14 }), " Entwurf"] })] }), _jsxs("button", { onClick: () => sendMutation.mutate(), disabled: sendMutation.isPending || !to.trim(), className: "btn-primary text-xs disabled:opacity-50", children: [_jsx(Send, { size: 14 }), sendMutation.isPending ? 'Senden...' : 'Senden'] })] })] }));
}
