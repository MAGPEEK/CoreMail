/**
 * 9.4: subject and quoted original of a reply / forward. The original sits
 * below a separator with a header block (Von / Gesendet / An / Cc / Betreff),
 * inside one `<blockquote data-cm-quote>` so the signature goes above it, the
 * forgotten-attachment check ignores it and a long quote can be folded.
 * Pure — unit-tested with `node --test`. Every value from the original is escaped;
 * the original body must already be sanitised (lib/mailHtml.ts quoteMailHtml).
 */
import { escapeHtml } from './mailHtmlCss.ts';

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

/** Marker attribute of the quoted original (editor: global attribute on blockquote). */
export const QUOTE_ATTR = 'data-cm-quote';

export const isReplyMode = (mode: ComposeMode | undefined): boolean => mode === 'reply' || mode === 'replyAll';

/** "Re: " / "Fwd: " in front of the original subject, unless it already has a reply/forward prefix. */
export function subjectFor(mode: ComposeMode | undefined, subject: string | undefined): string {
  if (!subject) return '';
  if (/^(Re|Fwd|Fw|AW|WG):/i.test(subject)) return subject;
  if (isReplyMode(mode)) return `Re: ${subject}`;
  if (mode === 'forward') return `Fwd: ${subject}`;
  return subject;
}

export interface QuoteSource {
  fromAddr: string;
  fromName?: string | undefined;
  /** ISO date of the original (absent: no "Gesendet" line). */
  date?: string | undefined;
  toAddrs?: readonly string[] | undefined;
  ccAddrs?: readonly string[] | undefined;
  subject?: string | undefined;
}

export interface QuoteLabels { from: string; sent: string; to: string; cc: string; subject: string }

const person = (addr: string, name?: string) => (name && name !== addr ? `${name} <${addr}>` : addr);

/** Header lines of the quoted original, label → value (empty values left out). */
export function quoteHeaderLines(src: QuoteSource, labels: QuoteLabels, formatDate: (d: Date) => string): Array<[string, string]> {
  const date = src.date ? new Date(src.date) : null;
  const lines: Array<[string, string]> = [
    [labels.from, person(src.fromAddr, src.fromName)],
    [labels.sent, date && !Number.isNaN(date.getTime()) ? formatDate(date) : ''],
    [labels.to, (src.toAddrs ?? []).join('; ')],
    [labels.cc, (src.ccAddrs ?? []).join('; ')],
    [labels.subject, src.subject ?? ''],
  ];
  return lines.filter(([, v]) => v.trim().length > 0);
}

/** The quoted original: separator, header block, then the (sanitised) original body. */
export function buildQuoteHtml(src: QuoteSource, sanitizedBody: string, labels: QuoteLabels, formatDate: (d: Date) => string): string {
  const header = quoteHeaderLines(src, labels, formatDate)
    .map(([k, v]) => `<strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}`)
    .join('<br>');
  return `<blockquote ${QUOTE_ATTR}=""><hr><p>${header}</p>${sanitizedBody || '<p></p>'}</blockquote>`;
}

/**
 * Body of a new compose: an empty line to type in (10.1: or the body of the
 * template the mail starts from), the signature block, then the quote.
 */
export function initialBodyHtml(signatureBlock: string, quoteHtml: string, leadHtml = ''): string {
  if (!signatureBlock && !quoteHtml && !leadHtml) return '';
  return `${leadHtml || '<p></p>'}${signatureBlock}${quoteHtml ? `<p></p>${quoteHtml}` : ''}`;
}

/** Plain text → one escaped paragraph per line (plain-text drafts, switching to plain text). */
export function textToParagraphsHtml(text: string): string {
  return text.split(/\r?\n/).map((l) => `<p>${escapeHtml(l)}</p>`).join('');
}

/** Visible text length / block count from which a reply quote starts folded behind "…". */
export const LONG_QUOTE_CHARS = 600;
export const LONG_QUOTE_BLOCKS = 12;

export function isLongQuote(html: string): boolean {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  const blocks = (html.match(/<(p|div|li|tr|blockquote|h[1-6]|pre)\b/gi) ?? []).length;
  return text.length > LONG_QUOTE_CHARS || blocks > LONG_QUOTE_BLOCKS;
}

/** The marked quote of a saved body ('' without one) — a reopened reply draft folds it too. */
export function quotedPart(html: string): string {
  const i = html.indexOf(`<blockquote ${QUOTE_ATTR}`);
  return i < 0 ? '' : html.slice(i);
}

/** Replies fold a long quote (the forwarded mail is the point of a forward: shown). */
export function quoteStartsFolded(mode: ComposeMode | undefined, quoteHtml: string): boolean {
  return isReplyMode(mode) && !!quoteHtml && isLongQuote(quoteHtml);
}
