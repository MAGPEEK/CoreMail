import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useDraggable } from '@dnd-kit/core';
import {
  Paperclip, Pin, Archive, Trash2, Mail, MailOpen, Flag, FlagOff,
  Forward, Reply, ReplyAll, AlertOctagon, Clock, FolderInput, ShieldOff, Download, Code, Tag,
  Search, X, ListFilter, Settings, ShieldAlert, CalendarClock,
} from 'lucide-react';
import { RuleEditorModal } from './RuleEditorModal.js';
import type { RulePreset } from '../api/rule-types.js';
import { format, isToday, isYesterday } from 'date-fns';
import { api, downloadFile, fetchText } from '../api/client.js';
import type { MessagesResponse, MessageSummary, MessageFilter, Folder, Category } from '../api/types.js';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { nextPageOffset, flattenPages, pageQuery } from '../lib/paging.js';
import { toastError } from '../lib/errors.js';
import { Modal } from './Modal.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { Avatar } from './Avatar.js';
import { ContactHoverCard } from './ContactHoverCard.js';
import { AnimatedCounter } from './AnimatedCounter.js';
import { MessageListSkeleton, EmptyInbox, EmptySearch, EmptyFilter } from './Skeleton.js';
import { MoveToFolderDialog } from './MoveToFolderDialog.js';
import { SearchOperatorsHelp, SearchChips } from './SearchOperatorsHelp.js';
import { useMailActions } from '../hooks/useMailActions.js';
import { useShortcutHandlers, useAriaKeys } from '../hooks/useShortcuts.js';
import type { MessageLocation } from '../lib/undo-stack.js';

import { useT } from '../i18n/useT.js';

/** Subject without reply/forward prefixes — groups a conversation for n/p. */
function conversationKey(subject: string): string {
  return subject.replace(/^\s*((re|aw|fwd?|wg|tr|rv|r)\s*(\[\d+\])?\s*:\s*)+/i, '').trim().toLowerCase();
}

