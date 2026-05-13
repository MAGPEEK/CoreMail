import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderTree } from '../components/FolderTree.js';
import { MessageList } from '../components/MessageList.js';
import { MessageReader } from '../components/MessageReader.js';
import { useUiStore } from '../store/ui.js';
import { api } from '../api/client.js';
export function MailPage() {
    const { selectedFolderId, selectedMessageId, setSelectedFolder, openCompose } = useUiStore();
    const { data: folders } = useQuery({
        queryKey: ['folders'],
        queryFn: () => api.get('/mail/folders'),
    });
    // Auto-select INBOX on first load
    useEffect(() => {
        if (!selectedFolderId && folders?.length) {
            const inbox = folders.find((f) => f.name === 'INBOX');
            if (inbox)
                setSelectedFolder(inbox.id);
        }
    }, [folders, selectedFolderId, setSelectedFolder]);
    return (_jsxs("div", { className: "flex flex-1 overflow-hidden", children: [_jsx(FolderTree, { onNewMail: () => openCompose() }), selectedFolderId ? (_jsxs(_Fragment, { children: [_jsx(MessageList, { folderId: selectedFolderId }), selectedMessageId ? (_jsx(MessageReader, { messageId: selectedMessageId })) : (_jsx("div", { className: "flex-1 flex items-center justify-center bg-gray-50 text-gray-400 text-sm", children: "Nachricht ausw\u00E4hlen" }))] })) : (_jsx("div", { className: "flex-1 flex items-center justify-center text-gray-400 text-sm", children: "Ordner ausw\u00E4hlen" }))] }));
}
