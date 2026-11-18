import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Reply, ReplyAll, Forward, Trash2, Archive, Paperclip, Download, Printer, ListFilter, Mail,
  AlertOctagon, ShieldOff, Code, Pin, Flag, FolderInput, Clock, X,
  ShieldAlert, ShieldCheck, CalendarClock, CheckCircle, AlertCircle, RefreshCw,
} from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { textToQuotedHtml } from '../lib/mailHtml.js';
import { api, downloadFile, fetchText } from '../api/client.js';
import type { Message, Folder } from '../api/types.js';
import { useUiStore } from '../store/ui.js';
import { toastError } from '../lib/errors.js';
import { MailBody } from './MailBody.js';
import type { ContextMenuItem } from './ContextMenu.js';
import { CommandBar, type CommandGroup, type CommandItem } from './CommandBar.js';
import { MoveToFolderDialog } from './MoveToFolderDialog.js';
import { RuleEditorModal } from './RuleEditorModal.js';
import { useMailActions } from '../hooks/useMailActions.js';
import { useShortcutHandlers, useAriaKeys } from '../hooks/useShortcuts.js';
import { Avatar } from './Avatar.js';
import { ContactHoverCard } from './ContactHoverCard.js';
import { MessageReaderSkeleton } from './Skeleton.js';
import { Modal } from './Modal.js';
import { translate, useT } from '../i18n/useT.js';
import { useActiveMailbox } from '../hooks/useActiveMailbox.js';
import { readerOverflowActions, type ReaderAction, type ReaderActionId } from '../lib/mailCommands.js';
import { useAutoMarkRead, useReadReceipt } from '../hooks/useReadBehaviour.js';
import { useRegional } from '../store/preferences.js';
import { formatLongDateTime } from '../lib/regionalFormat.js';

interface Props {
  messageId: string;
}

const READER_ICONS: Record<ReaderActionId, ReactNode> = {
  print: <Printer size={16} />,
  source: <Code size={16} />,
  eml: <Download size={16} />,
  rule: <ListFilter size={16} />,
  read: <Mail size={16} />,
  flag: <Flag size={16} />,
  pin: <Pin size={16} />,
  snooze: <Clock size={16} />,
  move: <FolderInput size={16} />,
  archive: <Archive size={16} />,
  junk: <AlertOctagon size={16} />,
  delete: <Trash2 size={16} />,
};

/** "…" entries as command-bar groups (a divider before every groupStart). */
function overflowGroups(
  actions: ReaderAction[],
  handlers: Record<ReaderActionId, Pick<CommandItem, 'onClick' | 'menu'>>,
  icons: Record<ReaderActionId, ReactNode>,
): CommandGroup[] {
  const groups: CommandGroup[] = [];
  for (const a of actions) {
    if (a.groupStart || groups.length === 0) groups.push({ id: `more-${a.id}`, items: [] });
    groups[groups.length - 1]!.items.push({
      id: a.id,
      label: a.label,
      icon: icons[a.id],
      placement: 'overflow',
      ...(a.enabled ? handlers[a.id] : { disabled: true }),
      ...(a.tooltip ? { tooltip: a.tooltip } : {}),
      ...(a.danger ? { tone: 'danger' as const } : {}),
    });
  }
  return groups;
}

