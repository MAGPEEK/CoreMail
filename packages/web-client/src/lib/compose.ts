/**
 * Pure compose helpers (no imports, no DOM) — unit-tested with `node --test`.
 */

/**
 * Validates a user-entered link target for the editors. Only http(s) and
 * mailto are allowed; a bare host ("example.com") becomes https://. Returns the
 * normalised URL or null (javascript:, data:, vbscript:, relative paths …).
 */
export function safeLinkUrl(input: string): string | null {
  // eslint-disable-next-line no-control-regex
  const raw = input.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return parsed.hostname ? parsed.href : null;
  }
  if (parsed.protocol === 'mailto:') return withScheme;
  return null;
}

/** A Message-ID header value in angle brackets, or null if it does not look like one. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  const bare = v.replace(/^<|>$/g, '').trim();
  if (!bare || /[\s<>]/.test(bare)) return null;
  return `<${bare}>`;
}

export interface OriginalMessageRef {
  /** Internal database id of the original message */
  id: string;
  /** RFC 5322 Message-ID header of the original (null for some imported mails) */
  messageId?: string | null;
  /** In-Reply-To header of the original */
  inReplyTo?: string | null;
}

/**
 * Threading fields for a reply (RFC 5322 §3.6.4): In-Reply-To is the original
 * Message-ID; References is the original's parent (the only ancestor the API
 * exposes) followed by the original Message-ID. Without a Message-ID header the
 * internal id is sent as inReplyTo (the server resolves internal ids) and no
 * References are sent.
 */
export function replyThreading(orig: OriginalMessageRef): { inReplyTo: string; references?: string } {
  const mid = normalizeMessageId(orig.messageId);
  if (!mid) return { inReplyTo: orig.id };
  const parent = normalizeMessageId(orig.inReplyTo);
  const refs = parent && parent !== mid ? `${parent} ${mid}` : mid;
  return { inReplyTo: mid, references: refs };
}

/**
 * Splits a comma/semicolon separated recipient field into entries, keeping
 * quoted display names together (`"Doe, John" <j@x>`). Empty entries are dropped.
 */
export function splitRecipients(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"' && !angle) quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
