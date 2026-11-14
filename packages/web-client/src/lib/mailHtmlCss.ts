/**
 * Pure string helpers for the mail HTML privacy filter (no imports, no DOM),
 * so they can be unit-tested with `node --test`.
 *
 * Used by lib/mailHtml.ts inside DOMPurify hooks.
 */

/** 1×1 transparent PNG used in place of blocked images. */
export const PLACEHOLDER_IMG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * - `inline`:   embedded in the mail (data: URI) or empty → no network request
 * - `cid`:      reference to a MIME part of the mail (resolved by the caller)
 * - `external`: anything else (http(s), protocol-relative, relative paths, unknown schemes)
 */
export type UrlKind = 'inline' | 'cid' | 'external';

export function classifyUrl(raw: string): UrlKind {
  // Browsers ignore leading/trailing C0 controls + spaces and strip tab/CR/LF anywhere
  // ("ht\ttp://x" is a valid http URL) — normalise the same way before checking.
  // eslint-disable-next-line no-control-regex
  const u = raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  if (u === '') return 'inline';
  if (/^data:/i.test(u)) return 'inline';
  if (/^cid:/i.test(u)) return 'cid';
  return 'external';
}

/** Normalised Content-ID (without `cid:`, angle brackets, lower-case). */
export function normalizeCid(value: string): string {
  return value.trim().replace(/^cid:/i, '').replace(/^<|>$/g, '').trim().toLowerCase();
}

/**
 * Decodes CSS escapes (`\75 rl(` → `url(`, `\u` → `u`) and removes comments, so
 * obfuscated `url()` references cannot slip past the filter.
 */
export function decodeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_m, hex: string) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\uFFFD';
    })
    .replace(/\\([^\n\r\f0-9a-fA-F])/g, '$1');
}

/** Splits a style attribute into declarations (`;` outside strings/parentheses). */
export function splitCssDeclarations(css: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')' && depth > 0) depth--;
    if (ch === ';' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Functions that can load resources without a url() token (bare strings allowed)
const IMAGE_FUNCTIONS = /(?:^|[^a-z-])(?:-webkit-)?(?:image-set|cross-fade|element|image|paint)\s*\(/i;
// Legacy script/binding vectors — always removed
const DANGEROUS = /expression\s*\(|javascript:|vbscript:|-moz-binding|behaviou?r\s*:|@import/i;
const URL_TOKEN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;

export interface StyleFilterOptions {
  allowExternal: boolean;
  /** Maps a normalised Content-ID to a loadable URL (e.g. blob:), or null if unknown */
  resolveCid: (cid: string) => string | null;
}

/**
 * Removes every declaration that would load an external resource (unless
 * `allowExternal`), rewrites `url(cid:…)` to resolved URLs and drops script
 * vectors. Returns the new style and the number of blocked declarations.
 */
export function filterStyle(style: string, opts: StyleFilterOptions): { style: string; blocked: number } {
  let blocked = 0;
  const kept: string[] = [];
  for (const decl of splitCssDeclarations(decodeCss(style))) {
    if (DANGEROUS.test(decl)) continue;
    if (!opts.allowExternal && IMAGE_FUNCTIONS.test(decl)) { blocked++; continue; }

    const urlCount = (decl.match(/url\s*\(/gi) ?? []).length;
    let matched = 0;
    let drop = false;
    let isBlocked = false;
    const rewritten = decl.replace(URL_TOKEN, (m, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
      matched++;
      const target = dq ?? sq ?? bare ?? '';
      const kind = classifyUrl(target);
      if (kind === 'inline') return m;
      if (kind === 'cid') {
        const resolved = opts.resolveCid(normalizeCid(target));
        if (resolved) return `url("${resolved.replace(/["\\]/g, '')}")`;
        drop = true;
        return m;
      }
      if (!opts.allowExternal) { drop = true; isBlocked = true; }
      return m;
    });
    // url( tokens we could not parse are treated as external
    if (matched !== urlCount && !opts.allowExternal) { drop = true; isBlocked = true; }
    if (drop) { if (isBlocked) blocked++; continue; }
    kept.push(rewritten);
  }
  return { style: kept.join('; '), blocked };
}

/**
 * True if a srcset certainly causes no network request: empty, or exactly one
 * data: candidate. Anything else (several candidates, any URL) is treated as
 * external — commas inside data: URIs make a precise split ambiguous, and
 * over-blocking is the safe side.
 */
export function srcsetIsInlineOnly(srcset: string): boolean {
  const s = srcset.trim();
  if (!s) return true;
  return /^data:\S+(\s+[\d.]+[wx])?$/i.test(s) && !/,\s+\S/.test(s);
}