export function MessageReader({ messageId }: Props) {
  const qc = useQueryClient();
  const { openCompose, setSelectedMessage, selectedFolderId } = useUiStore();
  // 9.3: own, shared or delegated mailbox — same API shapes, different base
  const mailbox = useActiveMailbox();
  const { base, readOnly, foreign } = mailbox;
  const [moveOpen, setMoveOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [showAvatarCard, setShowAvatarCard] = useState(false);
  const [showRawSource, setShowRawSource] = useState(false);
  const [rawSource, setRawSource] = useState<string | null>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: msg, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['message', messageId],
    // 9.4: the reader marks read itself (immediately / after a delay / manually)
    queryFn: () => api.get<Message>(`${base}/messages/${messageId}?markRead=false`),
  });

  const { data: folders = [] } = useQuery({
    queryKey: mailbox.foldersKey,
    queryFn: () => api.get<Folder[]>(`${base}/folders`),
  });
  const regional = useRegional();
  useAutoMarkRead(msg, base, readOnly);
  const receipt = useReadReceipt(msg, {
    ownMailbox: !foreign,
    inJunk: folders.find((f) => f.id === selectedFolderId)?.name === 'Junk',
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['messages'] });
    qc.invalidateQueries({ queryKey: ['folders'] });
    qc.invalidateQueries({ queryKey: ['message', messageId] });
  };

  // Errors are reported by the global MutationCache handler (main.tsx)
  const bulkMutation = useMutation({
    mutationFn: (body: { ids: string[]; action: string; folderId?: string }) =>
      api.post(`${base}/messages/bulk`, body),
    onSettled: invalidate,
  });

  const patchMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`${base}/messages/${messageId}`, body),
    onSettled: invalidate,
  });

  const cancelScheduledMutation = useMutation({
    mutationFn: () => api.post(`/mail/messages/${messageId}/cancel-scheduled`, {}),
    onSettled: invalidate,
  });

  const ariaKeys = useAriaKeys();
  const { runWithUndo } = useMailActions();
  const t = useT();

  /** Reply / reply all / forward with the quoted original (toolbar + shortcuts). */
  const doReply = (mode: 'reply' | 'replyAll' | 'forward'): boolean => {
    if (!msg) return false;
    const quoted = msg.bodyHtml || textToQuotedHtml(msg.bodyText ?? '');
    if (mode !== 'forward' && !readOnly && !msg.flags.includes('\\Answered')) {
      // Set \Answered flag when Reply/Reply all is used
      patchMutation.mutate({ flags: [...msg.flags, '\\Answered'] });
    }
    openCompose({
      mode, id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr, bodyHtml: quoted, mailbox: mailbox.ref,
      ...(mode === 'replyAll' ? { toAddrs: msg.toAddrs, ccAddrs: msg.ccAddrs } : {}),
    });
    return true;
  };
  useShortcutHandlers({
    'mail.reply': () => doReply('reply'),
    'mail.replyAll': () => doReply('replyAll'),
    'mail.forward': () => doReply('forward'),
  });

  if (isLoading) return <MessageReaderSkeleton />;
  if (!msg) {
    if (!isError) return null;
    return (
      <div role="alert" className="flex-1 flex items-center justify-center bg-surface p-6">
        <div className="text-center max-w-sm">
          <AlertCircle size={32} className="mx-auto text-danger-fg mb-2" aria-hidden="true" />
          <p className="text-sm font-medium text-fg">Die Nachricht konnte nicht geladen werden.</p>
          <p className="text-xs text-fg-subtle mt-1 break-words">
            {error instanceof Error ? error.message : 'Unbekannter Fehler'}
          </p>
          <button
            type="button"
            onClick={() => { void refetch(); }}
            disabled={isFetching}
            className="btn-secondary text-xs mt-4 inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} aria-hidden="true" /> Erneut versuchen
          </button>
        </div>
      </div>
    );
  }

  const isFlagged = msg.flags.includes('\\Flagged');
  const isPinned = !!msg.pinnedAt;

  // Determine whether the current folder is the junk folder (for conditional menu item)
  const currentFolder = folders.find((f) => f.id === selectedFolderId);
  const isJunkFolder = currentFolder?.name === 'Junk';

  // Undo toast (8 s, also `z`) only after the server confirmed the action
  const loc = { id: msg.id, folderId: msg.folderId ?? selectedFolderId ?? '' };
  const withUndo = (action: 'delete' | 'archive' | 'spam' | 'move', target?: string) => {
    void runWithUndo(action, [loc], target).then((done) => { if (done) setSelectedMessage(null); });
  };

  const snoozeUntil = (d: Date) => {
    api.post(`/mail/messages/${msg.id}/snooze`, { until: d.toISOString() }).then(invalidate).catch(toastError);
  };
  const snoozeMenu = (): ContextMenuItem[] => [
    { label: t('reader_snooze_1h'), onClick: () => { const d = new Date(); d.setHours(d.getHours() + 1); snoozeUntil(d); } },
    { label: t('reader_snooze_3h'), onClick: () => { const d = new Date(); d.setHours(d.getHours() + 3); snoozeUntil(d); } },
    { label: t('reader_snooze_tomorrow'), onClick: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8,0,0,0); snoozeUntil(d); } },
    { label: t('reader_snooze_monday'), onClick: () => { const d = new Date(); d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7)); d.setHours(8,0,0,0); snoozeUntil(d); } },
  ];

  const showSource = () => {
    // Authorization header instead of ?token= (tokens in URLs end up in logs/history)
    void fetchText(`${base}/messages/${msg.id}/raw`).then(text => {
      setRawSource(text);
      setShowRawSource(true);
    }).catch((err: unknown) => {
      setRawSource(`Fehler beim Laden des Quelltexts: ${err instanceof Error ? err.message : String(err)}`);
      setShowRawSource(true);
    });
  };

  // Header action bar: reply / reply all / forward as buttons, everything else under "…"
  const isRead = msg.flags.includes('\\Seen');
  const handlers: Record<ReaderActionId, Pick<CommandItem, 'onClick' | 'menu'>> = {
    print: { onClick: () => window.print() },
    source: { onClick: showSource },
    eml: { onClick: () => { downloadFile(`${base}/messages/${msg.id}/raw`, `${msg.subject || 'message'}.eml`).catch(toastError); } },
    rule: { onClick: () => setRuleOpen(true) },
    read: { onClick: () => patchMutation.mutate({ read: !isRead }) },
    flag: { onClick: () => patchMutation.mutate({ flagged: !isFlagged }) },
    pin: { onClick: () => bulkMutation.mutate({ ids: [msg.id], action: isPinned ? 'unpin' : 'pin' }) },
    snooze: { menu: snoozeMenu },
    move: { onClick: () => setMoveOpen(true) },
    archive: { onClick: () => withUndo('archive') },
    junk: isJunkFolder
      ? { onClick: () => { bulkMutation.mutate({ ids: [msg.id], action: 'notSpam' }); setSelectedMessage(null); } }
      : { onClick: () => withUndo('spam') },
    delete: { onClick: () => withUndo('delete') },
  };
  const actionGroups: CommandGroup[] = [
    { id: 'respond', title: t('reader_group_respond'), items: [
      { id: 'reply', label: t('reply'), icon: <Reply size={16} />, placement: 'pinned', keyshortcuts: ariaKeys('mail.reply'), onClick: () => doReply('reply') },
      { id: 'replyAll', label: t('reply_all'), icon: <ReplyAll size={16} />, placement: 'pinned', keyshortcuts: ariaKeys('mail.replyAll'), onClick: () => doReply('replyAll') },
      { id: 'forward', label: t('forward'), icon: <Forward size={16} />, placement: 'pinned', keyshortcuts: ariaKeys('mail.forward'), onClick: () => doReply('forward') },
    ] },
    ...overflowGroups(
      readerOverflowActions({ readOnly, foreign, isJunkFolder, isRead, isFlagged, isPinned }, t),
      handlers,
      isJunkFolder ? { ...READER_ICONS, junk: <ShieldOff size={16} /> } : READER_ICONS,
    ),
  ];

  return (
    <div className="flex-1 flex flex-col bg-surface overflow-hidden">
      <CommandBar label={t('reader_actions_label')} groups={actionGroups} className="px-3 py-1.5 border-b border-line shrink-0" />

      {/* Spam banner — Outlook style. Visible when rspamd score ≥ 3.0 OR the mail is in the junk folder */}
      {(() => {
        const score = msg.spamScore ?? null;
        const showSpamBanner = (score !== null && score >= 3.0) || isJunkFolder;
        if (!showSpamBanner) return null;
        const isHighRisk = (score !== null && score >= 6.0);
        return (
          <div className={`px-4 py-2.5 border-b shrink-0 flex items-center gap-2.5 text-sm ${
            isHighRisk
              ? 'bg-danger-bg border-danger-line text-danger-fg'
              : 'bg-warning-bg border-warning-line text-warning-fg'
          }`}>
            <ShieldAlert size={16} className={isHighRisk ? 'text-danger-fg shrink-0' : 'text-warning-fg shrink-0'} />
            <div className="flex-1 min-w-0">
              <p className="font-semibold leading-tight">
                {isHighRisk
                  ? 'Diese Nachricht wurde als Spam erkannt — möglicherweise gefährlich.'
                  : isJunkFolder
                    ? 'Diese Nachricht liegt im Junk-Ordner.'
                    : 'Diese Nachricht zeigt Spam-Signale.'}
              </p>
              <p className="text-xs leading-tight">
                {score !== null
                  ? <>rspamd-Score: <strong className="font-mono">{score.toFixed(2)}</strong> · Links nicht ohne Prüfung anklicken</>
                  : <>Klicken Sie unten auf „Kein Spam", falls diese Nachricht fälschlicherweise als Junk erkannt wurde.</>}
              </p>
            </div>
            {isJunkFolder ? (
              <button
                onClick={() => { bulkMutation.mutate({ ids: [msg.id], action: 'notSpam' }); setSelectedMessage(null); }}
                disabled={readOnly}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface text-fg border border-line-strong rounded hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={readOnly ? t('mail_hint_read_only') : t('reader_not_spam_tip')}
              >
                <ShieldCheck size={13} /> {t('reader_not_spam')}
              </button>
            ) : (
              <button
                onClick={() => withUndo('spam')}
                disabled={readOnly}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface text-fg border border-line-strong rounded hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={readOnly ? t('mail_hint_read_only') : t('reader_as_junk_tip')}
              >
                <AlertOctagon size={13} /> {t('reader_as_junk')}
              </button>
            )}
          </div>
        );
      })()}

      {/* 9.4: read receipt requested (Settings → Lesen: "fragen") */}
      {receipt.action === 'ask' && (
        <div className="px-4 py-2.5 border-b border-line shrink-0 flex items-center gap-2.5 text-sm bg-surface-2 text-fg">
          <span className="flex-1">{msg.dispositionNotificationTo} hat eine Lesebestätigung angefordert.</span>
          <button type="button" className="btn-primary text-xs" disabled={receipt.pending} onClick={receipt.send}>Senden</button>
          <button type="button" className="btn-secondary text-xs" disabled={receipt.pending} onClick={receipt.ignore}>Nicht senden</button>
        </div>
      )}

      {/* Draft (own Drafts folder): continue editing in compose (server draft) */}
      {!foreign && currentFolder?.name === 'Drafts' && !msg.scheduledStatus && (
        <div className="px-4 py-2.5 border-b shrink-0 flex items-center gap-2.5 text-sm bg-warning-bg border-warning-line text-warning-fg">
          <span className="flex-1">{translate('draft_banner')}</span>
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={() => openCompose({ mode: 'new', draftId: msg.id })}
          >
            {translate('draft_edit')}
          </button>
        </div>
      )}

      {/* Scheduled send banner (Outlook style) — visible for PENDING/SENT/CANCELLED */}
      {msg.scheduledAt && msg.scheduledStatus && (
        <div className={`px-4 py-2.5 border-b shrink-0 flex items-center gap-2.5 text-sm ${
          msg.scheduledStatus === 'PENDING'   ? 'bg-info-bg border-info-line text-info-fg' :
          msg.scheduledStatus === 'SENT'      ? 'bg-success-bg border-success-line text-success-fg' :
                                                 'bg-surface-2 border-line text-fg-muted'
        }`}>
          {msg.scheduledStatus === 'PENDING' && <CalendarClock size={16} className="text-info-fg shrink-0" />}
          {msg.scheduledStatus === 'SENT'    && <CheckCircle  size={16} className="text-success-fg shrink-0" />}
          {msg.scheduledStatus === 'CANCELLED' && <X size={16} className="text-fg-subtle shrink-0" />}
          <div className="flex-1 min-w-0">
            <p className="font-semibold leading-tight">
              {msg.scheduledStatus === 'PENDING'   ? 'Diese Nachricht wird geplant gesendet' :
               msg.scheduledStatus === 'SENT'      ? 'Geplanter Versand abgeschlossen' :
                                                     'Geplanter Versand abgebrochen'}
            </p>
            <p className="text-xs leading-tight">
              {msg.scheduledStatus === 'PENDING' ? 'Versand am ' : 'War geplant für '}
              <strong>{new Date(msg.scheduledAt).toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' })}</strong>
            </p>
          </div>
          {msg.scheduledStatus === 'PENDING' && !foreign && (
            <button
              onClick={() => cancelScheduledMutation.mutate()}
              disabled={cancelScheduledMutation.isPending}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface text-fg border border-line-strong rounded hover:bg-surface-2 transition-colors disabled:opacity-50"
              title="Planung abbrechen — Mail wird nicht gesendet"
            >
              <X size={13} /> Planung abbrechen
            </button>
          )}
        </div>
      )}

      {/* Header */}
      <div className="px-6 py-4 border-b border-line shrink-0 animate-page-in">
        <div className="flex items-start gap-2 mb-3">
          <h2 className="text-lg font-semibold text-fg flex-1">{msg.subject || '(kein Betreff)'}</h2>
          {isFlagged && <Flag size={16} className="fill-danger-fg text-danger-fg shrink-0 mt-1" />}
          {isPinned && <Pin size={16} className="text-accent-fg shrink-0 mt-1" />}
        </div>
        <div className="flex items-start gap-3">
          <div
            ref={avatarRef}
            onMouseEnter={() => {
              if (hoverTimer.current) clearTimeout(hoverTimer.current);
              hoverTimer.current = setTimeout(() => setShowAvatarCard(true), 250);
            }}
            onMouseLeave={() => {
              if (hoverTimer.current) clearTimeout(hoverTimer.current);
              hoverTimer.current = setTimeout(() => setShowAvatarCard(false), 200);
            }}
          >
            <Avatar seed={msg.fromAddr} size="lg" className="transition-transform duration-150 hover:scale-105 cursor-default" />
          </div>
          <div className="flex-1 min-w-0 space-y-0.5 text-sm">
            <p className="font-medium text-fg">{msg.fromName || msg.fromAddr.split('@')[0]}</p>
            <p className="text-xs text-fg-subtle">&lt;{msg.fromAddr}&gt;</p>
            <p className="text-xs text-fg-subtle">
              An: <span className="text-fg-muted">{msg.toAddrs.join(', ')}</span>
              {msg.ccAddrs?.length > 0 && (
                <> · CC: <span className="text-fg-muted">{msg.ccAddrs.join(', ')}</span></>
              )}
            </p>
            <p className="text-xs text-fg-subtle">{formatLongDateTime(new Date(msg.date), regional)}</p>
          </div>
        </div>
        {showAvatarCard && (
          <ContactHoverCard
            email={msg.fromAddr}
            name={msg.fromName}
            anchorRef={avatarRef}
            onClose={() => setShowAvatarCard(false)}
          />
        )}
      </div>

      {/* Attachments */}
      {msg.attachments?.length > 0 && (
        <div className="px-6 py-2 border-b border-line flex flex-wrap gap-2 shrink-0">
          {msg.attachments.map((att) => (
            // Fetch-to-blob with the Authorization header (a plain <a href> would
            // reach GET /api/v1/mail/attachments/:id without a token → 401).
            <button key={att.id} type="button" title={att.filename}
              onClick={() => { downloadFile(`/mail/attachments/${att.id}`, att.filename || 'attachment').catch(toastError); }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 border border-line rounded text-xs text-fg-muted hover:bg-surface-3 transition-colors">
              <Paperclip size={12} />
              {att.filename}
              <span className="text-fg-subtle">({Math.round(att.size / 1024)} KB)</span>
              <Download size={11} className="text-fg-subtle" />
            </button>
          ))}
        </div>
      )}

      {/* Body — with privacy images banner (Outlook/Gmail style) */}
      {(() => {
        // First: pre-process HTML so external images get blocked if needed
        if (!msg.bodyHtml) {
          return (
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <pre className="text-sm text-fg-muted whitespace-pre-wrap font-sans">{msg.bodyText}</pre>
            </div>
          );
        }
        return (
          <MailBody
            messageId={msg.id}
            html={msg.bodyHtml}
            attachments={msg.attachments}
            scrollClassName="flex-1 overflow-y-auto px-6 py-4"
            bodyClassName="prose prose-sm max-w-none"
          />
        );
      })()}

      {moveOpen && (
        <MoveToFolderDialog
          folders={folders}
          excludeFolderId={msg.folderId ?? selectedFolderId}
          onClose={() => setMoveOpen(false)}
          onPick={(target) => withUndo('move', target)}
        />
      )}

      {ruleOpen && (
        <RuleEditorModal
          rule={null}
          preset={{ fromAddr: msg.fromAddr, subject: msg.subject }}
          onClose={() => setRuleOpen(false)}
          onSaved={() => { setRuleOpen(false); void qc.invalidateQueries({ queryKey: ['rules'] }); }}
        />
      )}

      {/* RFC 822 source modal */}
      {showRawSource && rawSource !== null && (
        <Modal
          onClose={() => setShowRawSource(false)}
          label="Quelltext"
          className="bg-surface rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        >
            <div className="flex items-center justify-between px-4 py-3 border-b border-line shrink-0">
              <span className="text-sm font-semibold text-fg-muted flex items-center gap-2">
                <Code size={14} /> Quelltext
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => downloadFile(`${base}/messages/${msg.id}/raw`, `${msg.subject || 'message'}.eml`).catch(toastError)}
                  className="btn-secondary text-xs"
                >
                  <Download size={12} /> .eml herunterladen
                </button>
                <button className="btn-ghost p-1" onClick={() => setShowRawSource(false)} aria-label="Schließen">
                  <X size={16} />
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-fg leading-relaxed whitespace-pre-wrap break-all">
              {rawSource}
            </pre>
        </Modal>
      )}
    </div>
  );
}
