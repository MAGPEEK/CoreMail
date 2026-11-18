import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, ImageOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { toastError } from '../lib/errors.js';
import { renderMailHtml } from '../lib/mailHtml.js';
import { useInlineImages } from '../hooks/useInlineImages.js';
import { useExternalImages } from '../hooks/useExternalImages.js';
import { useWebmailFeatures } from '../hooks/useWebmailFeatures.js';
import { inlinePreviewAllowed, showExternalImages, type ExternalImageDecision } from '../lib/webmailFeatures.js';

interface MailAttachment {
  id: string;
  filename?: string | null;
  contentId?: string | null;
  mimeType?: string | null;
}

/**
 * Isolation of untrusted mail markup: its own stacking context and layout/paint
 * containment, so nothing in the mail can overlay the application UI (fixed
 * and sticky positioning are already rewritten by the CSS filter; this is the
 * second line of defence). Horizontal overflow scrolls instead of clipping wide
 * newsletters.
 */
export const MAIL_BODY_STYLE: CSSProperties = {
  contain: 'layout paint',
  isolation: 'isolate',
  position: 'relative',
  overflowX: 'auto',
  overflowY: 'hidden',
};

/**
 * Sender HTML is written for a white page (dark text, light backgrounds, transparent
 * images). It is therefore always rendered on a fixed light "paper" with
 * `color-scheme: light`, in both app themes; the frame around it uses the tokens.
 */
// theme-guard-ignore: sender HTML assumes a light page
export const MAIL_PAPER_CLASS = 'bg-white text-gray-900';
const MAIL_PAPER_STYLE: CSSProperties = { ...MAIL_BODY_STYLE, colorScheme: 'light' };

/**
 * Sanitized mail HTML with inline (cid:) images, the external-image privacy
 * toggle and image-proxy loading. `resetKey` (the message id) resets the toggle.
 * 9.4 webmail policy: `decision` (from the server, per mail) loads the external
 * images at once or never; "save only" attachment types are not shown inline.
 */
export function useMailHtml(
  html: string | undefined,
  attachments: MailAttachment[] | undefined,
  resetKey: string,
  decision: ExternalImageDecision = 'ask',
) {
  const [clicked, setShowExternal] = useState(false);
  useEffect(() => { setShowExternal(false); }, [resetKey]);
  const showExternal = showExternalImages(decision, clicked);
  const { content } = useWebmailFeatures();
  const previewable = useMemo(
    () => attachments?.filter((a) => inlinePreviewAllowed(a, content)),
    [attachments, content],
  );

  // Inline (cid:) images are fetched with the Authorization header → blob: URLs
  const cidMap = useInlineImages(html, previewable);
  // Blocked render: privacy filter + list of external image URLs
  const base = useMemo(
    () => (html ? renderMailHtml(html, { cidMap }) : null),
    [html, cidMap],
  );
  // "Show images": load the external images through the image proxy (CSP-safe blob: URLs)
  const externalMap = useExternalImages(base?.externalUrls ?? [], showExternal);
  const rendered = useMemo(
    () => (html && externalMap.size > 0 ? renderMailHtml(html, { cidMap, externalMap }) : base),
    [html, cidMap, externalMap, base],
  );

  return {
    html: rendered?.html ?? '',
    blockedCount: showExternal ? 0 : base?.blockedCount ?? 0,
    showExternal,
    setShowExternal,
    decision,
  };
}

interface MailBodyProps {
  messageId: string;
  html: string;
  attachments?: MailAttachment[] | undefined;
  /** Classes of the scroll container around the body */
  scrollClassName?: string;
  /** Classes of the body element itself (typography) */
  bodyClassName?: string;
  /** 9.4: the server's external-image decision for this mail (webmail policy, trusted senders). */
  imageDecision?: ExternalImageDecision | undefined;
  /** 9.4: sender address — "always show images from this sender". */
  sender?: string | undefined;
}

/** Renders a sanitized HTML mail body with the "external images blocked" banner. */
export function MailBody({ messageId, html, attachments, scrollClassName, bodyClassName, imageDecision, sender }: MailBodyProps) {
  const mail = useMailHtml(html, attachments, messageId, imageDecision);
  const qc = useQueryClient();
  const trustSender = () => {
    if (!sender) return;
    api.post('/user/trusted-senders', { sender })
      .then(() => {
        mail.setShowExternal(true);
        void qc.invalidateQueries({ queryKey: ['trusted-senders'] });
        toast.success(`Bilder von ${sender} werden künftig immer angezeigt`, { duration: 2500 });
      })
      .catch(toastError);
  };
  return (
    <>
      {mail.blockedCount > 0 && mail.decision === 'block' && (
        <div className="px-4 py-2.5 border-b border-line bg-surface-2 flex items-center gap-2.5 text-sm shrink-0">
          <ImageOff size={16} className="text-fg-muted shrink-0" aria-hidden="true" />
          <p className="text-xs text-fg-muted leading-tight">
            {mail.blockedCount === 1 ? '1 externes Bild wurde blockiert.' : `${mail.blockedCount} externe Bilder wurden blockiert.`}
            {' '}Externe Bilder sind für Ihr Konto gesperrt.
          </p>
        </div>
      )}
      {mail.blockedCount > 0 && !mail.showExternal && mail.decision !== 'block' && (
        <div className="px-4 py-2.5 border-b border-info-line bg-info-bg flex items-center gap-2.5 text-sm shrink-0">
          <ImageIcon size={16} className="text-info-fg shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-info-fg leading-tight">
              {mail.blockedCount === 1
                ? '1 externes Bild wurde blockiert.'
                : `${mail.blockedCount} externe Bilder wurden blockiert.`}
            </p>
            <p className="text-xs text-info-fg leading-tight">
              Externe Bilder können verwendet werden, um Ihr Lese-Verhalten zu verfolgen (Tracking-Pixel).
            </p>
          </div>
          <button
            type="button"
            onClick={() => mail.setShowExternal(true)}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface text-fg border border-line-strong rounded hover:bg-surface-2 transition-colors"
            title="Externe Bilder über den Server-Proxy nachladen"
          >
            <ImageIcon size={13} aria-hidden="true" /> Bilder anzeigen
          </button>
          {sender && (
            <button
              type="button"
              onClick={trustSender}
              className="shrink-0 px-3 py-1.5 text-xs font-medium text-info-fg hover:underline"
              title={`Externe Bilder in Mails von ${sender} immer anzeigen`}
            >
              Immer von diesem Absender
            </button>
          )}
        </div>
      )}
      <div className={scrollClassName}>
        <div
          className={`${MAIL_PAPER_CLASS} rounded-md border border-line p-4 ${bodyClassName ?? ''}`}
          style={MAIL_PAPER_STYLE}
          // eslint-disable-next-line react/no-danger -- sanitized with DOMPurify (lib/mailHtml.ts)
          dangerouslySetInnerHTML={{ __html: mail.html }}
        />
      </div>
    </>
  );
}
