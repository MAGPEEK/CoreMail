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
    onError: (err: Error) => toast.error(err.message),
  });

  if (minimized) {
    return (
      <div className="fixed bottom-0 right-4 w-72 bg-gray-800 text-white rounded-t-lg shadow-xl z-50">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-medium truncate">{subject || 'Neue Nachricht'}</span>
          <div className="flex items-center gap-1">
            <button onClick={() => setMinimized(false)} className="p-0.5 hover:bg-white/20 rounded">
              <Maximize2 size={13} />
            </button>
            <button onClick={closeCompose} className="p-0.5 hover:bg-white/20 rounded">
              <X size={13} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 right-4 w-[580px] bg-white shadow-2xl border border-gray-300 rounded-t-lg z-50 flex flex-col"
      style={{ maxHeight: '70vh' }}>
      {/* Title bar */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-800 text-white rounded-t-lg cursor-default">
        <span className="text-sm font-medium">{subject || 'Neue Nachricht'}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setMinimized(true)} className="p-0.5 hover:bg-white/20 rounded">
            <Minus size={13} />
          </button>
          <button onClick={closeCompose} className="p-0.5 hover:bg-white/20 rounded">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Fields */}
      <div className="border-b border-gray-100">
        <div className="flex items-center border-b border-gray-100 px-3 py-1.5 gap-2">
          <span className="text-xs text-gray-400 w-6 shrink-0">An:</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} className="flex-1 text-sm outline-none" placeholder="Empfänger..." />
        </div>
        <div className="flex items-center border-b border-gray-100 px-3 py-1.5 gap-2">
          <span className="text-xs text-gray-400 w-6 shrink-0">CC:</span>
          <input value={cc} onChange={(e) => setCc(e.target.value)} className="flex-1 text-sm outline-none" placeholder="CC..." />
        </div>
        <div className="flex items-center px-3 py-1.5 gap-2">
          <span className="text-xs text-gray-400 w-16 shrink-0">Betreff:</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className="flex-1 text-sm outline-none" placeholder="Betreff..." />
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-gray-100">
        {([['bold', 'B'], ['italic', 'I'], ['underline', 'U']] as const).map(([cmd, label]) => (
          <button key={cmd} onMouseDown={(e) => { e.preventDefault(); editor?.chain().focus().toggleMark(cmd).run(); }}
            className="w-6 h-6 text-xs font-medium rounded hover:bg-gray-100 transition-colors">
            {label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} className="min-h-[160px] px-3 py-2 text-sm [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[120px]" />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 shrink-0">
        <div className="flex items-center gap-1">
          <button className="btn-ghost text-xs">
            <Paperclip size={14} /> Anhang
          </button>
          <button className="btn-ghost text-xs">
            <Save size={14} /> Entwurf
          </button>
        </div>
        <button
          onClick={() => sendMutation.mutate()}
          disabled={sendMutation.isPending || !to.trim()}
          className="btn-primary text-xs disabled:opacity-50"
        >
          <Send size={14} />
          {sendMutation.isPending ? 'Senden...' : 'Senden'}
        </button>
      </div>
    </div>
  );
}
