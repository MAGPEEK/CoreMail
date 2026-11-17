/**
 * index.html branding injection (9.3) for the webmail and the BCP.
 *
 * Before `</head>` the gateway injects
 *   <style id="cm-brand">:root{--brand-primary:R G B}</style>
 *   <script id="cm-branding" type="application/json">…public branding JSON…</script>
 * replaces `<title>` with the product name and the favicon `<link rel="icon">`
 * (favicon, else logoLight; the built-in icon stays when neither is set), so the
 * SPA renders branded before its first fetch (`--brand-primary` is the initial
 * `--color-accent` in the apps' tokens.css until the theme code applies the
 * contrast-adjusted values). The JSON is escaped for a script
 * context (`<`, `>`, `&`, U+2028/2029 as \uXXXX), so no value can close the tag.
 */
import type { PublicBranding } from '@coremail/storage';
import { rgbChannels } from './color.js';
import { EXT_CONTENT_TYPE } from './image.js';

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** JSON safe inside <script type="application/json"> (and any other HTML context). */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(LS).join('\\u2028')
    .split(PS).join('\\u2029');
}

/** Favicon URL for the page: favicon, else logoLight, else null (keep the built-in icon). */
export function faviconHref(b: PublicBranding): string | null {
  return b.assets.favicon ?? b.assets.logoLight ?? null;
}

const ICON_LINK_RE = /<link\b[^>]*\brel\s*=\s*["']?(?:shortcut\s+)?icon["']?[^>]*>\s*/gi;
const OWN_STYLE_RE = /<style\b[^>]*\bid\s*=\s*["']?cm-brand["']?[^>]*>[\s\S]*?<\/style>\s*/gi;
const OWN_SCRIPT_RE = /<script\b[^>]*\bid\s*=\s*["']?cm-branding["']?[^>]*>[\s\S]*?<\/script>\s*/gi;
const TITLE_RE = /<title\b[^>]*>[\s\S]*?<\/title>/i;

/** Renders the branded index.html from the bundle's template. */
export function renderBrandedIndex(template: string, b: PublicBranding): string {
  let html = template.replace(OWN_STYLE_RE, '').replace(OWN_SCRIPT_RE, '');

  const title = `<title>${escHtml(b.productName)}</title>`;
  html = TITLE_RE.test(html) ? html.replace(TITLE_RE, () => title) : injectHead(html, title);

  const icon = faviconHref(b);
  if (icon) {
    const ext = icon.slice(icon.lastIndexOf('.') + 1);
    const link = `<link rel="icon" type="${escHtml(EXT_CONTENT_TYPE[ext] ?? 'image/png')}" href="${escHtml(icon)}" />`;
    html = injectHead(html.replace(ICON_LINK_RE, ''), link);
  }

  const parts: string[] = [];
  if (b.primaryColor) parts.push(`<style id="cm-brand">:root{--brand-primary:${rgbChannels(b.primaryColor)}}</style>`);
  parts.push(`<script id="cm-branding" type="application/json">${jsonForScript(b)}</script>`);
  return injectHead(html, parts.join('\n'));
}

function injectHead(html: string, fragment: string): string {
  const i = html.search(/<\/head\s*>/i);
  if (i >= 0) return `${html.slice(0, i)}${fragment}\n${html.slice(i)}`;
  return `${fragment}\n${html}`;
}
