import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderTree } from '../components/FolderTree.js';
import { MessageList } from '../components/MessageList.js';
import { MessageReader } from '../components/MessageReader.js';
import { useUiStore } from '../store/ui.js';
import { api } from '../api/client.js';
import type { Folder } from '../api/types.js';

export function MailPage() {
  const { selectedFolderId, selectedMessageId, setSelectedFolder, openCompose } = useUiStore();

  const { data: folders } = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<Folder[]>('/mail/folders'),
  });

  // Auto-select INBOX on first load
  useEffect(() => {
    if (!selectedFolderId && folders?.length) {
      const inbox = folders.find((f) => f.name === 'INBOX');
      if (inbox) setSelectedFolder(inbox.id);
    }
  }, [folders, selectedFolderId, setSelectedFolder]);

  return (
    <div className="flex flex-1 overflow-hidden">
      <FolderTree onNewMail={() => openCompose()} />

      {selectedFolderId ? (
        <>
          <MessageList folderId={selectedFolderId} />
          {selectedMessageId ? (
            <MessageReader messageId={selectedMessageId} />
          ) : (
            <div className="flex-1 flex items-center justify-center bg-gray-50 text-gray-400 text-sm">
              Nachricht auswählen
            </div>
          )}
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
          Ordner auswählen
        </div>
      )}
    </div>
  );
}
