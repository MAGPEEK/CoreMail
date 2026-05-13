import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Reply, ReplyAll, Forward, Trash2, Archive, Paperclip, Download } from 'lucide-react';
import { format } from 'date-fns';
import DOMPurify from 'dompurify';
import { api } from '../api/client.js';
import type { Message } from '../api/types.js';
import { useUiStore } from '../store/ui.js';

// DOMPurify may not be installed — inline a simple sanitizer fallback
function sanitize(html: string): string {
  if (typeof window !== 'undefined' && 'DOMPurify' in window) {
    return (window as unknown as { DOMPurify: typeof DOMPurify }).DOMPurify.sanitize(html);
  }
  // Strip script tags as minimal fallback
  return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
}

interface Props {
  messageId: string;
}

export function MessageReader({ messageId }: Props) {
  const qc = useQueryClient();
  const { openCompose, setSelectedMessage } = useUiStore();

  const { data: msg, isLoading } = useQuery({
    queryKey: ['message', messageId],
    queryFn: () => api.get<Message>(`/mail/messages/${messageId}`),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/mail/messages/${messageId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages'] });
      qc.invalidateQueries({ queryKey: ['folders'] });
      setSelectedMessage(null);
    },
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Lade Nachricht...
      </div>
    );
  }

  if (!msg) return null;

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-100 shrink-0">
        <button onClick={() => openCompose({ id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr })}
          className="btn-secondary text-xs">
          <Reply size={14} /> Antworten
        </button>
        <button className="btn-secondary text-xs">
          <ReplyAll size={14} /> Allen antworten
        </button>
        <button className="btn-secondary text-xs">
          <Forward size={14} /> Weiterleiten
        </button>
        <div className="flex-1" />
        <button className="btn-ghost text-xs">
          <Archive size={14} /> Archivieren
        </button>
        <button onClick={() => deleteMutation.mutate()} className="btn-ghost text-xs text-red-600 hover:bg-red-50">
          <Trash2 size={14} /> Löschen
        </button>
      </div>

      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 shrink-0">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">{msg.subject || '(kein Betreff)'}</h2>
        <div className="space-y-1 text-sm text-gray-600">
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
        <div className="px-6 py-2 border-b border-gray-100 flex flex-wrap gap-2 shrink-0">
          {msg.attachments.map((att) => (
            <a key={att.id} href={`/api/v1/mail/attachments/${att.id}`} download={att.filename}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded text-xs text-gray-700 hover:bg-gray-100 transition-colors">
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
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: sanitize(msg.bodyHtml) }}
          />
        ) : (
          <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans">{msg.bodyText}</pre>
        )}
      </div>
    </div>
  );
}
