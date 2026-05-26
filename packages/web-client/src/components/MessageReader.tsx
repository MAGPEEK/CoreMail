import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Reply, ReplyAll, Forward, Trash2, Archive, Paperclip, Download,
  AlertOctagon, ShieldOff, MoreHorizontal, Code, Pin, Flag, FlagOff, FolderInput, Clock, X,
  ShieldAlert, ShieldCheck, CalendarClock, CheckCircle, Image as ImageIcon,
} from 'lucide-react';
import { format } from 'date-fns';
import DOMPurify from 'dompurify';
import { useRef, useState, useEffect } from 'react';
import { api } from '../api/client.js';
import type { Message, Folder } from '../api/types.js';
import { useUiStore } from '../store/ui.js';
import { useAuthStore } from '../store/auth.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { showUndoToast } from './UndoToast.js';
import { Avatar } from './Avatar.js';
import { ContactHoverCard } from './ContactHoverCard.js';
import { MessageReaderSkeleton } from './Skeleton.js';

/**
 * v3.18.36: Gehärtetes Sanitize. DOMPurify ohne Konfiguration entfernt unsere
 * Privacy-Markierungen (`data-coremail-ext-src`, transparenter PNG-Placeholder)
 * → Bilder wurden trotz Block-Logik geladen oder Banner blieb aus.
 * Plus: Tracking-Vektoren `<style>`, `<link>`, JS-Event-Handler explizit blocken.
 */
