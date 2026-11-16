import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { renderMailHtml } from '../lib/mailHtml.js';
import { useInlineImages } from '../hooks/useInlineImages.js';
import { useExternalImages } from '../hooks/useExternalImages.js';

interface MailAttachment {
  id: string;
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
 */
export function useMailHtml(
  html: string | undefined,
  attachments: MailAttachment[] | undefined,
  resetKey: string,
) {
  const [showExternal, setShowExternal] = useState(false);
  useEffect(() => { setShowExternal(false); }, [resetKey]);

  // Inline (cid:) images are fetched with the Authorization header → blob: URLs
  const cidMap = useInlineImages(html, attachments);
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
}

/** Renders a sanitized HTML mail body with the "external images blocked" banner. */
export function MailBody({ messageId, html, attachments, scrollClassName, bodyClassName }: MailBodyProps) {
  const mail = useMailHtml(html, attachments, messageId);
  return (
    <>
      {mail.blockedCount > 0 && !mail.showExternal && (
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
