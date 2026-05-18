import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Reply, ReplyAll, Forward, Trash2, Archive, Paperclip, Download,
  AlertOctagon, MoreHorizontal, Code, Pin, Flag, FlagOff, FolderInput, Clock,
} from 'lucide-react';
import { format } from 'date-fns';
import DOMPurify from 'dompurify';
import { useState } from 'react';
import { api } from '../api/client.js';
import type { Message, Folder } from '../api/types.js';
import { useUiStore } from '../store/ui.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { showUndoToast } from './UndoToast.js';

function sanitize(html: string): string {
  if (typeof window !== 'undefined' && 'DOMPurify' in window) {
    return (window as unknown as { DOMPurify: typeof DOMPurify }).DOMPurify.sanitize(html);
  }
  return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
}

interface Props {
  messageId: string;
}

export function MessageReader({ messageId }: Props) {
  const qc = useQueryClient();
  const { openCompose, setSelectedMessage, selectedFolderId } = useUiStore();
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);

  const { data: msg, isLoading } = useQuery({
    queryKey: ['message', messageId],
    queryFn: () => api.get<Message>(`/mail/messages/${messageId}`),
  });

  const { data: folders = [] } = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<Folder[]>('/mail/folders'),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['messages'] });
    qc.invalidateQueries({ queryKey: ['folders'] });
    qc.invalidateQueries({ queryKey: ['message', messageId] });
  };

  const bulkMutation = useMutation({
    mutationFn: (body: { ids: string[]; action: string; folderId?: string }) =>
      api.post('/mail/messages/bulk', body),
    onSuccess: invalidate,
  });

  const patchMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/mail/messages/${messageId}`, body),
    onSuccess: invalidate,
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Lade Nachricht…
      </div>
    );
  }

  if (!msg) return null;

  const isFlagged = msg.flags.includes('\\Flagged');
  const isPinned = !!msg.pinnedAt;

  const handleDelete = () => {
    bulkMutation.mutate({ ids: [msg.id], action: 'delete' });
    if (selectedFolderId) {
      showUndoToast({
        message: 'In den Papierkorb verschoben',
        onUndo: () => bulkMutation.mutateAsync({ ids: [msg.id], action: 'move', folderId: selectedFolderId }),
      });
    }
    setSelectedMessage(null);
  };

  const handleArchive = () => {
    const src = selectedFolderId;
    bulkMutation.mutate({ ids: [msg.id], action: 'archive' });
    if (src) {
      showUndoToast({
        message: 'Archiviert',
        onUndo: () => bulkMutation.mutateAsync({ ids: [msg.id], action: 'move', folderId: src }),
      });
    }
    setSelectedMessage(null);
  };

  const moreItems: ContextMenuItem[] = [
    { label: isFlagged ? 'Kennzeichnung aufheben' : 'Kennzeichnen',
      icon: isFlagged ? <FlagOff size={14} /> : <Flag size={14} />,
      onClick: () => patchMutation.mutate({ flagged: !isFlagged }) },
    { label: isPinned ? 'Lösen' : 'Anheften',
      icon: <Pin size={14} />,
      onClick: () => bulkMutation.mutate({ ids: [msg.id], action: isPinned ? 'unpin' : 'pin' }) },
    {
      label: 'Schlummern bis …', icon: <Clock size={14} />,
      children: [
        { label: 'In 1 Stunde',     onClick: () => { const d = new Date(); d.setHours(d.getHours() + 1); void api.post(`/mail/messages/${msg.id}/snooze`, { until: d.toISOString() }).then(invalidate); } },
        { label: 'In 3 Stunden',    onClick: () => { const d = new Date(); d.setHours(d.getHours() + 3); void api.post(`/mail/messages/${msg.id}/snooze`, { until: d.toISOString() }).then(invalidate); } },
        { label: 'Morgen 8:00',     onClick: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8,0,0,0); void api.post(`/mail/messages/${msg.id}/snooze`, { until: d.toISOString() }).then(invalidate); } },
        { label: 'Nächsten Montag', onClick: () => { const d = new Date(); d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7)); d.setHours(8,0,0,0); void api.post(`/mail/messages/${msg.id}/snooze`, { until: d.toISOString() }).then(invalidate); } },
      ],
    },
    { type: 'divider' },
    { label: 'Verschieben nach …', icon: <FolderInput size={14} />,
      children: folders.filter((f) => f.id !== selectedFolderId).map((f) => ({
        label: f.displayName ?? f.name,
        onClick: () => {
          bulkMutation.mutate({ ids: [msg.id], action: 'move', folderId: f.id });
          setSelectedMessage(null);
        },
      })),
    },
    { label: 'Als Junk markieren', icon: <AlertOctagon size={14} />,
      onClick: () => { bulkMutation.mutate({ ids: [msg.id], action: 'spam' }); setSelectedMessage(null); } },
    { type: 'divider' },
    { label: 'Quelltext anzeigen', icon: <Code size={14} />,
      onClick: () => window.open(`/api/v1/mail/messages/${msg.id}/raw`, '_blank') },
    { label: 'Als EML herunterladen', icon: <Download size={14} />,
      onClick: () => {
        const a = document.createElement('a');
        a.href = `/api/v1/mail/messages/${msg.id}/raw`;
        a.download = `${msg.subject || 'message'}.eml`;
        a.click();
      } },
    { label: 'Drucken', icon: <Download size={14} />, onClick: () => window.print() },
  ];

  return (
    <div className="flex-1 flex flex-col bg-white dark:bg-gray-900 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-100 dark:border-gray-700 shrink-0">
        <button
          onClick={() => openCompose({ mode: 'reply', id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr, bodyHtml: msg.bodyHtml || `<p>${msg.bodyText.replace(/\n/g, '<br>')}</p>` })}
          className="btn-secondary text-xs">
          <Reply size={14} /> Antworten
        </button>
        <button
          onClick={() => openCompose({ mode: 'replyAll', id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr, toAddrs: msg.toAddrs, ccAddrs: msg.ccAddrs, bodyHtml: msg.bodyHtml || `<p>${msg.bodyText.replace(/\n/g, '<br>')}</p>` })}
          className="btn-secondary text-xs">
          <ReplyAll size={14} /> Allen antworten
        </button>
        <button
          onClick={() => openCompose({ mode: 'forward', id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr, bodyHtml: msg.bodyHtml || `<p>${msg.bodyText.replace(/\n/g, '<br>')}</p>` })}
          className="btn-secondary text-xs">
          <Forward size={14} /> Weiterleiten
        </button>
        <div className="flex-1" />
        <button onClick={handleArchive} className="btn-ghost text-xs">
          <Archive size={14} /> Archivieren
        </button>
        <button onClick={handleDelete} className="btn-ghost text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
          <Trash2 size={14} /> Löschen
        </button>
        <button
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMoreMenu({ x: r.right - 220, y: r.bottom });
          }}
          className="btn-ghost text-xs" title="Mehr Optionen">
          <MoreHorizontal size={14} />
        </button>
      </div>

      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 shrink-0">
        <div className="flex items-start gap-2 mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex-1">{msg.subject || '(kein Betreff)'}</h2>
          {isFlagged && <Flag size={16} className="fill-red-500 text-red-500 shrink-0 mt-1" />}
          {isPinned && <Pin size={16} className="text-accent shrink-0 mt-1" />}
        </div>
        <div className="space-y-1 text-sm text-gray-600 dark:text-gray-300">
          <div className="flex gap-2">
            <span className="font-medium text-gray-400 w-12">Von:</span>
            <span>{msg.fromAddr}</span>
          </div>
          <div className="flex gap-2">
            <span className="font-medium text-gray-400 w-12">An:</span>
            <span>{msg.toAddrs.join(', ')}</span>
          </div>
          {msg.ccAddrs?.length > 0 && (
            <div className="flex gap-2">
              <span className="font-medium text-gray-400 w-12">CC:</span>
              <span>{msg.ccAddrs.join(', ')}</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="font-medium text-gray-400 w-12">Datum:</span>
            <span>{format(new Date(msg.date), 'dd.MM.yyyy HH:mm')}</span>
          </div>
        </div>
      </div>

      {/* Attachments */}
      {msg.attachments?.length > 0 && (
        <div className="px-6 py-2 border-b border-gray-100 dark:border-gray-700 flex flex-wrap gap-2 shrink-0">
          {msg.attachments.map((att) => (
            <a key={att.id} href={`/api/v1/mail/attachments/${att.id}`} download={att.filename}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
              <Paperclip size={12} />
              {att.filename}
              <span className="text-gray-400">({Math.round(att.size / 1024)} KB)</span>
              <Download size={11} className="text-gray-400" />
            </a>
          ))}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {msg.bodyHtml ? (
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: sanitize(msg.bodyHtml) }}
          />
        ) : (
          <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-sans">{msg.bodyText}</pre>
        )}
      </div>

      {moreMenu && <ContextMenu x={moreMenu.x} y={moreMenu.y} items={moreItems} onClose={() => setMoreMenu(null)} />}
    </div>
  );
}
