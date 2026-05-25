/**
 * SharedMailboxPage — Read-only view of a shared mailbox the user has access to.
 *
 * Verwendet eigene Backend-Routen unter /api/v1/user/shared-mailboxes/:id/...
 * statt der Standard-/mail/-Routen. Damit ist klar getrennt zwischen „mein
 * Postfach" und „freigegebenes Postfach", und Backend kann die Berechtigung
 * pro Aufruf prüfen.
 *
 * Folder-Sidebar: gleiche Anordnung (INBOX → Drafts → Sent → Trash → Junk → Archive)
 * und gleiche Sprache wie in der normalen MailPage (via useT()).
 */
import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Inbox, ArrowLeft, Folder as FolderIcon, Star, Trash2, Send,
  FileText, AlertCircle, Paperclip, FolderPlus, Pencil, X, Archive,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import { useLanguageStore } from '../store/language.js';

interface SharedMailbox {
  id:          string;
  email:       string;
  displayName: string;
  active:      boolean;
  permissions: string[];
}

interface Folder {
  id:          string;
  name:        string;
  displayName: string;
  parentId:    string | null;
  totalCount:  number;
  unreadCount: number;
  isFavorite:  boolean;
  sortOrder:   number;
  color:       string | null;
}

interface MessageListEntry {
  id:        string;
  subject:   string;
  fromAddr:  string;
  fromName:  string;
  toAddrs:   string[];
  date:      string;
  flags:     string[];
  rawSize:   number;
  bodyText:  string;
}

interface MessageDetail extends MessageListEntry {
  bodyHtml:    string;
  folder:      { id: string; name: string; displayName: string };
  attachments: { id: string; filename: string; mimeType: string; size: number }[];
}

interface MessageListResponse {
  total:    number;
  messages: MessageListEntry[];
}

// ── System-Ordner Sortierung (identisch zur normalen Mailbox / FolderTree) ────
const SYSTEM_ORDER = ['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Archive'] as const;
const SYSTEM_ORDER_IDX = Object.fromEntries(SYSTEM_ORDER.map((n, i) => [n, i]));

// i18n-Key pro System-Folder-Name (identisch zu FolderTree.tsx)
const SYSTEM_LABEL_KEY: Record<string, 'inbox' | 'drafts' | 'sent' | 'trash' | 'junk' | 'archive'> = {
  INBOX:   'inbox',
  Drafts:  'drafts',
  Sent:    'sent',
  Trash:   'trash',
  Junk:    'junk',
  Archive: 'archive',
};

// Icon-Map (identisch zu FolderTree.tsx)
const ICON_MAP: Record<string, React.ElementType> = {
  INBOX:   Inbox,
  Drafts:  FileText,
  Sent:    Send,
  Trash:   Trash2,
  Junk:    AlertCircle,
  Archive: Archive,
};

// Standard-Folder, die nicht umbenannt/gelöscht werden dürfen
const PROTECTED_FOLDER_NAMES = new Set(['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Outbox', 'Archive']);

