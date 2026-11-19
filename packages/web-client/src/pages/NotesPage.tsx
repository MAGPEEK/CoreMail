import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X, Search } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Modal } from '../components/Modal.js';
import { PageShell } from '../components/PageShell.js';
import { PAGE_CONTENT_PAD } from '../lib/pageShell.js';
import { CategoryChips, CategoryPicker } from '../components/CategoryPicker.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type NoteColor = 'YELLOW' | 'BLUE' | 'GREEN' | 'PINK' | 'PURPLE';

interface NoteListItem {
  id: string;
  subject: string;
  color: NoteColor;
  /** 9.5: category names */
  categories?: string[];
  updatedAt: string;
}

interface NoteDetail extends NoteListItem {
  body: string;
}

// ─── Color config ─────────────────────────────────────────────────────────────
// The note colour is user data. Cards are an opaque surface with a 15 % tint of the
// hue on top (gradient layer), so fg / fg-subtle keep >= 4.5:1 in both themes.

const COLOR_BG: Record<NoteColor, string> = {
  YELLOW: 'bg-surface bg-gradient-to-b from-yellow-400/15 to-yellow-400/15 border-line',
  BLUE:   'bg-surface bg-gradient-to-b from-blue-500/15 to-blue-500/15 border-line',
  GREEN:  'bg-surface bg-gradient-to-b from-green-500/15 to-green-500/15 border-line',
  PINK:   'bg-surface bg-gradient-to-b from-pink-500/15 to-pink-500/15 border-line',
  PURPLE: 'bg-surface bg-gradient-to-b from-purple-500/15 to-purple-500/15 border-line',
};

const COLOR_HEADER: Record<NoteColor, string> = {
  YELLOW: 'bg-yellow-400/10',
  BLUE:   'bg-blue-500/10',
  GREEN:  'bg-green-500/10',
  PINK:   'bg-pink-500/10',
  PURPLE: 'bg-purple-500/10',
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

  const [form, setForm] = useState<{ subject: string; body: string; color: NoteColor; categories: string[] }>({
    subject: '',
    body: '',
    color: 'YELLOW',
    categories: [],
  });

  // Load existing note
  const { data: noteData, isLoading } = useQuery<NoteDetail>({
    queryKey: ['note-detail', noteId],
    queryFn: () => api.get<NoteDetail>(`/notes/${noteId!}`),
    enabled: !isNew,
  });

  useEffect(() => {
    if (noteData) setForm({ subject: noteData.subject, body: noteData.body, color: noteData.color, categories: noteData.categories ?? [] });
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
      overlayClassName="fixed inset-0 bg-scrim/40 z-50 flex items-center justify-center p-4"
      className={loading
        ? 'bg-surface rounded-lg p-8 text-fg-subtle text-sm'
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
                  form.color === c ? 'border-fg scale-125' : 'border-transparent hover:border-line-strong'
                }`} />
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => save.mutate()} disabled={save.isPending || !form.subject}
              className="text-xs px-3 py-1 bg-surface/70 hover:bg-surface rounded text-fg-muted font-medium disabled:opacity-50 transition-colors">
              {save.isPending ? 'Speichern…' : 'Speichern'}
            </button>
            <button type="button" onClick={onClose} aria-label="Schließen" className="ml-1 text-fg-subtle hover:text-fg-muted">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3">
          <input value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
            aria-label="Betreff" autoFocus
            className="w-full bg-transparent border-b border-line-strong pb-1 text-base font-semibold text-fg placeholder-fg-subtle focus:outline-none focus:border-accent-fg"
            placeholder="Betreff" />
          <textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
            aria-label="Notiz"
            rows={10} className="w-full bg-transparent text-sm text-fg-muted placeholder-fg-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg rounded-sm resize-none"
            placeholder="Notiz eingeben…" />
          <CategoryPicker value={form.categories} onChange={(categories) => setForm(f => ({ ...f, categories }))} />
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
    <PageShell
      title="Notizen"
      bodyClassName="bg-surface-2"
      actions={
        <>
          <div className="flex items-center gap-1.5 bg-surface-2 rounded px-2.5 py-1.5 flex-1 max-w-xs">
            <Search size={13} className="text-fg-subtle shrink-0" aria-hidden="true" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              aria-label="Notizen durchsuchen"
              className="bg-transparent text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg rounded-sm text-fg-muted placeholder-fg-subtle w-full"
              placeholder="Notizen durchsuchen…" />
          </div>

          <button onClick={() => setEditId(null)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-accent rounded hover:bg-accent/90 shrink-0">
            <Plus size={14} /> Neue Notiz
          </button>
        </>
      }
    >
      {/* Grid */}
      <div className={`flex-1 overflow-y-auto ${PAGE_CONTENT_PAD}`}>
        {isLoading ? (
          <div className="text-center text-fg-subtle py-16 text-sm">Laden…</div>
        ) : notes.length === 0 ? (
          <div className="text-center text-fg-subtle py-16">
            <p className="text-sm">{search ? 'Keine Notizen gefunden' : 'Noch keine Notizen vorhanden'}</p>
            {!search && (
              <button onClick={() => setEditId(null)}
                className="mt-3 text-sm text-accent-fg hover:underline">
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
                    className="opacity-0 group-hover:opacity-100 text-fg-subtle hover:text-danger-fg transition-all">
                    <Trash2 size={12} />
                  </button>
                </div>

                {/* Note body */}
                <div className="px-3 py-2.5 min-h-[100px]">
                  <p className="text-sm font-medium text-fg line-clamp-2 leading-snug">{note.subject || '(Kein Betreff)'}</p>
                  {note.categories && note.categories.length > 0 && <div className="mt-2"><CategoryChips names={note.categories} /></div>}
                  <p className="text-xs text-fg-subtle mt-2">{fmtDate(note.updatedAt)}</p>
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
    </PageShell>
  );
}
