import DOMPurify from 'dompurify';

/**
 * Sanitizes untrusted mail HTML before it is rendered with dangerouslySetInnerHTML.
 * Shared by every view that shows a message body (own mailbox, shared mailboxes).
 *
 * v3.18.36: DOMPurify without configuration removes our privacy markers
 * (`data-coremail-ext-src`, transparent PNG placeholder), so they are
 * whitelisted here. Tracking vectors `<style>`, `<link>` and JS event handlers
 * are blocked explicitly.
 */
export function sanitizeMailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    // Whitelist our privacy markers + data: URI for the placeholder
    ADD_ATTR: ['data-coremail-ext-src', 'data-coremail-unresolved-cid', 'data-coremail-ext-bg'],
    ALLOW_DATA_ATTR: true,
    // Completely block tracking-relevant tags + event handlers
    FORBID_TAGS: ['script', 'style', 'link', 'iframe', 'object', 'embed', 'meta', 'base'],
    FORBID_ATTR: [
      'onload', 'onerror', 'onclick', 'onmouseover', 'onmouseenter', 'onmouseleave',
      'onfocus', 'onblur', 'onkeydown', 'onkeyup', 'onsubmit', 'onchange',
      'ping', 'srcset', // srcset could contain a tracking URL
    ],
    // Explicitly allow data:image for our placeholder, http(s) for CID-resolved URLs
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data:image\/[a-z]+;base64,):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}