function fmtBytes(b: number) {
  if (b < 1024)            return `${b} B`;
  if (b < 1024 * 1024)     return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

export function SharedMailboxPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);

  // Datums-Formatierung in der Sprache des Benutzers
  const dateLocale = lang === 'en' ? 'en-GB' : lang === 'es' ? 'es-ES' : lang === 'it' ? 'it-IT' : 'de-DE';
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(dateLocale, {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  // ── Mailbox-Metadaten ──────────────────────────────────────────────────────
  const { data: mailbox, isLoading: loadingMailbox, error: mailboxError } = useQuery<SharedMailbox>({
    queryKey: ['shared-mailbox', id],
    queryFn:  () => api.get(`/user/shared-mailboxes/${id}`),
    enabled:  !!id,
  });

  // ── Folder-Liste ──────────────────────────────────────────────────────────
  const { data: folders = [], isLoading: loadingFolders } = useQuery<Folder[]>({
    queryKey: ['shared-mailbox-folders', id],
    queryFn:  () => api.get(`/user/shared-mailboxes/${id}/folders`),
    enabled:  !!id && !!mailbox,
  });

  const [selectedFolderId, setSelectedFolderId]   = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);

  // ── Folder-Aktionen (nur für FULL_ACCESS sichtbar/erlaubt) ────────────────
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingId,    setRenamingId]    = useState<string | null>(null);
  const [renameValue,   setRenameValue]   = useState('');

  const invalidateFolders = () => qc.invalidateQueries({ queryKey: ['shared-mailbox-folders', id] });

  const createFolder = useMutation({
    mutationFn: (displayName: string) =>
      api.post(`/user/shared-mailboxes/${id}/folders`, { displayName }),
    onSuccess: () => {
      void invalidateFolders();
      setShowNewFolder(false);
      setNewFolderName('');
      toast.success('Ordner erstellt');
    },
    onError: (e: Error) => toast.error(e.message || 'Konnte Ordner nicht erstellen'),
  });

  const renameFolder = useMutation({
    mutationFn: ({ folderId, displayName }: { folderId: string; displayName: string }) =>
      api.patch(`/user/shared-mailboxes/${id}/folders/${folderId}`, { displayName }),
    onSuccess: () => {
      void invalidateFolders();
      setRenamingId(null);
      setRenameValue('');
      toast.success('Ordner umbenannt');
    },
    onError: (e: Error) => toast.error(e.message || 'Konnte nicht umbenennen'),
  });

  const deleteFolder = useMutation({
    mutationFn: (folderId: string) =>
      api.delete(`/user/shared-mailboxes/${id}/folders/${folderId}`),
    onSuccess: () => {
      void invalidateFolders();
      if (selectedFolderId === renamingId) setSelectedFolderId(null);
      toast.success('Ordner gelöscht');
    },
    onError: (e: Error) => toast.error(e.message || 'Konnte nicht löschen'),
  });

  // Auto-select Inbox
  useEffect(() => {
    if (!selectedFolderId && folders.length > 0) {
      const inbox = folders.find((f) => f.name === 'INBOX');
      setSelectedFolderId(inbox?.id ?? folders[0]?.id ?? null);
    }
  }, [folders, selectedFolderId]);

  // ── Messages der gewählten Folder ─────────────────────────────────────────
  const { data: messageList, isLoading: loadingMessages } = useQuery<MessageListResponse>({
    queryKey: ['shared-mailbox-messages', id, selectedFolderId],
    queryFn:  () => api.get(`/user/shared-mailboxes/${id}/folders/${selectedFolderId}/messages?limit=100`),
    enabled:  !!id && !!selectedFolderId,
  });

  // ── Ausgewählte Nachricht (Detail) ────────────────────────────────────────
  const { data: messageDetail, isLoading: loadingMessage } = useQuery<MessageDetail>({
    queryKey: ['shared-mailbox-message', id, selectedMessageId],
    queryFn:  () => api.get(`/user/shared-mailboxes/${id}/messages/${selectedMessageId}`),
    enabled:  !!id && !!selectedMessageId,
  });

  // ── Ordner-Label in der Sprache des Benutzers ─────────────────────────────
  const folderLabel = (folder: Folder): string => {
    const key = SYSTEM_LABEL_KEY[folder.name];
    if (key) return t(key);
    return folder.displayName || folder.name;
  };

  // ── Folder-Sortierung: identisch zur normalen MailPage ────────────────────
  // System-Ordner in SYSTEM_ORDER-Reihenfolge, dann benutzerdefinierte alphabetisch
  const sortedFolders = useMemo(() => {
    const systemFolders = SYSTEM_ORDER
      .map((name) => folders.find((f) => f.name === name))
      .filter((f): f is Folder => f !== undefined);

    const customFolders = [...folders]
      .filter((f) => !(f.name in SYSTEM_ORDER_IDX))
      .sort((a, b) =>
        (a.sortOrder - b.sortOrder) ||
        (a.displayName || a.name).localeCompare(b.displayName || b.name),
      );

    return [...systemFolders, ...customFolders];
  }, [folders]);

  // Zwinge Re-Render bei Sprachwechsel
  void lang;

  // ── Fehler-/Lade-States ───────────────────────────────────────────────────
  if (mailboxError) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <AlertCircle size={36} className="mx-auto text-red-400 mb-2" />
          <p className="text-base font-medium text-gray-800">Postfach nicht erreichbar</p>
          <p className="text-sm text-gray-500 mt-1">{(mailboxError as Error).message}</p>
          <Link to="/mail" className="inline-flex items-center gap-1.5 mt-4 text-sm text-accent hover:underline">
            <ArrowLeft size={14} /> Zurück zu meinem Postfach
          </Link>
        </div>
      </div>
    );
  }

  if (loadingMailbox || !mailbox) {
    return <div className="flex items-center justify-center h-full text-gray-400 text-sm">Lade Postfach…</div>;
  }

  const isReadOnly = !mailbox.permissions.includes('FULL_ACCESS');

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* ── Banner ───────────────────────────────────────────────────────── */}
      <div className="bg-accent/10 border-b border-accent/30 px-4 py-2 flex items-center gap-3 shrink-0">
        <Inbox size={16} className="text-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">
            Du siehst gerade: <span className="text-accent">{mailbox.displayName || mailbox.email}</span>
            <span className="text-gray-500 ml-2">({mailbox.email})</span>
          </p>
          <p className="text-xs text-gray-500">
            {isReadOnly ? 'Nur Lesezugriff' : 'Vollzugriff'} ·
            {mailbox.permissions.map((p) => ` ${p.replace('_', ' ').toLowerCase()}`).join(' ·')}
          </p>
        </div>
        <button
          onClick={() => navigate('/mail')}
          className="flex items-center gap-1.5 px-3 py-1 text-xs text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
        >
          <ArrowLeft size={12} /> Zu meinem Postfach
        </button>
      </div>

      {/* ── 3-Spalten-Layout (Folder / Messages / Reader) ─────────────────── */}
      <div className="flex-1 flex min-h-0">

        {/* ── Folder-Sidebar ────────────────────────────────────────────────── */}
        <aside className="w-52 bg-white border-r border-gray-200 overflow-y-auto shrink-0 flex flex-col">
          {/* "Neuer Ordner"-Button (nur bei Vollzugriff) */}
          {!isReadOnly && (
            <div className="px-3 py-2 border-b border-gray-100 shrink-0">
              {showNewFolder ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newFolderName.trim()) createFolder.mutate(newFolderName.trim());
                      if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName(''); }
                    }}
                    placeholder="Name des Ordners"
                    className="flex-1 min-w-0 text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                  <button type="button"
                    onClick={() => newFolderName.trim() && createFolder.mutate(newFolderName.trim())}
                    disabled={createFolder.isPending || !newFolderName.trim()}
                    className="text-xs text-white bg-accent rounded px-2 py-1 disabled:opacity-50"
                  >OK</button>
                  <button type="button"
                    onClick={() => { setShowNewFolder(false); setNewFolderName(''); }}
                    className="text-gray-400 hover:text-gray-700"
                  ><X size={12} /></button>
                </div>
              ) : (
                <button type="button" onClick={() => setShowNewFolder(true)}
                  className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-600 hover:text-accent hover:bg-accent/5 rounded py-1 border border-dashed border-gray-300 hover:border-accent"
                >
                  <FolderPlus size={12} /> Neuer Ordner
                </button>
              )}
            </div>
          )}

          <nav className="flex-1 overflow-y-auto py-1">
            {loadingFolders ? (
              <p className="text-xs text-gray-400 p-3">Lade Ordner…</p>
            ) : sortedFolders.length === 0 ? (
              <p className="text-xs text-gray-400 p-3">Keine Ordner verfügbar.</p>
            ) : (
              <ul className="space-y-0.5 px-1">
                {sortedFolders.map((f) => {
                  const Icon = ICON_MAP[f.name] ?? FolderIcon;
                  const active = f.id === selectedFolderId;
                  const protectedFolder = PROTECTED_FOLDER_NAMES.has(f.name);
                  const isRenaming = renamingId === f.id;
                  const label = folderLabel(f);

                  return (
                    <li key={f.id} className="group">
                      {isRenaming ? (
                        <div className="flex items-center gap-1 px-2 py-1.5">
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && renameValue.trim())
                                renameFolder.mutate({ folderId: f.id, displayName: renameValue.trim() });
                              if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                            }}
                            className="flex-1 min-w-0 text-xs border border-gray-300 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-accent"
                          />
                          <button type="button"
                            onClick={() => renameValue.trim() && renameFolder.mutate({ folderId: f.id, displayName: renameValue.trim() })}
                            disabled={renameFolder.isPending || !renameValue.trim()}
                            className="text-[10px] text-white bg-accent rounded px-1.5 py-0.5"
                          >OK</button>
                          <button type="button" onClick={() => { setRenamingId(null); setRenameValue(''); }}
                            className="text-gray-400"><X size={11} /></button>
                        </div>
                      ) : (
                        <div className={`relative flex items-center pr-1 rounded-sm transition-all duration-150 ${active ? '' : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
                          {/* aktiver Akzentbalken links */}
                          {active && (
                            <span className="absolute left-0 top-1 bottom-1 w-[3px] bg-accent rounded-r" />
                          )}
                          <button
                            type="button"
                            onClick={() => { setSelectedFolderId(f.id); setSelectedMessageId(null); }}
                            className={`flex-1 min-w-0 text-left flex items-center gap-1.5 pl-2 pr-1 py-1.5 text-sm transition-colors ${
                              active
                                ? 'bg-accent/10 text-accent font-medium'
                                : 'text-gray-700 dark:text-gray-200'
                            }`}
                          >
                            {f.isFavorite && <Star size={11} className="text-amber-400 shrink-0" />}
                            <Icon size={15} className="shrink-0" style={f.color ? { color: f.color } : undefined} />
                            <span className="flex-1 truncate">{label}</span>
                            {f.unreadCount > 0 && (
                              <span className={`text-xs font-bold tabular-nums ${active ? 'text-accent' : 'text-gray-500'}`}>
                                {f.unreadCount}
                              </span>
                            )}
                          </button>
                          {/* Rename/Delete-Buttons (nur Custom-Ordner + Vollzugriff) */}
                          {!isReadOnly && !protectedFolder && (
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                              <button type="button"
                                onClick={() => { setRenamingId(f.id); setRenameValue(f.displayName); }}
                                title="Umbenennen"
                                className="p-1 text-gray-400 hover:text-accent rounded"
                              ><Pencil size={11} /></button>
                              <button type="button"
                                onClick={() => {
                                  if (window.confirm(`Ordner „${label}" löschen? Alle enthaltenen Nachrichten gehen verloren.`))
                                    deleteFolder.mutate(f.id);
                                }}
                                title="Löschen"
                                className="p-1 text-gray-400 hover:text-red-500 rounded"
                              ><Trash2 size={11} /></button>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </nav>
        </aside>

        {/* ── Messages-Liste ──────────────────────────────────────────────────── */}
        <div className="w-80 bg-white border-r border-gray-200 overflow-y-auto shrink-0">
          {loadingMessages ? (
            <p className="text-xs text-gray-400 p-3">Lade Nachrichten…</p>
          ) : !messageList || messageList.messages.length === 0 ? (
            <p className="text-xs text-gray-400 p-6 text-center">
              {selectedFolderId ? 'Keine Nachrichten in diesem Ordner.' : 'Bitte einen Ordner wählen.'}
            </p>
          ) : (
            <>
              <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                {messageList.total.toLocaleString('de-DE')} Nachrichten
                {messageList.total > messageList.messages.length && ` · zeigt ${messageList.messages.length}`}
              </div>
              <ul>
                {messageList.messages.map((m) => {
                  const unread = !m.flags.includes('\\Seen');
                  const active = m.id === selectedMessageId;
                  return (
                    <li key={m.id}>
                      <button type="button" onClick={() => setSelectedMessageId(m.id)}
                        className={`w-full text-left px-3 py-2 border-b border-gray-50 border-l-2 transition-colors ${
                          active ? 'bg-accent/10 border-l-accent' : 'hover:bg-gray-50 border-l-transparent'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-0.5">
                          <span className={`text-xs truncate ${unread ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>
                            {m.fromName || m.fromAddr}
                          </span>
                          <span className="text-[10px] text-gray-400 shrink-0">{fmtDate(m.date).slice(0, 10)}</span>
                        </div>
                        <p className={`text-sm truncate ${unread ? 'text-gray-900 font-medium' : 'text-gray-700'}`}>
                          {m.subject || '(kein Betreff)'}
                        </p>
                        {m.bodyText && (
                          <p className="text-[11px] text-gray-400 truncate mt-0.5">{m.bodyText.slice(0, 90)}</p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {/* ── Reader-Pane ─────────────────────────────────────────────────────── */}
        <div className="flex-1 bg-white overflow-y-auto">
          {loadingMessage ? (
            <p className="text-xs text-gray-400 p-6 text-center">Lade Nachricht…</p>
          ) : !messageDetail ? (
            <div className="h-full flex items-center justify-center text-gray-400">
              <div className="text-center">
                <Inbox size={32} className="mx-auto text-gray-300 mb-2" />
                <p className="text-sm">Nachricht zum Lesen auswählen.</p>
              </div>
            </div>
          ) : (
            <article className="p-6 max-w-3xl">
              <header className="border-b border-gray-200 pb-4 mb-4">
                <h2 className="text-lg font-semibold text-gray-900">{messageDetail.subject || '(kein Betreff)'}</h2>
                <div className="text-xs text-gray-500 mt-2 space-y-0.5">
                  <p><span className="text-gray-400">Von:</span> {messageDetail.fromName ? `${messageDetail.fromName} <${messageDetail.fromAddr}>` : messageDetail.fromAddr}</p>
                  <p><span className="text-gray-400">An:</span> {messageDetail.toAddrs.join(', ')}</p>
                  <p><span className="text-gray-400">Datum:</span> {fmtDate(messageDetail.date)}</p>
                  <p><span className="text-gray-400">Ordner:</span> {folderLabel({ ...messageDetail.folder, parentId: null, totalCount: 0, unreadCount: 0, isFavorite: false, sortOrder: 0, color: null })}</p>
                </div>
                {messageDetail.attachments.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {messageDetail.attachments.map((a) => (
                      <span key={a.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-xs text-gray-700 rounded">
                        <Paperclip size={10} /> {a.filename} <span className="text-gray-400">({fmtBytes(a.size)})</span>
                      </span>
                    ))}
                  </div>
                )}
              </header>
              {messageDetail.bodyHtml ? (
                <div
                  className="prose prose-sm max-w-none text-gray-800"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: messageDetail.bodyHtml }}
                />
              ) : (
                <pre className="whitespace-pre-wrap text-sm text-gray-800 font-sans">{messageDetail.bodyText}</pre>
              )}
              {isReadOnly && (
                <div className="mt-6 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                  Du hast nur Lesezugriff auf dieses Postfach. Antworten oder Verschieben ist nicht möglich.
                </div>
              )}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
