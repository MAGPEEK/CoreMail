import { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDraggable } from '@dnd-kit/core';
import {
  Paperclip, Pin, Archive, Trash2, Mail, MailOpen, Flag, FlagOff,
  Forward, Reply, ReplyAll, AlertOctagon, Clock, FolderInput, ShieldOff, Download, Code, Tag,
  Search, X,
} from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { api } from '../api/client.js';
import type { MessagesResponse, MessageSummary, Folder, Category } from '../api/types.js';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { useAuthStore } from '../store/auth.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { showUndoToast } from './UndoToast.js';
import { Avatar } from './Avatar.js';
import { ContactHoverCard } from './ContactHoverCard.js';
import { AnimatedCounter } from './AnimatedCounter.js';
import { MessageListSkeleton, EmptyInbox, EmptySearch } from './Skeleton.js';

interface Props {
  folderId: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return 'Gestern';
  return format(d, 'dd.MM.yyyy');
}

interface MenuState { x: number; y: number; items: ContextMenuItem[] }

function MessageRow({
  msg,
  selected,
  checked,
  onClick,
  onToggleCheck,
  onContextMenu,
  onQuickAction,
  density,
  folders,
}: {
  msg: MessageSummary;
  selected: boolean;
  checked: boolean;
  onClick: (e: React.MouseEvent) => void;
  onToggleCheck: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onQuickAction: (action: 'archive' | 'delete' | 'read' | 'flag') => void;
  density: 'compact' | 'normal' | 'comfortable';
  folders: Folder[];
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `msg:${msg.id}`,
    data: { kind: 'message', messageId: msg.id, folderId: msg.id /* fallback */ },
  });

  const avatarRef = useRef<HTMLDivElement>(null);
  const [showCard, setShowCard] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isUnread = !msg.flags.includes('\\Seen');
  const isFlagged = msg.flags.includes('\\Flagged');
  const isReplied = msg.flags.includes('\\Answered');
  const hasAttachments = msg.attachments.length > 0;
  const isPinned = !!msg.pinnedAt;
  const isSnoozed = msg.snoozeUntil && new Date(msg.snoozeUntil) > new Date();

  const py = density === 'compact' ? 'py-1.5' : density === 'comfortable' ? 'py-3.5' : 'py-2.5';

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`w-full text-left px-3 ${py} border-b border-gray-100 dark:border-gray-700 transition-all duration-150 relative group cursor-pointer ${
        selected
          ? 'bg-accent/10 shadow-sm'
          : checked
            ? 'bg-accent/5'
            : 'hover:bg-gray-50 dark:hover:bg-gray-800 hover:shadow-sm'
      } ${isUnread ? 'border-l-2 border-l-accent' : 'border-l-2 border-l-transparent'} ${isDragging ? 'opacity-30' : ''}`}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-center gap-2.5">
        {/* Checkbox / Unread-Dot */}
        <button
          onClick={onToggleCheck}
          className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 transition-all duration-150 ${
            checked
              ? 'bg-accent border-accent text-white animate-bounce-in'
              : 'border-gray-300 dark:border-gray-600 opacity-0 group-hover:opacity-100 hover:border-accent hover:scale-110'
          }`}
          aria-label="Auswählen"
        >
          {checked && <span className="text-[10px] leading-none">✓</span>}
        </button>

        {/* Flag-Icon (immer sichtbar; klickbar) */}
        <button
          onClick={(e) => { e.stopPropagation(); onQuickAction('flag'); }}
          className="shrink-0 transition-transform duration-150 hover:scale-125 active:scale-95"
          aria-label="Kennzeichnen"
        >
          {isFlagged
            ? <Flag size={14} className="fill-red-500 text-red-500" />
            : <Flag size={14} className="text-gray-300 dark:text-gray-600 hover:text-red-400 transition-colors" />}
        </button>

        {/* Avatar mit hash-basierter Farbe */}
        <div
          ref={avatarRef}
          onMouseEnter={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => setShowCard(true), 350); }}
          onMouseLeave={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => setShowCard(false), 200); }}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 cursor-default"
        >
          <Avatar seed={msg.fromAddr} size="sm" className="transition-transform duration-150 group-hover:scale-105" />
        </div>
        {showCard && (
          <ContactHoverCard email={msg.fromAddr} anchorRef={avatarRef} onClose={() => setShowCard(false)} />
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-sm truncate flex items-center gap-1 ${isUnread ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}`}>
              {isUnread && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft shrink-0" />
              )}
              {isPinned && <Pin size={11} className="text-accent shrink-0" />}
              <span className="truncate">{msg.fromAddr}</span>
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {isReplied && <span title="Beantwortet"><Reply size={12} className="text-blue-500" /></span>}
              {hasAttachments && <Paperclip size={12} className="text-gray-400" />}
              {isSnoozed && <Clock size={12} className="text-amber-500" />}
              <span className="text-xs text-gray-400 transition-opacity duration-150 group-hover:opacity-0">{formatDate(msg.date)}</span>
            </div>
          </div>
          <p className={`text-sm truncate mt-0.5 transition-colors duration-150 ${
            isUnread ? 'font-medium text-gray-800 dark:text-gray-200' : 'text-gray-600 dark:text-gray-400'
          } group-hover:text-accent group-hover:underline group-hover:underline-offset-2`}>
            {msg.subject || '(kein Betreff)'}
          </p>
          {msg.categories && msg.categories.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {msg.categories.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                  style={{ backgroundColor: `${c.color}22`, color: c.color, border: `1px solid ${c.color}55` }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: c.color }} />
                  {c.name}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Hover-Quick-Actions (Gmail-Style) — fade-in mit slight slide */}
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-md opacity-0 translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-150 pointer-events-none group-hover:pointer-events-auto">
          <button
            onClick={(e) => { e.stopPropagation(); onQuickAction('archive'); }}
            className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors active:scale-90"
            title="Archivieren"
          >
            <Archive size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onQuickAction('delete'); }}
            className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/30 text-gray-600 dark:text-gray-300 hover:text-red-600 transition-colors active:scale-90"
            title="Löschen"
          >
            <Trash2 size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onQuickAction('read'); }}
            className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors active:scale-90"
            title={isUnread ? 'Als gelesen markieren' : 'Als ungelesen markieren'}
          >
            {isUnread ? <MailOpen size={13} /> : <Mail size={13} />}
          </button>
        </div>
      </div>
      {/* Hint: folders prop intentionally unused here — used in context menu via parent */}
      <span className="hidden">{folders.length}</span>
    </div>
  );
}

