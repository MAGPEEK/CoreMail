import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { Archive, Trash2, Mail, MailOpen, Flag, FolderInput, AlertOctagon, X, Pin, } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client.js';
import { useUiStore } from '../store/ui.js';
import { ContextMenu } from './ContextMenu.js';
import { showUndoToast } from './UndoToast.js';
import { AnimatedCounter } from './AnimatedCounter.js';
export function BulkToolbar({ currentFolderId }) {
    const qc = useQueryClient();
    const { selectedIds, clearSelection, setSelectedMessage } = useUiStore();
    const [moveMenu, setMoveMenu] = useState(null);
    const { data: folders = [] } = useQuery({
        queryKey: ['folders'],
        queryFn: () => api.get('/mail/folders'),
    });
    const count = selectedIds.size;
    const ids = Array.from(selectedIds);
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ['messages'] });
        qc.invalidateQueries({ queryKey: ['folders'] });
    };
    const bulkMutation = useMutation({
        mutationFn: (body) => api.post('/mail/messages/bulk', body),
        onSuccess: () => { invalidate(); },
    });
    if (count === 0)
        return null;
    const run = (action, opts) => {
        const body = opts?.folderId
            ? { ids, action, folderId: opts.folderId }
            : { ids, action };
        bulkMutation.mutate(body);
        if (opts?.undoMsg && opts.undoFolderId) {
            showUndoToast({
                message: opts.undoMsg,
                onUndo: () => bulkMutation.mutateAsync({ ids, action: 'move', folderId: opts.undoFolderId }),
            });
        }
        setSelectedMessage(null);
        clearSelection();
    };
    const moveItems = folders
        .filter((f) => f.id !== currentFolderId)
        .map((f) => ({
        label: f.displayName ?? f.name,
        icon: _jsx(FolderInput, { size: 14, style: f.color ? { color: f.color } : undefined }),
        onClick: () => run('move', { folderId: f.id }),
    }));
    return (_jsxs("div", { className: "absolute top-0 left-80 right-0 z-20 bg-accent text-white border-b border-accent/50 flex items-center gap-1 px-3 py-2 shadow-md animate-slide-down", children: [_jsx("button", { onClick: clearSelection, className: "p-1 hover:bg-white/10 rounded transition-all duration-150 active:scale-90", title: "Auswahl aufheben", children: _jsx(X, { size: 16 }) }), _jsxs("span", { className: "text-sm font-medium ml-1", children: [_jsx(AnimatedCounter, { value: count }), " ausgew\u00E4hlt"] }), _jsx("div", { className: "flex-1" }), _jsxs("button", { onClick: () => run('archive', { undoMsg: `${count} archiviert`, undoFolderId: currentFolderId }), className: "px-2 py-1 hover:bg-white/10 rounded flex items-center gap-1.5 text-sm", title: "Archivieren", children: [_jsx(Archive, { size: 14 }), " Archivieren"] }), _jsxs("button", { onClick: () => run('delete', { undoMsg: `${count} gelöscht`, undoFolderId: currentFolderId }), className: "px-2 py-1 hover:bg-white/10 rounded flex items-center gap-1.5 text-sm", title: "L\u00F6schen", children: [_jsx(Trash2, { size: 14 }), " L\u00F6schen"] }), _jsxs("button", { onClick: (e) => { const r = e.currentTarget.getBoundingClientRect(); setMoveMenu({ x: r.left, y: r.bottom }); }, className: "px-2 py-1 hover:bg-white/10 rounded flex items-center gap-1.5 text-sm", title: "Verschieben", children: [_jsx(FolderInput, { size: 14 }), " Verschieben"] }), _jsx("button", { onClick: () => run('read'), className: "p-1.5 hover:bg-white/10 rounded", title: "Als gelesen markieren", children: _jsx(MailOpen, { size: 14 }) }), _jsx("button", { onClick: () => run('unread'), className: "p-1.5 hover:bg-white/10 rounded", title: "Als ungelesen markieren", children: _jsx(Mail, { size: 14 }) }), _jsx("button", { onClick: () => run('flag'), className: "p-1.5 hover:bg-white/10 rounded", title: "Kennzeichnen", children: _jsx(Flag, { size: 14 }) }), _jsx("button", { onClick: () => run('pin'), className: "p-1.5 hover:bg-white/10 rounded", title: "Anheften", children: _jsx(Pin, { size: 14 }) }), _jsx("button", { onClick: () => run('spam'), className: "p-1.5 hover:bg-white/10 rounded", title: "Als Junk markieren", children: _jsx(AlertOctagon, { size: 14 }) }), moveMenu && (_jsx(ContextMenu, { x: moveMenu.x, y: moveMenu.y, items: moveItems, onClose: () => setMoveMenu(null) }))] }));
}
