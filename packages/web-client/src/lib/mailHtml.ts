import DOMPurify from 'dompurify';
import {
  PLACEHOLDER_IMG, classifyUrl, normalizeCid, filterStyle, srcsetIsInlineOnly,
} from './mailHtmlCss.js';

/**
 * Sanitizes untrusted mail HTML before it is rendered with dangerouslySetInnerHTML.
 * Shared by every view that shows a message body (own mailbox, shared mailboxes).
 *
 * Privacy (external images / tracking pixels) is enforced INSIDE DOMPurify via an
 * `afterSanitizeAttributes` hook, i.e. on the parsed DOM — not with regexes on the
 * raw HTML, which were bypassable (unquoted src, `background=`, `poster=`,
 * `srcset`, CSS `background:` shorthand, escaped `url()` …). Covered:
 *   - src / lowsrc / dynsrc (img, input type=image, video, audio, source, track …)
 *   - srcset, poster, background
 *   - SVG href / xlink:href on <image>, <use>, <feImage>
 *   - style attributes: url(), image-set(), cross-fade(), element() (escapes decoded)
 * Blocked images get a transparent placeholder (`data-coremail-blocked`), the
 * original value is kept in `data-coremail-ext-<attr>` for diagnostics.
 * cid: references are rewritten via `cidMap` (e.g. to blob: URLs).
 * Links open in a new tab with rel="noopener noreferrer".
 */

export interface MailHtmlOptions {
  /** User clicked "show images" — external resources are left in place */
  allowExternalImages?: boolean;
  /** normalised Content-ID → loadable URL (blob:) for inline images */
  cidMap?: ReadonlyMap<string, string>;
}

export interface MailHtmlResult {
  html: string;
  /** Number of blocked external references (0 when allowExternalImages) */
  blockedCount: number;
  /** Content-IDs referenced by the mail that are not (yet) in cidMap */
  unresolvedCids: string[];
}

const purifier = DOMPurify(window);

const BASE_CONFIG = {
  // Our markers + link targets
  ADD_ATTR: ['target', 'data-coremail-blocked', 'data-coremail-unresolved-cid'],
  ALLOW_DATA_ATTR: true,
  // Completely block tracking-relevant tags (incl. <style> — CSS would bypass the
  // attribute filter) + forms (credential phishing)
  FORBID_TAGS: ['script', 'style', 'link', 'iframe', 'frame', 'frameset', 'object', 'embed', 'meta', 'base', 'form'],
  FORBID_ATTR: [
    'onload', 'onerror', 'onclick', 'onmouseover', 'onmouseenter', 'onmouseleave',
    'onfocus', 'onblur', 'onkeydown', 'onkeyup', 'onsubmit', 'onchange',
    'ping', 'formaction', 'action',
  ],
  // http(s)/mailto/tel links, cid: (rewritten in the hook), relative/scheme-less values
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

const URL_ATTRS = ['src', 'lowsrc', 'dynsrc', 'poster', 'background'] as const;
const SVG_RESOURCE_TAGS = new Set(['image', 'use', 'feimage']);
const PLACEHOLDER_TAGS = new Set(['img', 'input']);

export function renderMailHtml(html: string, opts: MailHtmlOptions = {}): MailHtmlResult {
  const allowExternal = opts.allowExternalImages === true;
  const cidMap = opts.cidMap ?? new Map<string, string>();
  let blockedCount = 0;
  const unresolved = new Set<string>();

  const resolveCid = (cid: string): string | null => {
    const url = cidMap.get(cid);
    if (!url) unresolved.add(cid);
    return url ?? null;
  };

  const block = (el: Element, attr: string, value: string) => {
    blockedCount++;
    el.setAttribute(`data-coremail-ext-${attr.replace(/[^a-z-]/gi, '-')}`, value);
    if (attr === 'src' && PLACEHOLDER_TAGS.has(el.tagName.toLowerCase())) {
      el.setAttribute('src', PLACEHOLDER_IMG);
      el.setAttribute('data-coremail-blocked', '1');
    } else {
      el.removeAttribute(attr);
    }
  };

  const hook = (node: Element) => {
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();

    // 1. URL-valued attributes
    for (const attr of URL_ATTRS) {
      const value = node.getAttribute(attr);
      if (value === null) continue;
      const kind = classifyUrl(value);
      if (kind === 'inline') continue;
      if (kind === 'cid') {
        const cid = normalizeCid(value);
        const url = resolveCid(cid);
        if (url) {
          node.setAttribute(attr, url);
        } else if (attr === 'src' && PLACEHOLDER_TAGS.has(tag)) {
          node.setAttribute('src', PLACEHOLDER_IMG);
          node.setAttribute('data-coremail-unresolved-cid', cid);
        } else {
          node.removeAttribute(attr);
        }
        continue;
      }
      if (!allowExternal) block(node, attr, value);
    }

    // 2. srcset (img/source)
    const srcset = node.getAttribute('srcset');
    if (srcset !== null && !allowExternal && !srcsetIsInlineOnly(srcset)) block(node, 'srcset', srcset);

    // 3. SVG resource references
    if (SVG_RESOURCE_TAGS.has(tag)) {
      for (const attr of ['href', 'xlink:href']) {
        const value = node.getAttribute(attr);
        if (value === null) continue;
        const kind = classifyUrl(value);
        // Same-document fragment references (#id) are harmless
        if (kind === 'inline' || value.trim().startsWith('#')) continue;
        if (kind === 'cid' || !allowExternal) block(node, attr, value);
      }
    }

    // 4. Inline CSS
    const style = node.getAttribute('style');
    if (style !== null) {
      const res = filterStyle(style, { allowExternal, resolveCid });
      blockedCount += res.blocked;
      if (res.style) node.setAttribute('style', res.style);
      else node.removeAttribute('style');
    }

    // 5. Links: new tab, no opener, no referrer leak
    if ((tag === 'a' || tag === 'area') && node.hasAttribute('href')) {
      const href = node.getAttribute('href') ?? '';
      if (!href.trim().startsWith('#')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  };

  purifier.addHook('afterSanitizeAttributes', hook);
  let out: string;
  try {
    out = purifier.sanitize(html, BASE_CONFIG) as unknown as string;
  } finally {
    purifier.removeHook('afterSanitizeAttributes');
  }
  return { html: out, blockedCount, unresolvedCids: [...unresolved] };
}

/** Backwards-compatible helper: sanitizes and blocks all external resources. */
export function sanitizeMailHtml(html: string): string {
  return renderMailHtml(html).html;
}

/** Content-IDs referenced by a mail body (cid: in src/background/style). Cheap pre-scan. */
export function referencedCids(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/cid:([^"'\s)>]+)/gi)) out.add(normalizeCid(m[1]!));
  return [...out];
}