function sanitize(html: string): string {
  if (typeof window === 'undefined') {
    return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  }
  return DOMPurify.sanitize(html, {
    // Whitelist unserer Privacy-Markierungen + data: URI für Placeholder
    ADD_ATTR: ['data-coremail-ext-src', 'data-coremail-unresolved-cid', 'data-coremail-ext-bg'],
    ALLOW_DATA_ATTR: true,
    // Tracking-relevante Tags + Event-Handler komplett blocken
    FORBID_TAGS: ['script', 'style', 'link', 'iframe', 'object', 'embed', 'meta', 'base'],
    FORBID_ATTR: [
      'onload', 'onerror', 'onclick', 'onmouseover', 'onmouseenter', 'onmouseleave',
      'onfocus', 'onblur', 'onkeydown', 'onkeyup', 'onsubmit', 'onchange',
      'ping', 'srcset', // srcset könnte Tracking-URL enthalten
    ],
    // data:image für unseren Placeholder explizit erlauben, http(s) für CID-aufgelöste URLs
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data:image\/[a-z]+;base64,):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}

/**
 * Pre-processed HTML zur Privacy-Wahrung (Outlook/Gmail-Style):
 * - cid:-References werden auf MinIO-Attachment-URLs ersetzt (inline-Bilder OK)
 * - http(s):// Bilder bekommen ihr src durch ein Transparent-Pixel ersetzt,
 *   das echte src wandert nach data-coremail-src für späteres Re-Aktivieren.
 * - Tracking-Pixel (1×1) sind effektiv blockiert solange User nicht „Bilder
 *   anzeigen" klickt.
 *
 * Returns: { html, externalImageCount }
 */
function processExternalImages(
  html: string,
  inlineAttachments: { id: string; contentId: string | null }[],
  tokenParam: string,
): { html: string; externalImageCount: number } {
  if (!html) return { html: '', externalImageCount: 0 };

  // Inline-CID-Mapping aufbauen: cid:foo@bar → /api/v1/mail/attachments/{id}
  const cidMap = new Map<string, string>();
  for (const att of inlineAttachments) {
    if (att.contentId) {
      // contentId kann mit "<...>" eingerahmt sein — beide Varianten mappen
      const clean = att.contentId.replace(/^<|>$/g, '').toLowerCase();
      cidMap.set(clean, `/api/v1/mail/attachments/${att.id}${tokenParam}`);
    }
  }

  let externalCount = 0;
  // 1x1 transparent PNG als Platzhalter für blockierte externe Bilder
  const PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  // (1) <img src="..."> behandeln
  let processed = html.replace(/<img\b([^>]*?)src=(["'])([^"']+)\2([^>]*)>/gi, (_match, before: string, quote: string, src: string, after: string) => {
    const trimmed = src.trim();
    // cid:foo@bar → Attachment-URL
    if (/^cid:/i.test(trimmed)) {
      const cid = trimmed.slice(4).replace(/^<|>$/g, '').toLowerCase();
      const mapped = cidMap.get(cid);
      if (mapped) return `<img${before}src=${quote}${mapped}${quote}${after}>`;
      // Unauflösbares cid → Platzhalter (kein Tracking-Risiko)
      return `<img${before}src=${quote}${PLACEHOLDER}${quote} data-coremail-unresolved-cid=${quote}${cid}${quote}${after}>`;
    }
    // data:-URLs sind inline (selbst eingebettet) → unverändert durchreichen
    if (/^data:/i.test(trimmed)) {
      return `<img${before}src=${quote}${trimmed}${quote}${after}>`;
    }
    // http(s):// → externes Bild, ersetzen mit Platzhalter + data-attribut
    if (/^https?:/i.test(trimmed)) {
      externalCount++;
      return `<img${before}src=${quote}${PLACEHOLDER}${quote} data-coremail-ext-src=${quote}${trimmed}${quote} style="opacity:0.5;border:1px dashed #ccc;min-width:16px;min-height:16px"${after}>`;
    }
    // Alles andere (relative URLs, protokollrelative //...) auch blocken
    externalCount++;
    return `<img${before}src=${quote}${PLACEHOLDER}${quote} data-coremail-ext-src=${quote}${trimmed}${quote}${after}>`;
  });

  // v3.18.36: (2) CSS `background-image: url(...)` in inline-`style`-Attributen
  // ist ein häufiger Tracker-Vektor — wir neutralisieren externe URLs und
  // sichern Original in `data-coremail-ext-bg` für späteres Re-Aktivieren.
  processed = processed.replace(
    /(style=)(["'])([^"']*?)background-image\s*:\s*url\(\s*(['"]?)([^"')]+)\4\s*\)([^"']*?)\2/gi,
    (_m, attrName: string, attrQuote: string, stylePrefix: string, _urlQuote: string, url: string, styleSuffix: string) => {
      const trimmed = url.trim();
      if (/^data:/i.test(trimmed) || /^cid:/i.test(trimmed)) {
        // Inline / CID — passieren lassen
        return _m;
      }
      // Extern → Background entfernen, Original speichern
      externalCount++;
      return `${attrName}${attrQuote}${stylePrefix}${styleSuffix}${attrQuote} data-coremail-ext-bg=${attrQuote}${trimmed}${attrQuote}`;
    },
  );

  return { html: processed, externalImageCount: externalCount };
}

interface Props {
  messageId: string;
}

export function MessageReader({ messageId }: Props) {
  const qc = useQueryClient();
  const { openCompose, setSelectedMessage, selectedFolderId } = useUiStore();
  const { accessToken } = useAuthStore();
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const [showAvatarCard, setShowAvatarCard] = useState(false);
  const [showRawSource, setShowRawSource] = useState(false);
  // Privacy: externe Bilder nur auf User-Anforderung laden (Tracking-Pixel-Schutz)
  const [showExternalImages, setShowExternalImages] = useState(false);
  // Reset des Toggle wenn auf eine andere Mail gewechselt wird
  useEffect(() => { setShowExternalImages(false); }, [messageId]);
  const [rawSource, setRawSource] = useState<string | null>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Token als URL-Query-Parameter für Browser-Navigationen (EML-Download, Quelltext),
  // da <a href> und window.open() keine Custom-Headers unterstützen.
  const tokenParam = accessToken ? `?token=${encodeURIComponent(accessToken)}` : '';

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

  const cancelScheduledMutation = useMutation({
    mutationFn: () => api.post(`/mail/messages/${messageId}/cancel-scheduled`, {}),
    onSuccess: invalidate,
  });

  if (isLoading) return <MessageReaderSkeleton />;
  if (!msg) return null;

  const isFlagged = msg.flags.includes('\\Flagged');
  const isPinned = !!msg.pinnedAt;

  // Ermitteln ob aktueller Ordner der Junk-Ordner ist (für bedingtes Menü-Item)
  const currentFolder = folders.find((f) => f.id === selectedFolderId);
  const isJunkFolder = currentFolder?.name === 'Junk';

  // \Answered-Flag setzen wenn Antworten/Allen antworten geklickt wird
  const markAnswered = () => {
    if (!msg.flags.includes('\\Answered')) {
      patchMutation.mutate({ flags: [...msg.flags, '\\Answered'] });
    }
  };

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
    isJunkFolder
      ? { label: 'Kein Junk (False Positive)', icon: <ShieldOff size={14} />,
          onClick: () => { bulkMutation.mutate({ ids: [msg.id], action: 'notSpam' }); setSelectedMessage(null); } }
      : { label: 'Als Junk markieren', icon: <AlertOctagon size={14} />,
          onClick: () => { bulkMutation.mutate({ ids: [msg.id], action: 'spam' }); setSelectedMessage(null); } },
    { type: 'divider' },
    { label: 'Quelltext anzeigen', icon: <Code size={14} />,
      onClick: () => {
        // Bearer-Token als Query-Param übergeben — raw fetch() ohne API-Client
        void fetch(`/api/v1/mail/messages/${msg.id}/raw${tokenParam}`, {
          headers: { 'Accept': 'text/plain, message/rfc822, */*' },
        }).then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        }).then(text => {
          setRawSource(text);
          setShowRawSource(true);
        }).catch((err: unknown) => {
          setRawSource(`Fehler beim Laden des Quelltexts: ${err instanceof Error ? err.message : String(err)}`);
          setShowRawSource(true);
        });
      } },
    { label: 'Als EML herunterladen', icon: <Download size={14} />,
      onClick: () => {
        // Token als URL-Param — Browser-Download unterstützt keine Custom-Headers
        const a = document.createElement('a');
        a.href = `/api/v1/mail/messages/${msg.id}/raw${tokenParam}`;
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
          onClick={() => { markAnswered(); openCompose({ mode: 'reply', id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr, bodyHtml: msg.bodyHtml || `<p>${msg.bodyText.replace(/\n/g, '<br>')}</p>` }); }}
          className="btn-secondary text-xs">
          <Reply size={14} /> Antworten
        </button>
        <button
          onClick={() => { markAnswered(); openCompose({ mode: 'replyAll', id: msg.id, subject: msg.subject, fromAddr: msg.fromAddr, toAddrs: msg.toAddrs, ccAddrs: msg.ccAddrs, bodyHtml: msg.bodyHtml || `<p>${msg.bodyText.replace(/\n/g, '<br>')}</p>` }); }}
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

      {/* Spam-Banner — Outlook-Style. Sichtbar wenn rspamd-Score ≥ 3.0 ODER Mail im Junk-Ordner liegt */}
      {(() => {
        const score = msg.spamScore ?? null;
        const showSpamBanner = (score !== null && score >= 3.0) || isJunkFolder;
        if (!showSpamBanner) return null;
        const isHighRisk = (score !== null && score >= 6.0);
        return (
          <div className={`px-4 py-2.5 border-b shrink-0 flex items-center gap-2.5 text-sm ${
            isHighRisk
              ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-900 dark:text-red-200'
              : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200'
          }`}>
            <ShieldAlert size={16} className={isHighRisk ? 'text-red-600 dark:text-red-300 shrink-0' : 'text-amber-600 dark:text-amber-300 shrink-0'} />
            <div className="flex-1 min-w-0">
              <p className="font-semibold leading-tight">
                {isHighRisk
                  ? 'Diese Nachricht wurde als Spam erkannt — möglicherweise gefährlich.'
                  : isJunkFolder
                    ? 'Diese Nachricht liegt im Junk-Ordner.'
                    : 'Diese Nachricht zeigt Spam-Signale.'}
              </p>
              <p className="text-xs opacity-80 leading-tight">
                {score !== null
                  ? <>rspamd-Score: <strong className="font-mono">{score.toFixed(2)}</strong> · Links nicht ohne Prüfung anklicken</>
                  : <>Klicken Sie unten auf „Kein Spam", falls diese Nachricht fälschlicherweise als Junk erkannt wurde.</>}
              </p>
            </div>
            {isJunkFolder ? (
              <button
                onClick={() => { bulkMutation.mutate({ ids: [msg.id], action: 'notSpam' }); setSelectedMessage(null); }}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-gray-800 border border-amber-300 dark:border-amber-700 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
                title="Diese Nachricht ist kein Spam (Bayes-Lernen)"
              >
                <ShieldCheck size={13} /> Kein Spam
              </button>
            ) : (
              <button
                onClick={() => { bulkMutation.mutate({ ids: [msg.id], action: 'spam' }); setSelectedMessage(null); }}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-gray-800 border border-red-300 dark:border-red-700 rounded hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                title="In Junk verschieben (Bayes-Lernen)"
              >
                <AlertOctagon size={13} /> Als Junk
              </button>
            )}
          </div>
        );
      })()}

      {/* Scheduled-Send-Banner (Outlook-Style) — sichtbar für PENDING/SENT/CANCELLED */}
      {msg.scheduledAt && msg.scheduledStatus && (
        <div className={`px-4 py-2.5 border-b shrink-0 flex items-center gap-2.5 text-sm ${
          msg.scheduledStatus === 'PENDING'   ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-900 dark:text-blue-200' :
          msg.scheduledStatus === 'SENT'      ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-900 dark:text-green-200' :
                                                 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300'
        }`}>
          {msg.scheduledStatus === 'PENDING' && <CalendarClock size={16} className="text-blue-600 dark:text-blue-300 shrink-0" />}
          {msg.scheduledStatus === 'SENT'    && <CheckCircle  size={16} className="text-green-600 dark:text-green-300 shrink-0" />}
          {msg.scheduledStatus === 'CANCELLED' && <X size={16} className="text-gray-500 shrink-0" />}
          <div className="flex-1 min-w-0">
            <p className="font-semibold leading-tight">
              {msg.scheduledStatus === 'PENDING'   ? 'Diese Nachricht wird geplant gesendet' :
               msg.scheduledStatus === 'SENT'      ? 'Geplanter Versand abgeschlossen' :
                                                     'Geplanter Versand abgebrochen'}
            </p>
            <p className="text-xs opacity-80 leading-tight">
              {msg.scheduledStatus === 'PENDING' ? 'Versand am ' : 'War geplant für '}
              <strong>{new Date(msg.scheduledAt).toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' })}</strong>
            </p>
          </div>
          {msg.scheduledStatus === 'PENDING' && (
            <button
              onClick={() => cancelScheduledMutation.mutate()}
              disabled={cancelScheduledMutation.isPending}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-gray-800 border border-blue-300 dark:border-blue-700 rounded hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors disabled:opacity-50"
              title="Planung abbrechen — Mail wird nicht gesendet"
            >
              <X size={13} /> Planung abbrechen
            </button>
          )}
        </div>
      )}

      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 shrink-0 animate-page-in">
        <div className="flex items-start gap-2 mb-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex-1">{msg.subject || '(kein Betreff)'}</h2>
          {isFlagged && <Flag size={16} className="fill-red-500 text-red-500 shrink-0 mt-1" />}
          {isPinned && <Pin size={16} className="text-accent shrink-0 mt-1" />}
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
            <p className="font-medium text-gray-900 dark:text-gray-100">{msg.fromName || msg.fromAddr.split('@')[0]}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">&lt;{msg.fromAddr}&gt;</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              An: <span className="text-gray-700 dark:text-gray-300">{msg.toAddrs.join(', ')}</span>
              {msg.ccAddrs?.length > 0 && (
                <> · CC: <span className="text-gray-700 dark:text-gray-300">{msg.ccAddrs.join(', ')}</span></>
              )}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500">{format(new Date(msg.date), 'EEEE, dd.MM.yyyy HH:mm')}</p>
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

      {/* Body — mit Privacy-Bilder-Banner (Outlook/Gmail-Style) */}
      {(() => {
        // Vorab: HTML pre-processen damit externe Bilder ggf. blockiert werden
        if (!msg.bodyHtml) {
          return (
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-sans">{msg.bodyText}</pre>
            </div>
          );
        }
        const inlineAtts = (msg.attachments ?? []).map((a) => ({
          id: a.id,
          contentId: a.contentId ?? null,
        }));
        const { html: processedHtml, externalImageCount } = processExternalImages(
          msg.bodyHtml,
          inlineAtts,
          tokenParam,
        );
        // v3.18.36: Wenn User auf „Bilder anzeigen" geklickt hat → originale URLs
        // wiederherstellen. Behandelt BEIDE Markierungen: data-coremail-ext-src
        // (für <img>) UND data-coremail-ext-bg (für CSS background-image).
        // Zusätzlich wird der Placeholder-Style (opacity, border) entfernt.
        let finalHtml = processedHtml;
        if (showExternalImages) {
          // (a) <img>-Tags: Placeholder-src + style zurücksetzen
          finalHtml = finalHtml.replace(
            /<img\b([^>]*?)src=(["'])data:image\/png;base64,iVBORw0KGgo[^"']+\2([^>]*?)data-coremail-ext-src=(["'])([^"']+)\4([^>]*?)>/gi,
            (_m, before: string, q: string, middle: string, _q2: string, original: string, after: string) => {
              // Placeholder-Style entfernen (style="opacity:0.5;border:1px dashed #ccc;...")
              const cleanMiddle = middle.replace(/\s*style=(["'])opacity:0\.5;border:1px dashed #ccc[^"']*\1/i, '');
              const cleanAfter  = after.replace(/\s*style=(["'])opacity:0\.5;border:1px dashed #ccc[^"']*\1/i, '');
              return `<img${before}src=${q}${original}${q}${cleanMiddle}${cleanAfter}>`;
            },
          );
          // (b) data-coremail-ext-bg → background-image: url(...) wieder einsetzen
          finalHtml = finalHtml.replace(
            /(style=(["']))([^"']*?)\2([^>]*?)data-coremail-ext-bg=(["'])([^"']+)\5/gi,
            (_m, _styleAttr: string, q: string, stylePart: string, middle: string, _q2: string, url: string) => {
              const sep = stylePart.trim().length > 0 && !stylePart.trim().endsWith(';') ? ';' : '';
              return `style=${q}${stylePart}${sep}background-image:url("${url}")${q}${middle}`;
            },
          );
        }

        return (
          <>
            {externalImageCount > 0 && !showExternalImages && (
              <div className="px-4 py-2.5 border-b border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 flex items-center gap-2.5 text-sm shrink-0">
                <ImageIcon size={16} className="text-blue-600 dark:text-blue-300 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-blue-900 dark:text-blue-200 leading-tight">
                    {externalImageCount === 1
                      ? '1 externes Bild wurde blockiert.'
                      : `${externalImageCount} externe Bilder wurden blockiert.`}
                  </p>
                  <p className="text-xs text-blue-800/80 dark:text-blue-300/80 leading-tight">
                    Externe Bilder können verwendet werden, um Ihr Lese-Verhalten zu verfolgen (Tracking-Pixel).
                  </p>
                </div>
                <button
                  onClick={() => setShowExternalImages(true)}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-gray-800 border border-blue-300 dark:border-blue-700 rounded hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
                  title="Externe Bilder einmalig nachladen"
                >
                  <ImageIcon size={13} /> Bilder anzeigen
                </button>
              </div>
            )}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div
                className="prose prose-sm dark:prose-invert max-w-none"
                dangerouslySetInnerHTML={{ __html: sanitize(finalHtml) }}
              />
            </div>
          </>
        );
      })()}

      {moreMenu && <ContextMenu x={moreMenu.x} y={moreMenu.y} items={moreItems} onClose={() => setMoreMenu(null)} />}

      {/* RFC 822 Quelltext-Modal */}
      {showRawSource && rawSource !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowRawSource(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 flex items-center gap-2">
                <Code size={14} /> RFC 822 Quelltext
              </span>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/v1/mail/messages/${msg.id}/raw`}
                  download={`${msg.subject || 'message'}.eml`}
                  className="btn-secondary text-xs"
                >
                  <Download size={12} /> .eml herunterladen
                </a>
                <button className="btn-ghost p-1" onClick={() => setShowRawSource(false)}>
                  <X size={16} />
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-gray-800 dark:text-gray-200 leading-relaxed whitespace-pre-wrap break-all">
              {rawSource}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
