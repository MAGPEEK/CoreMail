import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Reply, ReplyAll, Forward, Trash2, Archive, Paperclip, Download,
  AlertOctagon, ShieldOff, MoreHorizontal, Code, Pin, Flag, FlagOff, FolderInput, Clock, X,
  ShieldAlert, ShieldCheck, CalendarClock, CheckCircle, AlertCircle, RefreshCw,
} from 'lucide-react';
import { format } from 'date-fns';
import { useRef, useState } from 'react';
import { textToQuotedHtml } from '../lib/mailHtml.js';
import { api, downloadFile, fetchText } from '../api/client.js';
import type { Message, Folder } from '../api/types.js';
import { useUiStore } from '../store/ui.js';
import { toastError } from '../lib/errors.js';
import { MailBody } from './MailBody.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { useMailActions } from '../hooks/useMailActions.js';
import { useShortcutHandlers, useAriaKeys } from '../hooks/useShortcuts.js';
import { Avatar } from './Avatar.js';
import { ContactHoverCard } from './ContactHoverCard.js';
import { MessageReaderSkeleton } from './Skeleton.js';
import { Modal } from './Modal.js';
import { translate } from '../i18n/useT.js';

interface Props {
  messageId: string;
}

export function MessageReader({ messageId }: Props) {
  const qc = useQueryClient();
  const { openCompose, setSelectedMessage, selectedFolderId } = useUiStore();
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const [showAvatarCard, setShowAvatarCard] = useState(false);
  const [showRawSource, setShowRawSource] = useState(false);
  const [rawSource, setRawSource] = useState<string | null>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: msg, isLoading, isError, error, refetch, isFetching } = useQuery({
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

  // Errors are reported by the global MutationCache handler (main.tsx)
  const bulkMutation = useMutation({
    mutationFn: (body: { ids: string[]; action: string; folderId?: string }) =>
      api.post('/mail/messages/bulk', body),
    onSettled: invalidate,
  });

  const patchMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/mail/messages/${messageId}`, body),
    onSettled: invalidate,
  });

  const cancelScheduledMutation = useMutation({
    mutationFn: () => api.post(`/mail/messages/${messageId}/cancel-scheduled`, {}),
    onSettled: invalidate,
  });

  const ariaKeys = useAriaKeys();
  const { runWithUndo } = useMailActions();

  /** Reply / reply all / forward with the quoted original (toolbar + shortcuts). */
  const doReply = (mode: 'reply' | 'replyAll' | 'forward'): boolean => {
    if (!msg) return false;
    const quoted = msg.bodyHtml || textToQuotedHtml(msg.bodyText ?? '');
    if (mode !== 'forward' && !msg.flags.includes('\\Answered')) {
      // Set \Answered flag when Reply/Reply all is used
      patchMutation.mutate({ flags: [...msg.flags, '\\Answered'] });
    }
    openCompose({
      mode, id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr, bodyHtml: quoted,
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

  const handleDelete = () => withUndo('delete');
  const handleArchive = () => withUndo('archive');

  const snoozeUntil = (d: Date) => {
    api.post(`/mail/messages/${msg.id}/snooze`, { until: d.toISOString() }).then(invalidate).catch(toastError);
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
        { label: 'In 1 Stunde',     onClick: () => { const d = new Date(); d.setHours(d.getHours() + 1); snoozeUntil(d); } },
        { label: 'In 3 Stunden',    onClick: () => { const d = new Date(); d.setHours(d.getHours() + 3); snoozeUntil(d); } },
        { label: 'Morgen 8:00',     onClick: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8,0,0,0); snoozeUntil(d); } },
        { label: 'Nächsten Montag', onClick: () => { const d = new Date(); d.setDate(d.getDate() + ((1 - d.getDay() + 7) % 7 || 7)); d.setHours(8,0,0,0); snoozeUntil(d); } },
      ],
    },
    { type: 'divider' },
    { label: 'Verschieben nach …', icon: <FolderInput size={14} />,
      children: folders.filter((f) => f.id !== selectedFolderId).map((f) => ({
        label: f.displayName ?? f.name,
        onClick: () => {
          withUndo('move', f.id);
          setSelectedMessage(null);
        },
      })),
    },
    isJunkFolder
      ? { label: 'Kein Junk (False Positive)', icon: <ShieldOff size={14} />,
          onClick: () => { bulkMutation.mutate({ ids: [msg.id], action: 'notSpam' }); setSelectedMessage(null); } }
      : { label: 'Als Junk markieren', icon: <AlertOctagon size={14} />,
          onClick: () => withUndo('spam') },
    { type: 'divider' },
    { label: 'Quelltext anzeigen', icon: <Code size={14} />,
      onClick: () => {
        // Authorization header instead of ?token= (tokens in URLs end up in logs/history)
        void fetchText(`/mail/messages/${msg.id}/raw`).then(text => {
          setRawSource(text);
          setShowRawSource(true);
        }).catch((err: unknown) => {
          setRawSource(`Fehler beim Laden des Quelltexts: ${err instanceof Error ? err.message : String(err)}`);
          setShowRawSource(true);
        });
      } },
    { label: 'Als EML herunterladen', icon: <Download size={14} />,
      onClick: () => {
        downloadFile(`/mail/messages/${msg.id}/raw`, `${msg.subject || 'message'}.eml`).catch(toastError);
      } },
    { label: 'Drucken', icon: <Download size={14} />, onClick: () => window.print() },
  ];

  return (
    <div className="flex-1 flex flex-col bg-surface overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-line shrink-0">
        <button
          onClick={() => doReply('reply')}
          aria-keyshortcuts={ariaKeys('mail.reply')}
          className="btn-secondary text-xs">
          <Reply size={14} /> Antworten
        </button>
        <button
          onClick={() => doReply('replyAll')}
          aria-keyshortcuts={ariaKeys('mail.replyAll')}
          className="btn-secondary text-xs">
          <ReplyAll size={14} /> Allen antworten
        </button>
        <button
          onClick={() => doReply('forward')}
          aria-keyshortcuts={ariaKeys('mail.forward')}
          className="btn-secondary text-xs">
          <Forward size={14} /> Weiterleiten
        </button>
        <div className="flex-1" />
        <button onClick={handleArchive} aria-keyshortcuts={ariaKeys('mail.archive')} className="btn-ghost text-xs">
          <Archive size={14} /> Archivieren
        </button>
        <button onClick={handleDelete} aria-keyshortcuts={ariaKeys('mail.delete')} className="btn-ghost text-xs text-danger-fg hover:bg-danger-bg">
          <Trash2 size={14} /> Löschen
        </button>
        <button
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMoreMenu({ x: r.right - 220, y: r.bottom });
          }}
          className="btn-ghost text-xs" title="Mehr Optionen" aria-label="Mehr Optionen"
          aria-haspopup="menu" aria-expanded={moreMenu !== null}>
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </div>

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
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface text-fg border border-line-strong rounded hover:bg-surface-2 transition-colors"
                title="Diese Nachricht ist kein Spam (Bayes-Lernen)"
              >
                <ShieldCheck size={13} /> Kein Spam
              </button>
            ) : (
              <button
                onClick={() => withUndo('spam')}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface text-fg border border-line-strong rounded hover:bg-surface-2 transition-colors"
                title="In Junk verschieben (Bayes-Lernen)"
              >
                <AlertOctagon size={13} /> Als Junk
              </button>
            )}
          </div>
        );
      })()}

      {/* Draft (own Drafts folder): continue editing in compose (server draft) */}
      {currentFolder?.name === 'Drafts' && !msg.scheduledStatus && (
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
          {msg.scheduledStatus === 'PENDING' && (
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
            <p className="text-xs text-fg-subtle">{format(new Date(msg.date), 'EEEE, dd.MM.yyyy HH:mm')}</p>
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

      {moreMenu && <ContextMenu x={moreMenu.x} y={moreMenu.y} items={moreItems} onClose={() => setMoreMenu(null)} />}

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
                  onClick={() => downloadFile(`/mail/messages/${msg.id}/raw`, `${msg.subject || 'message'}.eml`).catch(toastError)}
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
