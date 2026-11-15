import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X, Search } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Modal } from '../components/Modal.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type NoteColor = 'YELLOW' | 'BLUE' | 'GREEN' | 'PINK' | 'PURPLE';

interface NoteListItem {
  id: string;
  subject: string;
  color: NoteColor;
  updatedAt: string;
}

interface NoteDetail extends NoteListItem {
  body: string;
}

// ─── Color config ─────────────────────────────────────────────────────────────

const COLOR_BG: Record<NoteColor, string> = {
  YELLOW: 'bg-yellow-100 border-yellow-200',
  BLUE:   'bg-blue-100 border-blue-200',
  GREEN:  'bg-green-100 border-green-200',
  PINK:   'bg-pink-100 border-pink-200',
  PURPLE: 'bg-purple-100 border-purple-200',
};

const COLOR_HEADER: Record<NoteColor, string> = {
  YELLOW: 'bg-yellow-200',
  BLUE:   'bg-blue-200',
  GREEN:  'bg-green-200',
  PINK:   'bg-pink-200',
  PURPLE: 'bg-purple-200',
};

const COLOR_DOT: Record<NoteColor, string> = {
  YELLOW: 'bg-yellow-400',
  BLUE:   'bg-blue-400',
  GREEN:  'bg-green-500',
  PINK:   'bg-pink-400',
  PURPLE: 'bg-purple-500',
};

const COLORS: NoteColor[] = ['YELLOW', 'BLUE', 'GREEN', 'PINK', 'PURPLE'];

const COLOR_LABEL: Record<NoteColor, string> = {
  YELLOW: 'Gelb',
  BLUE:   'Blau',
  GREEN:  'Grün',
  PINK:   'Rosa',
  PURPLE: 'Lila',
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ─── Note Editor Modal ────────────────────────────────────────────────────────

function NoteEditor({ noteId, onClose }: { noteId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = noteId === null;

  const [form, setForm] = useState<{ subject: string; body: string; color: NoteColor }>({
    subject: '',
    body: '',
    color: 'YELLOW',
  });

  // Load existing note
  const { data: noteData, isLoading } = useQuery<NoteDetail>({
    queryKey: ['note-detail', noteId],
    queryFn: () => api.get<NoteDetail>(`/notes/${noteId!}`),
    enabled: !isNew,
  });

  useEffect(() => {
    if (noteData) setForm({ subject: noteData.subject, body: noteData.body, color: noteData.color });
  }, [noteData]);

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api.post('/notes', form)
        : api.put(`/notes/${noteId}`, form),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notes'] });
      if (!isNew) void qc.invalidateQueries({ queryKey: ['note-detail', noteId] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const loading = !isNew && isLoading;

  return (
    <Modal
      onClose={onClose}
      label={isNew ? 'Neue Notiz' : 'Notiz bearbeiten'}
      overlayClassName="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      className={loading
        ? 'bg-white rounded-lg p-8 text-gray-400 text-sm'
        : `rounded-lg shadow-xl w-full max-w-lg border ${COLOR_BG[form.color]}`}
    >
      {loading ? (
        <span role="status">Laden…</span>
      ) : (
      <>
        {/* Header bar */}
        <div className={`flex items-center justify-between px-4 py-2.5 rounded-t-lg ${COLOR_HEADER[form.color]}`}>
          <div className="flex items-center gap-2" role="radiogroup" aria-label="Farbe">
            {/* Color picker */}
            {COLORS.map(c => (
              <button key={c} type="button" onClick={() => setForm(f => ({ ...f, color: c }))}
                role="radio" aria-checked={form.color === c} aria-label={COLOR_LABEL[c]} title={COLOR_LABEL[c]}
                className={`w-4 h-4 rounded-full border-2 transition-all ${COLOR_DOT[c]} ${
                  form.color === c ? 'border-gray-600 scale-125' : 'border-transparent hover:border-gray-400'
                }`} />
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => save.mutate()} disabled={save.isPending || !form.subject}
              className="text-xs px-3 py-1 bg-white/60 hover:bg-white/80 rounded text-gray-700 font-medium disabled:opacity-50 transition-colors">
              {save.isPending ? 'Speichern…' : 'Speichern'}
            </button>
            <button type="button" onClick={onClose} aria-label="Schließen" className="ml-1 text-gray-500 hover:text-gray-700">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3">
          <input value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
            aria-label="Betreff" autoFocus
            className="w-full bg-transparent border-b border-gray-300 pb-1 text-base font-semibold text-gray-800 placeholder-gray-400 focus:outline-none focus:border-gray-500"
            placeholder="Betreff" />
          <textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
            aria-label="Notiz"
            rows={10} className="w-full bg-transparent text-sm text-gray-700 placeholder-gray-400 focus:outline-none resize-none"
            placeholder="Notiz eingeben…" />
        </div>
      </>
      )}
    </Modal>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function NotesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [editId, setEditId] = useState<string | null | undefined>(undefined); // undefined = closed, null = new, string = edit

  const { data: notes = [], isLoading } = useQuery<NoteListItem[]>({
    queryKey: ['notes', search],
    queryFn: () => api.get<NoteListItem[]>(`/notes${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/notes/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['notes'] }); toast.success('Notiz gelöscht'); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-gray-50">
      {/* Toolbar */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3">
        <h1 className="text-base font-semibold text-gray-900 mr-2">Notizen</h1>

        <div className="flex items-center gap-1.5 bg-gray-100 rounded px-2.5 py-1.5 flex-1 max-w-xs">
          <Search size={13} className="text-gray-400 shrink-0" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            className="bg-transparent text-sm focus:outline-none text-gray-700 placeholder-gray-400 w-full"
            placeholder="Notizen durchsuchen…" />
        </div>

        <button onClick={() => setEditId(null)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-accent rounded hover:bg-accent/90 ml-auto">
          <Plus size={14} /> Neue Notiz
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="text-center text-gray-400 py-16 text-sm">Laden…</div>
        ) : notes.length === 0 ? (
          <div className="text-center text-gray-400 py-16">
            <p className="text-sm">{search ? 'Keine Notizen gefunden' : 'Noch keine Notizen vorhanden'}</p>
            {!search && (
              <button onClick={() => setEditId(null)}
                className="mt-3 text-sm text-accent hover:underline">
                Erste Notiz erstellen
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {notes.map(note => (
              <div key={note.id}
                className={`relative rounded-lg border cursor-pointer shadow-sm hover:shadow-md transition-shadow group ${COLOR_BG[note.color]}`}
                onClick={() => setEditId(note.id)}>
                {/* Note header */}
                <div className={`rounded-t-lg px-3 py-1.5 flex items-center justify-between ${COLOR_HEADER[note.color]}`}>
                  <div className={`w-2.5 h-2.5 rounded-full ${COLOR_DOT[note.color]}`} />
                  <button aria-label="Notiz löschen"
                    onClick={e => { e.stopPropagation(); del.mutate(note.id); }}
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all">
                    <Trash2 size={12} />
                  </button>
                </div>

                {/* Note body */}
                <div className="px-3 py-2.5 min-h-[100px]">
                  <p className="text-sm font-medium text-gray-800 line-clamp-2 leading-snug">{note.subject || '(Kein Betreff)'}</p>
                  <p className="text-xs text-gray-500 mt-2">{fmtDate(note.updatedAt)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Editor modal */}
      {editId !== undefined && (
        <NoteEditor noteId={editId} onClose={() => setEditId(undefined)} />
      )}
    </div>
  );
}