export function MessageList({ folderId }: Props) {
  const qc = useQueryClient();
  const { selectedMessageId, setSelectedMessage, selectedIds, toggleSelection, selectAll, clearSelection, filter, setFilter, openCompose } = useUiStore();
  const { density } = useUiPrefs();
  const { accessToken } = useAuthStore();
  const tokenParam = accessToken ? `?token=${encodeURIComponent(accessToken)}` : '';
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchScope, setSearchScope] = useState<'folder' | 'all'>('folder');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['messages', folderId],
    queryFn: () => api.get<MessagesResponse>(`/mail/folders/${folderId}/messages?limit=100`),
    enabled: !!folderId,
  });

  const { data: folders = [] } = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<Folder[]>('/mail/folders'),
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
  });

  const { data: allMessages } = useQuery({
    queryKey: ['messages-search', searchText],
    queryFn: () => api.get<MessagesResponse>(`/mail/folders/search?q=${encodeURIComponent(searchText)}&limit=50`),
    enabled: searchScope === 'all' && searchText.length >= 2,
    staleTime: 10_000,
  });

  const currentFolder = folders.find((f) => f.id === folderId);
  const isJunkFolder = currentFolder?.name === 'Junk';
  const isTrashFolder = currentFolder?.name === 'Trash';

  // Filter anwenden
  const filtered = useMemo(() => {
    const list = data?.messages ?? [];
    if (filter === 'unread')       return list.filter((m) => !m.flags.includes('\\Seen'));
    if (filter === 'flagged')      return list.filter((m) => m.flags.includes('\\Flagged'));
    if (filter === 'attachments')  return list.filter((m) => m.attachments.length > 0);
    return list;
  }, [data, filter]);

  const displayMessages = useMemo(() => {
    if (searchText.length < 2) return filtered;
    const q = searchText.toLowerCase();
    const source = searchScope === 'all' ? (allMessages?.messages ?? []) : filtered;
    return source.filter((m) =>
      m.subject.toLowerCase().includes(q) ||
      m.fromAddr.toLowerCase().includes(q) ||
      (m.fromName ?? '').toLowerCase().includes(q)
    );
  }, [searchText, searchScope, filtered, allMessages]);

  const suggestions = useMemo(() => {
    if (searchText.length < 2) return [];
    const q = searchText.toLowerCase();
    return (data?.messages ?? [])
      .filter((m) => m.subject.toLowerCase().includes(q) || m.fromAddr.toLowerCase().includes(q))
      .slice(0, 5);
  }, [searchText, data]);

  const orderedIds = useMemo(() => displayMessages.map((m) => m.id), [displayMessages]);
  const allChecked = orderedIds.length > 0 && orderedIds.every((id) => selectedIds.has(id));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['messages'] });
    qc.invalidateQueries({ queryKey: ['folders'] });
  };

  const bulkMutation = useMutation({
    mutationFn: (body: { ids: string[]; action: string; folderId?: string }) =>
      api.post('/mail/messages/bulk', body),
    onSuccess: invalidate,
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/mail/messages/${id}`, body),
    onSuccess: invalidate,
  });

  const quickAction = (msg: MessageSummary, action: 'archive' | 'delete' | 'read' | 'flag') => {
    const isUnread = !msg.flags.includes('\\Seen');
    const isFlagged = msg.flags.includes('\\Flagged');
    const prevFolderId = folderId;

    if (action === 'archive') {
      bulkMutation.mutate({ ids: [msg.id], action: 'archive' });
      showUndoToast({
        message: 'Nachricht archiviert',
        onUndo: () => bulkMutation.mutateAsync({ ids: [msg.id], action: 'move', folderId: prevFolderId }),
      });
      if (msg.id === selectedMessageId) setSelectedMessage(null);
    } else if (action === 'delete') {
      bulkMutation.mutate({ ids: [msg.id], action: 'delete' });
      const trash = folders.find((f) => f.name === 'Trash');
      if (!isTrashFolder && trash) {
        showUndoToast({
          message: 'Nachricht in den Papierkorb verschoben',
          onUndo: () => bulkMutation.mutateAsync({ ids: [msg.id], action: 'move', folderId: prevFolderId }),
        });
      }
      if (msg.id === selectedMessageId) setSelectedMessage(null);
    } else if (action === 'read') {
      patchMutation.mutate({ id: msg.id, body: { read: isUnread } });
    } else if (action === 'flag') {
      patchMutation.mutate({ id: msg.id, body: { flagged: !isFlagged } });
    }
  };

  const buildMessageMenu = (msg: MessageSummary): ContextMenuItem[] => {
    const isUnread = !msg.flags.includes('\\Seen');
    const isFlagged = msg.flags.includes('\\Flagged');
    const isPinned = !!msg.pinnedAt;
    const isSnoozed = !!(msg.snoozeUntil && new Date(msg.snoozeUntil) > new Date());

    const moveTargets: ContextMenuItem[] = folders
      .filter((f) => f.id !== folderId)
      .map((f) => ({
        label: f.displayName ?? f.name,
        icon: <FolderInput size={14} style={f.color ? { color: f.color } : undefined} />,
        onClick: () => {
          bulkMutation.mutate({ ids: [msg.id], action: 'move', folderId: f.id });
          if (msg.id === selectedMessageId) setSelectedMessage(null);
        },
      }));

    const snoozeOptions = (): ContextMenuItem[] => {
      const now = new Date();
      const inHours = (h: number) => { const d = new Date(now); d.setHours(d.getHours() + h); return d; };
      const tomorrow8 = () => { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d; };
      const nextMonday = () => {
        const d = new Date(now); d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7)); d.setHours(8, 0, 0, 0); return d;
      };
      const snooze = (until: Date) =>
        api.post(`/mail/messages/${msg.id}/snooze`, { until: until.toISOString() }).then(invalidate);
      return [
        { label: 'In 1 Stunde',     onClick: () => void snooze(inHours(1)) },
        { label: 'In 3 Stunden',    onClick: () => void snooze(inHours(3)) },
        { label: 'Morgen 8:00',     onClick: () => void snooze(tomorrow8()) },
        { label: 'Nächsten Montag', onClick: () => void snooze(nextMonday()) },
      ];
    };

    return [
      { label: 'Öffnen',           icon: <Mail size={14} />,    onClick: () => setSelectedMessage(msg.id) },
      { type: 'divider' },
      { label: 'Antworten',        icon: <Reply size={14} />,   onClick: () => openCompose({ mode: 'reply', id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr }) },
      { label: 'Allen antworten',  icon: <ReplyAll size={14} />,onClick: () => openCompose({ mode: 'replyAll', id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr, toAddrs: msg.toAddrs }) },
      { label: 'Weiterleiten',     icon: <Forward size={14} />, onClick: () => openCompose({ mode: 'forward', id: msg.id, subject: msg.subject }) },
      { type: 'divider' },
      { label: isUnread ? 'Als gelesen markieren' : 'Als ungelesen markieren',
        icon: isUnread ? <MailOpen size={14} /> : <Mail size={14} />,
        onClick: () => patchMutation.mutate({ id: msg.id, body: { read: isUnread } }) },
      { label: isFlagged ? 'Kennzeichnung aufheben' : 'Kennzeichnen',
        icon: isFlagged ? <FlagOff size={14} /> : <Flag size={14} />,
        onClick: () => patchMutation.mutate({ id: msg.id, body: { flagged: !isFlagged } }) },
      { label: isPinned ? 'Lösen' : 'Anheften',
        icon: <Pin size={14} />,
        onClick: () => bulkMutation.mutate({ ids: [msg.id], action: isPinned ? 'unpin' : 'pin' }) },
      // Kategorien-Submenu
      categories.length > 0
        ? {
            label: 'Kategorisieren',
            icon: <Tag size={14} />,
            children: categories.map((c) => {
              const assigned = (msg.categories ?? []).some((mc) => mc.id === c.id);
              return {
                label: c.name,
                icon: <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: c.color }} />,
                onClick: async () => {
                  const next = assigned
                    ? (msg.categories ?? []).filter((mc) => mc.id !== c.id).map((mc) => mc.id)
                    : [...(msg.categories ?? []).map((mc) => mc.id), c.id];
                  await api.post(`/categories/messages/${msg.id}`, { categoryIds: next });
                  invalidate();
                },
                ...(assigned ? { separator: 'after' as const } : {}),
              };
            }),
          }
        : {
            label: 'Kategorien anlegen …',
            icon: <Tag size={14} />,
            onClick: () => { window.location.href = '/settings'; },
          },
      { label: isSnoozed ? 'Schlummer aufheben' : 'Schlummern bis …',
        icon: <Clock size={14} />,
        ...(isSnoozed
          ? { onClick: () => api.delete(`/mail/messages/${msg.id}/snooze`).then(invalidate).catch(() => undefined) }
          : { children: snoozeOptions() }),
      },
      { type: 'divider' },
      { label: 'Archivieren', icon: <Archive size={14} />, onClick: () => quickAction(msg, 'archive') },
      { label: 'Verschieben nach …', icon: <FolderInput size={14} />, children: moveTargets },
      isJunkFolder
        ? { label: 'Kein Junk', icon: <ShieldOff size={14} />, onClick: () => bulkMutation.mutate({ ids: [msg.id], action: 'notSpam' }) }
        : { label: 'Als Junk markieren', icon: <AlertOctagon size={14} />, onClick: () => bulkMutation.mutate({ ids: [msg.id], action: 'spam' }) },
      { label: 'Löschen', icon: <Trash2 size={14} />, danger: true, onClick: () => quickAction(msg, 'delete') },
      { type: 'divider' },
      { label: 'Quelltext anzeigen', icon: <Code size={14} />,
        onClick: () => window.open(`/api/v1/mail/messages/${msg.id}/raw${tokenParam}`, '_blank') },
      { label: 'Als EML herunterladen', icon: <Download size={14} />,
        onClick: () => {
          const a = document.createElement('a');
          a.href = `/api/v1/mail/messages/${msg.id}/raw${tokenParam}`;
          a.download = `${msg.subject || 'message'}.eml`;
          a.click();
        } },
    ];
  };

  const handleRowClick = (msg: MessageSummary) => (e: React.MouseEvent) => {
    // Shift = Bereichsauswahl, Ctrl/Cmd = einzeln toggle, sonst öffnen
    if (e.shiftKey) {
      toggleSelection(msg.id, { range: true, orderedIds });
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      toggleSelection(msg.id);
      return;
    }
    clearSelection();
    setSelectedMessage(msg.id);
  };

  const handleContextMenu = (msg: MessageSummary) => (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: buildMessageMenu(msg) });
  };

  if (isLoading) {
    return (
      <div className="w-full h-full border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700 h-9" />
        <MessageListSkeleton rows={8} />
      </div>
    );
  }

  const FilterTab = ({ value, label }: { value: typeof filter; label: string }) => (
    <button
      onClick={() => setFilter(value)}
      className={`px-3 py-1 text-xs rounded-full transition-colors ${
        filter === value
          ? 'bg-accent text-white'
          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="w-full h-full border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col overflow-hidden">
      {/* Search row */}
      <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2 relative">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            className="w-full pl-7 pr-3 py-1 text-xs rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 outline-none focus:border-accent dark:text-gray-100"
            placeholder="Suchen…"
          />
          {searchText && (
            <button onClick={() => setSearchText('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X size={12} />
            </button>
          )}
          {/* Typeahead suggestions */}
          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-50 max-h-40 overflow-y-auto">
              {suggestions.map((m) => (
                <button key={m.id}
                  onMouseDown={() => { setSelectedMessage(m.id); setSearchText(''); setShowSuggestions(false); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-50 dark:border-gray-700 last:border-0">
                  <p className="font-medium text-gray-800 dark:text-gray-200 truncate">{m.subject || '(kein Betreff)'}</p>
                  <p className="text-gray-400 truncate">{m.fromAddr}</p>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Scope toggle */}
        <div className="flex text-[10px] rounded border border-gray-200 dark:border-gray-600 overflow-hidden shrink-0">
          <button
            onClick={() => setSearchScope('folder')}
            className={`px-1.5 py-1 ${searchScope === 'folder' ? 'bg-accent text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
            title="Diesen Ordner durchsuchen"
          >Ordner</button>
          <button
            onClick={() => setSearchScope('all')}
            className={`px-1.5 py-1 ${searchScope === 'all' ? 'bg-accent text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
            title="Gesamtes Postfach durchsuchen"
          >Alle</button>
        </div>
      </div>
      <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2">
        <input
          type="checkbox"
          checked={allChecked}
          onChange={() => (allChecked ? clearSelection() : selectAll(orderedIds))}
          className="rounded border-gray-300 dark:border-gray-600 text-accent focus:ring-accent"
          title="Alle auswählen"
        />
        <FilterTab value="all" label="Alle" />
        <FilterTab value="unread" label="Ungelesen" />
        <FilterTab value="flagged" label="Markiert" />
        <FilterTab value="attachments" label="Anhang" />
        <span className="ml-auto text-xs text-gray-500">
          <AnimatedCounter value={displayMessages.length} />
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {displayMessages.length === 0 ? (
          filter === 'all' && !searchText ? <EmptyInbox /> : <EmptySearch />
        ) : (
          displayMessages.map((msg) => (
            <MessageRow
              key={msg.id}
              msg={msg}
              selected={msg.id === selectedMessageId && selectedIds.size === 0}
              checked={selectedIds.has(msg.id)}
              onClick={handleRowClick(msg)}
              onToggleCheck={(e) => { e.stopPropagation(); toggleSelection(msg.id); }}
              onContextMenu={handleContextMenu(msg)}
              onQuickAction={(a) => quickAction(msg, a)}
              density={density}
              folders={folders}
            />
          ))
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
