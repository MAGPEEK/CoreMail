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
    // BulkToolbar liegt absolut über der MessageList (FolderTree-Breite 208 px = left-52)
    // und endet bei der MessageList-Breite (320 px + 208 = 528 px = w-[20rem] + left-52).
    // Damit überdeckt die Bar nur die Filter-Tab-Zeile der MessageList, nicht den Reader.
    const IconBtn = ({ icon, onClick, title, }) => (_jsx("button", { onClick: onClick, title: title, className: "p-1.5 rounded-sm text-gray-600 dark:text-gray-300 hover:bg-accent/10 hover:text-accent transition-all duration-150 active:scale-90", children: icon }));
    return (_jsxs("div", { className: "absolute top-0 left-52 w-80 z-20 bg-white dark:bg-gray-800 border-b-2 border-accent flex items-center gap-1 px-2 py-1.5 shadow-sm animate-slide-down", children: [_jsx("button", { onClick: clearSelection, className: "p-1 rounded text-gray-500 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-all duration-150 active:scale-90", title: "Auswahl aufheben", children: _jsx(X, { size: 16 }) }), _jsxs("span", { className: "text-xs font-semibold text-accent", children: [_jsx(AnimatedCounter, { value: count }), " ausgew\u00E4hlt"] }), _jsx("div", { className: "flex-1" }), _jsx(IconBtn, { icon: _jsx(Archive, { size: 15 }), title: "Archivieren", onClick: () => run('archive', { undoMsg: `${count} archiviert`, undoFolderId: currentFolderId }) }), _jsx(IconBtn, { icon: _jsx(Trash2, { size: 15 }), title: "L\u00F6schen", onClick: () => run('delete', { undoMsg: `${count} gelöscht`, undoFolderId: currentFolderId }) }), _jsx(IconBtn, { icon: _jsx(FolderInput, { size: 15 }), title: "Verschieben", onClick: () => {
                    /* Sub-Menü öffnen via DOM-Anker — Trick: dummy-Button-Ref */
                    setMoveMenu({ x: 0, y: 0 });
                } }), _jsx(IconBtn, { icon: _jsx(MailOpen, { size: 15 }), title: "Als gelesen markieren", onClick: () => run('read') }), _jsx(IconBtn, { icon: _jsx(Mail, { size: 15 }), title: "Als ungelesen markieren", onClick: () => run('unread') }), _jsx(IconBtn, { icon: _jsx(Flag, { size: 15 }), title: "Kennzeichnen", onClick: () => run('flag') }), _jsx(IconBtn, { icon: _jsx(Pin, { size: 15 }), title: "Anheften", onClick: () => run('pin') }), _jsx(IconBtn, { icon: _jsx(AlertOctagon, { size: 15 }), title: "Als Junk markieren", onClick: () => run('spam') }), moveMenu && (_jsx(MoveMenu, { items: moveItems, onClose: () => setMoveMenu(null) }))] }));
}
// Kleiner Wrapper, der das ContextMenu positionsrelativ zum Toolbar-Container öffnet
function MoveMenu({ items, onClose }) {
    // Ankerpunkt: rechts unten unterhalb der Toolbar (in der Nähe des Verschieben-Buttons)
    // Wir berechnen das einfach relativ zum Viewport, da BulkToolbar fix sitzt.
    // Die Toolbar ist links-52 (208 px), w-80 (320 px), Höhe ~36 px.
    return (_jsx(ContextMenu, { x: 208 + 320 - 220, y: 42, items: items, onClose: onClose }));
}
