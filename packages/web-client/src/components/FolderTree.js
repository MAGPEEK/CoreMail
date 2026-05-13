import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useQuery } from '@tanstack/react-query';
import { Inbox, FileText, Send, Trash2, AlertTriangle, Archive, Folder, Plus } from 'lucide-react';
import { api } from '../api/client.js';
import { useUiStore } from '../store/ui.js';
const ICON_MAP = {
    INBOX: Inbox,
    Drafts: FileText,
    Sent: Send,
    Trash: Trash2,
    Junk: AlertTriangle,
    Archive: Archive,
};
export function FolderTree({ onNewMail }) {
    const { data: folders } = useQuery({
        queryKey: ['folders'],
        queryFn: () => api.get('/mail/folders'),
        refetchInterval: 60_000,
    });
    const { selectedFolderId, setSelectedFolder } = useUiStore();
    const systemFolders = (folders ?? []).filter((f) => Object.keys(ICON_MAP).includes(f.name));
    const customFolders = (folders ?? []).filter((f) => !Object.keys(ICON_MAP).includes(f.name));
    const FolderItem = ({ folder }) => {
        const Icon = ICON_MAP[folder.name] ?? Folder;
        const isSelected = folder.id === selectedFolderId;
        return (_jsxs("button", { onClick: () => setSelectedFolder(folder.id), className: `w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-sm transition-colors ${isSelected ? 'bg-accent/10 text-accent font-medium' : 'text-gray-700 hover:bg-gray-100'}`, children: [_jsx(Icon, { size: 15, className: "shrink-0" }), _jsx("span", { className: "flex-1 text-left truncate", children: folder.name === 'INBOX' ? 'Posteingang' : folder.name }), folder.unreadCount > 0 && (_jsx("span", { className: "text-xs font-bold text-accent", children: folder.unreadCount }))] }));
    };
    return (_jsxs("aside", { className: "w-52 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col h-full", children: [_jsx("div", { className: "p-3", children: _jsxs("button", { onClick: onNewMail, className: "btn-primary w-full justify-center", children: [_jsx(Plus, { size: 15 }), "Neue E-Mail"] }) }), _jsxs("nav", { className: "flex-1 overflow-y-auto px-1", children: [_jsx("div", { className: "space-y-0.5", children: systemFolders.map((f) => _jsx(FolderItem, { folder: f }, f.id)) }), customFolders.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: "mt-3 mb-1 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wide", children: "Meine Ordner" }), _jsx("div", { className: "space-y-0.5", children: customFolders.map((f) => _jsx(FolderItem, { folder: f }, f.id)) })] }))] })] }));
}
