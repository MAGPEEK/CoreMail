/**
 * 9.4: "forgotten attachment" check before sending (Settings → Verfassen).
 * Looks for attachment words (German + English) in the subject and the newly
 * written text — quoted originals of replies/forwards are ignored. No imports —
 * unit-tested with `node --test`.
 */
export const ATTACHMENT_KEYWORDS: readonly string[] = [
  // German
  'anhang', 'anhänge', 'angehängt', 'anbei', 'beigefügt', 'beiliegend', 'im anhang', 'anlage', 'anlagen', 'datei',
  // English
  'attachment', 'attachments', 'attached', 'attach', 'enclosed', 'see the file', 'herewith',
];

/** Plain text of the part the user wrote: quoted originals (blockquotes, "> " lines) removed. */
export function ownText(html: string): string {
  return html
    // 9.4: the marked quote of a reply / forward is the end of the body (it may nest blockquotes)
    .replace(/<blockquote data-cm-quote[\s\S]*$/i, ' ')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join(' ');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The first attachment word found, or null. */
export function attachmentKeyword(subject: string, html: string, keywords: readonly string[] = ATTACHMENT_KEYWORDS): string | null {
  const text = `${subject} ${ownText(html)}`.toLowerCase();
  for (const k of keywords) {
    if (new RegExp(`(^|[^\\p{L}])${escapeRe(k)}($|[^\\p{L}])`, 'u').test(text)) return k;
  }
  return null;
}

/** Ask before sending? Only when the check is on, nothing is attached and a word matched. */
export function needsAttachmentReminder(enabled: boolean, attachmentCount: number, subject: string, html: string): string | null {
  if (!enabled || attachmentCount > 0) return null;
  return attachmentKeyword(subject, html);
}