/** True when the query uses search operators / quotes / negation (typeahead stays for plain words). */
function hasOperatorSyntax(q: string): boolean {
  return /(^|\s)-\S|"|\b[a-z_]+:/i.test(q);
}

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
  const ariaKeys = useAriaKeys();

  const isUnread = !msg.flags.includes('\\Seen');
  const isFlagged = msg.flags.includes('\\Flagged');
  const isReplied = msg.flags.includes('\\Answered');
  const hasAttachments = msg.attachments.length > 0;
  const isPinned = !!msg.pinnedAt;
  const isSnoozed = msg.snoozeUntil && new Date(msg.snoozeUntil) > new Date();
  // v3.18.6: Spam indicator — rspamd score ≥ 3.0 (junk threshold)
  const spamScore = (msg.spamScore ?? null);
  const isSpam = spamScore !== null && spamScore >= 3.0;
  const isHighRiskSpam = spamScore !== null && spamScore >= 6.0;
  // v3.18.7: Scheduled send (Outlook-style "Will be sent on…")
  const isScheduledPending = msg.scheduledStatus === 'PENDING' && !!msg.scheduledAt;

  const py = density === 'compact' ? 'py-1.5' : density === 'comfortable' ? 'py-3.5' : 'py-2.5';

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      id={`msg-row-${msg.id}`}
      onClick={onClick}
      onKeyDown={(e) => {
        // role="button": Enter opens the row like a click (shortcut manager leaves it alone)
        if (e.key === 'Enter' && e.target === e.currentTarget) onClick(e as unknown as React.MouseEvent);
      }}
      onContextMenu={onContextMenu}
      aria-current={selected ? 'true' : undefined}
      className={`w-full text-left px-3 ${py} border-b border-line transition-all duration-150 relative group cursor-pointer ${
        selected
          ? 'bg-accent/10 shadow-sm'
          : checked
            ? 'bg-accent/5'
            : 'hover:bg-surface-2 hover:shadow-sm'
      } ${isUnread ? 'border-l-2 border-l-accent-fg' : 'border-l-2 border-l-transparent'} ${isDragging ? 'opacity-30' : ''}`}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-center gap-2.5">
        {/* Checkbox / Unread-Dot */}
        <button
          onClick={onToggleCheck}
          className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 transition-all duration-150 ${
            checked
              ? 'bg-accent border-accent-fg text-white animate-bounce-in'
              : 'border-line-strong opacity-0 group-hover:opacity-100 hover:border-accent-fg hover:scale-110'
          }`}
          aria-label="Auswählen"
        >
          {checked && <span className="text-[10px] leading-none">✓</span>}
        </button>

        {/* Flag icon (always visible; clickable) */}
        <button
          onClick={(e) => { e.stopPropagation(); onQuickAction('flag'); }}
          className="shrink-0 transition-transform duration-150 hover:scale-125 active:scale-95"
          aria-label="Kennzeichnen"
        >
          {isFlagged
            ? <Flag size={14} className="fill-danger-fg text-danger-fg" />
            : <Flag size={14} className="text-fg-subtle hover:text-danger-fg transition-colors" />}
        </button>

        {/* Avatar with hash-based color */}
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
            <span className={`text-sm truncate flex items-center gap-1 ${isUnread ? 'font-semibold text-fg' : 'text-fg-muted'}`}>
              {isUnread && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft shrink-0" />
              )}
              {isPinned && <Pin size={11} className="text-accent-fg shrink-0" />}
              <span className="truncate">{msg.fromAddr}</span>
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {isReplied && <span title="Beantwortet"><Reply size={12} className="text-info-fg" /></span>}
              {isSpam && (
                <span title={`Als Spam erkannt (rspamd-Score: ${spamScore?.toFixed(2)})`}>
                  <ShieldAlert size={12} className={isHighRiskSpam ? 'text-danger-fg' : 'text-warning-fg'} />
                </span>
              )}
              {isScheduledPending && (
                <span title={`Wird gesendet am ${msg.scheduledAt ? new Date(msg.scheduledAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : ''}`}>
                  <CalendarClock size={12} className="text-info-fg" />
                </span>
              )}
              {hasAttachments && <Paperclip size={12} className="text-fg-subtle" />}
              {isSnoozed && <Clock size={12} className="text-warning-fg" />}
              <span className="text-xs text-fg-subtle transition-opacity duration-150 group-hover:opacity-0">{formatDate(msg.date)}</span>
            </div>
          </div>
          <p className={`text-sm truncate mt-0.5 transition-colors duration-150 ${
            isUnread ? 'font-medium text-fg' : 'text-fg-muted'
          } group-hover:text-accent-fg group-hover:underline group-hover:underline-offset-2`}>
            {msg.subject || '(kein Betreff)'}
          </p>
          {msg.categories && msg.categories.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {msg.categories.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-fg"
                  style={{ backgroundColor: `${c.color}22`, border: `1px solid ${c.color}55` }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: c.color }} />
                  {c.name}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Hover quick actions (Gmail style) — fade-in with slight slide */}
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-surface border border-line rounded shadow-md opacity-0 translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-150 pointer-events-none group-hover:pointer-events-auto">
          <button aria-label="Archivieren"
            aria-keyshortcuts={ariaKeys('mail.archive')}
            onClick={(e) => { e.stopPropagation(); onQuickAction('archive'); }}
            className="p-1.5 hover:bg-surface-2 text-fg-muted transition-colors active:scale-90"
            title="Archivieren"
          >
            <Archive size={13} />
          </button>
          <button aria-label="Löschen"
            aria-keyshortcuts={ariaKeys('mail.delete')}
            onClick={(e) => { e.stopPropagation(); onQuickAction('delete'); }}
            className="p-1.5 hover:bg-danger-bg text-fg-muted hover:text-danger-fg transition-colors active:scale-90"
            title="Löschen"
          >
            <Trash2 size={13} />
          </button>
          <button aria-label={isUnread ? 'Als gelesen markieren' : 'Als ungelesen markieren'}
            onClick={(e) => { e.stopPropagation(); onQuickAction('read'); }}
            className="p-1.5 hover:bg-surface-2 text-fg-muted transition-colors active:scale-90"
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

function FilterTab({ value, label, active, onSelect }: {
  value: MessageFilter;
  label: string;
  active: boolean;
  onSelect: (v: MessageFilter) => void;
}) {
  return (
    <button
      onClick={() => onSelect(value)}
      aria-pressed={active}
      className={`px-3 py-1 text-xs rounded-full transition-colors ${
        active
          ? 'bg-accent text-white'
          : 'text-fg-muted hover:bg-surface-2'
      }`}
    >
      {label}
    </button>
  );
}

/** Debounces a value (search input → server query). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function MessageList({ folderId }: Props) {
  const qc = useQueryClient();
  const { selectedMessageId, setSelectedMessage, selectedIds, toggleSelection, selectAll, clearSelection, filter, setFilter, openCompose } = useUiStore();
  const { density } = useUiPrefs();
  const t = useT();
  const { runWithUndo, deletePermanently, setState } = useMailActions();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [moveTargets, setMoveTargets] = useState<MessageLocation[] | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchText, setSearchText] = useState('');
  const [searchScope, setSearchScope] = useState<'folder' | 'all'>('folder');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [rawModal, setRawModal] = useState<{ text: string; subject: string; msgId: string } | null>(null);
  const [ruleEditor, setRuleEditor] = useState<{ open: boolean; preset?: RulePreset }>({ open: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Global search from the TopBar navigates to /mail?q=… → run it as a mailbox-wide search
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const urlQuery = searchParams.get('q');
  useEffect(() => {
    if (urlQuery === null) return;
    setSearchText(urlQuery);
    setSearchScope('all');
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    setSearchParams(next, { replace: true });
  }, [urlQuery, searchParams, setSearchParams]);

  const debouncedSearch = useDebounced(searchText.trim(), 300);
  const searching = debouncedSearch.length >= 2;

  // Folder listing — paged via ?limit=&offset= (infinite scroll)
  const listQuery = useInfiniteQuery({
    queryKey: ['messages', folderId],
    queryFn: ({ pageParam }) =>
      api.get<MessagesResponse>(`/mail/folders/${folderId}/messages?${pageQuery(pageParam)}`),
    initialPageParam: 0,
    getNextPageParam: nextPageOffset,
    enabled: !!folderId,
  });

  // Server search — scope "folder" passes folderId, scope "all" searches the whole mailbox.
  // Results are shown as returned by the server (no client-side re-filtering).
  const searchQuery = useInfiniteQuery({
    queryKey: ['messages', 'search', searchScope, searchScope === 'folder' ? folderId : null, debouncedSearch],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ q: debouncedSearch });
      if (searchScope === 'folder') params.set('folderId', folderId);
      return api.get<MessagesResponse>(`/mail/search?${params.toString()}&${pageQuery(pageParam)}`);
    },
    initialPageParam: 0,
    getNextPageParam: nextPageOffset,
    enabled: searching && (searchScope === 'all' || !!folderId),
    staleTime: 10_000,
  });

  const activeQuery = searching ? searchQuery : listQuery;
  const isLoading = activeQuery.isLoading;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = activeQuery;
  const totalCount = activeQuery.data?.pages[0]?.total ?? 0;

  const { data: folders = [] } = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<Folder[]>('/mail/folders'),
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
  });

  const currentFolder = folders.find((f) => f.id === folderId);
  const isJunkFolder = currentFolder?.name === 'Junk';

  const listMessages = useMemo(() => flattenPages(listQuery.data?.pages), [listQuery.data]);
  const searchMessages = useMemo(() => flattenPages(searchQuery.data?.pages), [searchQuery.data]);

  // Quick filter tabs (unread/flagged/attachments) apply to the loaded rows
  const displayMessages = useMemo(() => {
    const list = searching ? searchMessages : listMessages;
    if (filter === 'unread')       return list.filter((m) => !m.flags.includes('\\Seen'));
    if (filter === 'flagged')      return list.filter((m) => m.flags.includes('\\Flagged'));
    if (filter === 'attachments')  return list.filter((m) => m.attachments.length > 0);
    return list;
  }, [searching, searchMessages, listMessages, filter]);

  // Typeahead: quick local hints from the already loaded folder page
  const suggestions = useMemo(() => {
    if (searchText.length < 2) return [];
    const q = searchText.toLowerCase();
    return listMessages
      .filter((m) => m.subject.toLowerCase().includes(q) || m.fromAddr.toLowerCase().includes(q))
      .slice(0, 5);
  }, [searchText, listMessages]);

  // Infinite scroll: load the next page when the sentinel at the end becomes visible
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { root, rootMargin: '200px' });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, displayMessages.length]);

  const orderedIds = useMemo(() => displayMessages.map((m) => m.id), [displayMessages]);
  const allChecked = orderedIds.length > 0 && orderedIds.every((id) => selectedIds.has(id));

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['messages'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
  };

  // Errors are reported by the global MutationCache handler (main.tsx)
  const bulkMutation = useMutation({
    mutationFn: (body: { ids: string[]; action: string; folderId?: string }) =>
      api.post('/mail/messages/bulk', body),
    onSettled: invalidate,
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/mail/messages/${id}`, body),
    onSettled: invalidate,
  });

  // ── Targets + undoable actions (shared with the keyboard shortcuts) ─────────
  const locate = (id: string): MessageLocation => ({
    id, folderId: displayMessages.find((m) => m.id === id)?.folderId ?? folderId,
  });
  /** Checked messages, else the open one. */
  const currentTargets = (): MessageLocation[] => {
    const ids = useUiStore.getState().selectedIds.size > 0
      ? [...useUiStore.getState().selectedIds]
      : selectedMessageId ? [selectedMessageId] : [];
    return ids.map(locate);
  };

  /** OWA: after the open mail leaves the list, the next one opens. */
  const selectAfterRemoval = (removed: string[]) => {
    const gone = new Set(removed);
    if (selectedMessageId && gone.has(selectedMessageId)) {
      const idx = orderedIds.indexOf(selectedMessageId);
      const next = orderedIds.slice(idx + 1).find((id) => !gone.has(id))
        ?? orderedIds.slice(0, Math.max(idx, 0)).reverse().find((id) => !gone.has(id))
        ?? null;
      setSelectedMessage(next);
    }
    clearSelection();
  };

  const undoable = (action: 'delete' | 'archive' | 'spam' | 'move', items: MessageLocation[], target?: string) => {
    if (items.length === 0) return false;
    void runWithUndo(action, items, target).then((done) => { if (done) selectAfterRemoval(items.map((i) => i.id)); });
    return true;
  };

  const scrollToRow = (id: string) => {
    document.getElementById(`msg-row-${id}`)?.scrollIntoView({ block: 'nearest' });
  };
  const openAt = (id: string | undefined) => {
    if (!id) return false;
    clearSelection();
    setSelectedMessage(id);
    scrollToRow(id);
    return true;
  };
  const stepConversation = (dir: 1 | -1) => {
    const cur = displayMessages.find((m) => m.id === selectedMessageId);
    if (!cur) return false;
    const key = conversationKey(cur.subject);
    const idx = orderedIds.indexOf(cur.id);
    const range = dir === 1 ? displayMessages.slice(idx + 1) : displayMessages.slice(0, idx).reverse();
    return openAt(range.find((m) => conversationKey(m.subject) === key)?.id);
  };
  const replyTo = (mode: 'reply' | 'replyAll' | 'forward') => {
    const msg = displayMessages.find((m) => m.id === selectedMessageId);
    if (!msg) return false;
    openCompose({ mode, id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr, ...(mode === 'replyAll' ? { toAddrs: msg.toAddrs } : {}) });
    return true;
  };

  // Mail list shortcuts (reply/forward here are the fallback when no reader is open)
  useShortcutHandlers({
    'mail.archive': () => undoable('archive', currentTargets()),
    'mail.delete': () => undoable('delete', currentTargets()),
    'mail.spam': () => undoable('spam', currentTargets()),
    'mail.deletePermanent': () => {
      const items = currentTargets();
      if (!items.length) return false;
      void deletePermanently(items).then((done) => { if (done) selectAfterRemoval(items.map((i) => i.id)); });
      return true;
    },
    'mail.move': () => {
      const items = currentTargets();
      if (!items.length) return false;
      setMoveTargets(items);
      return true;
    },
    'mail.flag': () => {
      const items = currentTargets();
      if (!items.length) return false;
      const allFlagged = items.every((i) => displayMessages.find((m) => m.id === i.id)?.flags.includes('\\Flagged'));
      void setState(allFlagged ? 'unflag' : 'flag', items.map((i) => i.id));
      return true;
    },
    'mail.markRead': () => { const ids = currentTargets().map((i) => i.id); void setState('read', ids); return ids.length > 0; },
    'mail.markUnread': () => { const ids = currentTargets().map((i) => i.id); void setState('unread', ids); return ids.length > 0; },
    'mail.next': () => {
      const idx = selectedMessageId ? orderedIds.indexOf(selectedMessageId) : -1;
      return openAt(orderedIds[Math.min(idx + 1, orderedIds.length - 1)]);
    },
    'mail.prev': () => {
      const idx = selectedMessageId ? orderedIds.indexOf(selectedMessageId) : orderedIds.length;
      return openAt(orderedIds[Math.max(idx - 1, 0)]);
    },
    'mail.open': () => openAt(selectedMessageId ?? orderedIds[0]),
    'mail.back': () => {
      if (!selectedMessageId && selectedIds.size === 0) return false;
      const last = selectedMessageId;
      setSelectedMessage(null);
      clearSelection();
      if (last) document.getElementById(`msg-row-${last}`)?.focus();
      return true;
    },
    'mail.select': () => {
      const id = selectedMessageId ?? orderedIds[0];
      if (!id) return false;
      toggleSelection(id);
      return true;
    },
    'mail.nextInConversation': () => stepConversation(1),
    'mail.prevInConversation': () => stepConversation(-1),
    'mail.reply': () => replyTo('reply'),
    'mail.replyAll': () => replyTo('replyAll'),
    'mail.forward': () => replyTo('forward'),
    search: () => {
      const el = searchInputRef.current;
      if (!el) return false;
      el.focus();
      el.select();
      return true;
    },
  });

  const quickAction = (msg: MessageSummary, action: 'archive' | 'delete' | 'read' | 'flag') => {
    const isUnread = !msg.flags.includes('\\Seen');
    const isFlagged = msg.flags.includes('\\Flagged');
    const loc: MessageLocation = { id: msg.id, folderId: msg.folderId ?? folderId };

    if (action === 'archive' || action === 'delete') {
      void runWithUndo(action, [loc]).then((done) => {
        if (done && msg.id === selectedMessageId) setSelectedMessage(null);
      });
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
          void runWithUndo('move', [{ id: msg.id, folderId: msg.folderId ?? folderId }], f.id).then((done) => {
            if (done && msg.id === selectedMessageId) setSelectedMessage(null);
          });
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
        api.post(`/mail/messages/${msg.id}/snooze`, { until: until.toISOString() }).then(invalidate).catch(toastError);
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
      // Categories submenu
      categories.length > 0
        ? {
            label: 'Kategorisieren',
            icon: <Tag size={14} />,
            children: categories.map((c) => {
              const assigned = (msg.categories ?? []).some((mc) => mc.id === c.id);
              return {
                label: c.name,
                icon: <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: c.color }} />,
                onClick: () => {
                  const next = assigned
                    ? (msg.categories ?? []).filter((mc) => mc.id !== c.id).map((mc) => mc.id)
                    : [...(msg.categories ?? []).map((mc) => mc.id), c.id];
                  api.post(`/categories/messages/${msg.id}`, { categoryIds: next }).then(invalidate).catch(toastError);
                },
                ...(assigned ? { separator: 'after' as const } : {}),
              };
            }),
          }
        : {
            label: 'Kategorien anlegen …',
            icon: <Tag size={14} />,
            onClick: () => navigate('/settings#categories'),
          },
      { label: isSnoozed ? 'Schlummer aufheben' : 'Schlummern bis …',
        icon: <Clock size={14} />,
        ...(isSnoozed
          ? { onClick: () => api.delete(`/mail/messages/${msg.id}/snooze`).then(invalidate).catch(toastError) }
          : { children: snoozeOptions() }),
      },
      { type: 'divider' },
      { label: 'Archivieren', icon: <Archive size={14} />, onClick: () => quickAction(msg, 'archive') },
      { label: 'Verschieben nach …', icon: <FolderInput size={14} />, children: moveTargets },
      isJunkFolder
        ? { label: 'Kein Junk', icon: <ShieldOff size={14} />, onClick: () => bulkMutation.mutate({ ids: [msg.id], action: 'notSpam' }) }
        : { label: 'Als Junk markieren', icon: <AlertOctagon size={14} />, onClick: () => {
            void runWithUndo('spam', [{ id: msg.id, folderId: msg.folderId ?? folderId }]).then((done) => {
              if (done && msg.id === selectedMessageId) setSelectedMessage(null);
            });
          } },
      { label: 'Löschen', icon: <Trash2 size={14} />, danger: true, onClick: () => quickAction(msg, 'delete') },
      { type: 'divider' },
      { label: 'Regeln', icon: <ListFilter size={14} />, children: [
        { label: 'Regel erstellen …', icon: <ListFilter size={14} />,
          onClick: () => setRuleEditor({ open: true, preset: { fromAddr: msg.fromAddr, subject: msg.subject } }) },
        { label: 'Regeln verwalten …', icon: <Settings size={14} />,
          onClick: () => navigate('/settings#rules') },
      ]},
      { type: 'divider' },
      { label: 'Quelltext anzeigen', icon: <Code size={14} />,
        onClick: () => {
          // Authorization header instead of ?token= (tokens in URLs end up in logs/history)
          void fetchText(`/mail/messages/${msg.id}/raw`).then((text) => {
            setRawModal({ text, subject: msg.subject || 'message', msgId: msg.id });
          }).catch((err: unknown) => {
            setRawModal({
              text: `Fehler beim Laden des Quelltexts: ${err instanceof Error ? err.message : String(err)}`,
              subject: msg.subject || 'message',
              msgId: msg.id,
            });
          });
        } },
      { label: 'Als EML herunterladen', icon: <Download size={14} />,
        onClick: () => {
          downloadFile(`/mail/messages/${msg.id}/raw`, `${msg.subject || 'message'}.eml`).catch(toastError);
        } },
    ];
  };

  const handleRowClick = (msg: MessageSummary) => (e: React.MouseEvent) => {
    // Shift = range selection, Ctrl/Cmd = toggle single, otherwise open
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

  const chips = searching ? (searchQuery.data?.pages[0]?.chips ?? []) : [];
  const insertOperator = (token: string) => {
    const base = searchText.trim();
    setSearchText(base ? `${base} ${token}` : token);
    requestAnimationFrame(() => {
      const el = searchInputRef.current;
      if (!el) return;
      el.focus();
      // Cursor inside "" for the phrase operator, else at the end
      const pos = token === '""' ? el.value.length - 1 : el.value.length;
      el.setSelectionRange(pos, pos);
    });
  };
  const removeChip = (raw: string) => {
    setSearchText((s) => s.replace(raw, ' ').replace(/\s+/g, ' ').trim());
  };

  return (
    <div className="w-full h-full border-r border-line bg-surface flex flex-col overflow-hidden">
      {/* Search row */}
      <div className="px-3 py-2 border-b border-line flex items-center gap-2 relative">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            ref={searchInputRef}
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            onKeyDown={(e) => { if (e.key === 'Escape' && searchText) { e.preventDefault(); setSearchText(''); } }}
            aria-label={t('search_placeholder')}
            aria-keyshortcuts="/"
            className="w-full pl-7 pr-3 py-1 text-xs rounded border border-line-strong bg-surface outline-none focus:border-accent-fg [&::-webkit-search-cancel-button]:hidden"
            placeholder={t('search_placeholder')}
          />
          {searchText && (
            <button aria-label="Suche leeren" onClick={() => setSearchText('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-muted">
              <X size={12} />
            </button>
          )}
          {/* Typeahead suggestions (plain words only — operators go to the server) */}
          {showSuggestions && suggestions.length > 0 && !hasOperatorSyntax(searchText) && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-line rounded-lg shadow-lg z-50 max-h-40 overflow-y-auto">
              {suggestions.map((m) => (
                <button key={m.id}
                  onMouseDown={() => { setSelectedMessage(m.id); setSearchText(''); setShowSuggestions(false); }}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-surface-2 border-b border-line last:border-0">
                  <p className="font-medium text-fg truncate">{m.subject || '(kein Betreff)'}</p>
                  <p className="text-fg-subtle truncate">{m.fromAddr}</p>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Scope toggle */}
        <div className="flex text-[10px] rounded border border-line-strong overflow-hidden shrink-0">
          <button
            onClick={() => setSearchScope('folder')}
            className={`px-1.5 py-1 ${searchScope === 'folder' ? 'bg-accent text-white' : 'text-fg-muted hover:bg-surface-2'}`}
            title="Diesen Ordner durchsuchen"
          >Ordner</button>
          <button
            onClick={() => setSearchScope('all')}
            className={`px-1.5 py-1 ${searchScope === 'all' ? 'bg-accent text-white' : 'text-fg-muted hover:bg-surface-2'}`}
            title="Gesamtes Postfach durchsuchen"
          >Alle</button>
        </div>
        <SearchOperatorsHelp onInsert={insertOperator} />
      </div>
      {chips.length > 0 && (
        <div className="pt-2 border-b border-line">
          <SearchChips chips={chips} onRemove={(c) => removeChip(c.raw)} />
        </div>
      )}
      <div className="px-3 py-2 border-b border-line flex items-center gap-2">
        <input
          type="checkbox"
          checked={allChecked}
          onChange={() => (allChecked ? clearSelection() : selectAll(orderedIds))}
          className="rounded border-line-strong text-accent-fg focus:ring-accent-fg"
          title="Alle auswählen"
        />
        <FilterTab value="all" label="Alle" active={filter === 'all'} onSelect={setFilter} />
        <FilterTab value="unread" label="Ungelesen" active={filter === 'unread'} onSelect={setFilter} />
        <FilterTab value="flagged" label="Markiert" active={filter === 'flagged'} onSelect={setFilter} />
        <FilterTab value="attachments" label="Anhang" active={filter === 'attachments'} onSelect={setFilter} />
        <span className="ml-auto text-xs text-fg-subtle" title={`${displayMessages.length} geladen von ${totalCount}`}>
          <AnimatedCounter value={filter === 'all' ? totalCount : displayMessages.length} />
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {isLoading ? (
          <MessageListSkeleton rows={8} label={t('loading_more')} />
        ) : displayMessages.length === 0 && !hasNextPage ? (
          activeQuery.isError
            ? <p role="alert" className="p-4 text-xs text-danger-fg">Nachrichten konnten nicht geladen werden.</p>
            : searching ? <EmptySearch /> : filter === 'all' ? <EmptyInbox /> : <EmptyFilter />
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
        {hasNextPage && !isLoading && (
          isFetchingNextPage ? (
            <div ref={sentinelRef}><MessageListSkeleton rows={2} label={t('loading_more')} /></div>
          ) : (
            <div ref={sentinelRef} className="p-3 flex justify-center">
              <button
                onClick={() => void fetchNextPage()}
                className="text-xs text-accent-fg hover:underline"
              >
                Weitere Nachrichten laden
              </button>
            </div>
          )
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {moveTargets && (
        <MoveToFolderDialog
          folders={folders}
          excludeFolderId={searching ? null : folderId}
          onClose={() => setMoveTargets(null)}
          onPick={(target) => { undoable('move', moveTargets, target); }}
        />
      )}

      {/* Rule editor (via context menu "Create rule") */}
      {ruleEditor.open && (
        <RuleEditorModal
          rule={null}
          {...(ruleEditor.preset ? { preset: ruleEditor.preset } : {})}
          onClose={() => setRuleEditor({ open: false })}
          onSaved={() => { setRuleEditor({ open: false }); qc.invalidateQueries({ queryKey: ['rules'] }); }}
        />
      )}

      {/* RFC 822 source modal */}
      {rawModal && (
        <Modal
          onClose={() => setRawModal(null)}
          label="Quelltext"
          className="bg-surface rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        >
            <div className="flex items-center justify-between px-4 py-3 border-b border-line shrink-0">
              <span className="text-sm font-semibold text-fg-muted flex items-center gap-2">
                <Code size={14} /> Quelltext
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => downloadFile(`/mail/messages/${rawModal.msgId}/raw`, `${rawModal.subject}.eml`).catch(toastError)}
                  className="btn-secondary text-xs"
                >
                  <Download size={12} /> .eml herunterladen
                </button>
                <button aria-label="Schließen" className="btn-ghost p-1" onClick={() => setRawModal(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-fg leading-relaxed whitespace-pre-wrap break-all">
              {rawModal.text}
            </pre>
        </Modal>
      )}
    </div>
  );
}
