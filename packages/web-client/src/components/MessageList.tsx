import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { api } from '../api/client.js';
import type { MessagesResponse, MessageSummary } from '../api/types.js';
import { useUiStore } from '../store/ui.js';

interface Props {
  folderId: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return 'Gestern';
  return format(d, 'dd.MM.yyyy');
}

function MessageRow({ msg, selected, onClick }: { msg: MessageSummary; selected: boolean; onClick: () => void }) {
  const isUnread = !msg.flags.includes('\\Seen');
  const hasAttachments = msg.attachments.length > 0;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-2.5 border-b border-gray-100 transition-colors relative group ${
        selected ? 'bg-accent/10' : 'hover:bg-gray-50'
      }`}
    >
      {isUnread && (
        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-accent" />
      )}
      <div className="flex items-start justify-between gap-2">
        <span className={`text-sm truncate ${isUnread ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
          {msg.fromAddr}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {hasAttachments && <Paperclip size={12} className="text-gray-400" />}
          <span className="text-xs text-gray-400">{formatDate(msg.date)}</span>
        </div>
      </div>
      <p className={`text-sm truncate mt-0.5 ${isUnread ? 'font-medium text-gray-800' : 'text-gray-600'}`}>
        {msg.subject || '(kein Betreff)'}
      </p>
    </button>
  );
}

export function MessageList({ folderId }: Props) {
  const { selectedMessageId, setSelectedMessage } = useUiStore();

  const { data, isLoading } = useQuery({
    queryKey: ['messages', folderId],
    queryFn: () => api.get<MessagesResponse>(`/mail/folders/${folderId}/messages?limit=100`),
    enabled: !!folderId,
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Lade Nachrichten...
      </div>
    );
  }

  if (!data?.messages.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Keine Nachrichten
      </div>
    );
  }

  return (
    <div className="w-72 shrink-0 border-r border-gray-200 bg-white flex flex-col h-full">
      <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between">
        <span className="text-xs text-gray-500">{data.total} Nachrichten</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {data.messages.map((msg) => (
          <MessageRow
            key={msg.id}
            msg={msg}
            selected={msg.id === selectedMessageId}
            onClick={() => setSelectedMessage(msg.id)}
          />
        ))}
      </div>
    </div>
  );
}
