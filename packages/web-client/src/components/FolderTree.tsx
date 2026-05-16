import { useQuery } from '@tanstack/react-query';
import { Inbox, FileText, Send, Trash2, AlertTriangle, Archive, Folder, Plus } from 'lucide-react';
import { api } from '../api/client.js';
import type { Folder as FolderType } from '../api/types.js';
import { useUiStore } from '../store/ui.js';

// Reihenfolge + Anzeigenamen der System-Ordner
const SYSTEM_ORDER = ['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Archive'] as const;

const DISPLAY_NAME: Record<string, string> = {
  INBOX:   'Posteingang',
  Drafts:  'Entwürfe',
  Sent:    'Gesendete Elemente',
  Trash:   'Gelöschte Elemente',
  Junk:    'Junk-E-Mail',
  Archive: 'Archiv',
};

const ICON_MAP: Record<string, React.ElementType> = {
  INBOX:   Inbox,
  Drafts:  FileText,
  Sent:    Send,
  Trash:   Trash2,
  Junk:    AlertTriangle,
  Archive: Archive,
};

const SYSTEM_SET = new Set(SYSTEM_ORDER as readonly string[]);

interface Props { onNewMail: () => void }

export function FolderTree({ onNewMail }: Props) {
  const { data: folders } = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<FolderType[]>('/mail/folders'),
    refetchInterval: 60_000,
  });

  const { selectedFolderId, setSelectedFolder } = useUiStore();

  const all = folders ?? [];

  // System-Ordner in definierter Reihenfolge
  const systemFolders = SYSTEM_ORDER
    .map(name => all.find(f => f.name === name))
    .filter((f): f is FolderType => f !== undefined);

  // Benutzerdefinierte Ordner (alles andere)
  const customFolders = all.filter(f => !SYSTEM_SET.has(f.name));

  const FolderItem = ({ folder }: { folder: FolderType }) => {
    const Icon = ICON_MAP[folder.name] ?? Folder;
    const isSelected = folder.id === selectedFolderId;
    const label = DISPLAY_NAME[folder.name] ?? folder.displayName ?? folder.name;
    return (
      <button
        onClick={() => setSelectedFolder(folder.id)}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-sm transition-colors ${
          isSelected ? 'bg-accent/10 text-accent font-medium' : 'text-gray-700 hover:bg-gray-100'
        }`}
      >
        <Icon size={15} className="shrink-0" />
        <span className="flex-1 text-left truncate">{label}</span>
        {folder.unreadCount > 0 && (
          <span className="text-xs font-bold text-accent">{folder.unreadCount}</span>
        )}
      </button>
    );
  };

  return (
    <aside className="w-52 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col h-full">
      <div className="p-3">
        <button onClick={onNewMail} className="btn-primary w-full justify-center">
          <Plus size={15} />
          Neue E-Mail
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-1">
        <div className="space-y-0.5">
          {systemFolders.map(f => <FolderItem key={f.id} folder={f} />)}
        </div>

        {customFolders.length > 0 && (
          <>
            <div className="mt-3 mb-1 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Meine Ordner
            </div>
            <div className="space-y-0.5">
              {customFolders.map(f => <FolderItem key={f.id} folder={f} />)}
            </div>
          </>
        )}
      </nav>
    </aside>
  );
}
