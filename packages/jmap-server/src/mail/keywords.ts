/**
 * IMAP flags ↔ JMAP keywords (RFC 8621 §4.1.1) and folder roles (RFC 8621 §2, RFC 8457).
 */

const FLAG_TO_KEYWORD: Record<string, string> = {
  '\\Seen': '$seen',
  '\\Flagged': '$flagged',
  '\\Answered': '$answered',
  '\\Draft': '$draft',
  '$Forwarded': '$forwarded',
  '\\Forwarded': '$forwarded',
  '$Phishing': '$phishing',
  '$Junk': '$junk',
  '$NotJunk': '$notjunk',
};
const KEYWORD_TO_FLAG: Record<string, string> = {
  '$seen': '\\Seen',
  '$flagged': '\\Flagged',
  '$answered': '\\Answered',
  '$draft': '\\Draft',
  '$forwarded': '$Forwarded',
  '$phishing': '$Phishing',
  '$junk': '$Junk',
  '$notjunk': '$NotJunk',
};

export function flagsToKeywords(flags: string[]): Record<string, true> {
  const out: Record<string, true> = {};
  for (const f of flags) {
    if (f === '\\Recent' || f === '\\Deleted') continue;
    const kw = FLAG_TO_KEYWORD[f] ?? (f.startsWith('\\') ? null : f.toLowerCase());
    if (kw) out[kw] = true;
  }
  return out;
}

/**
 * Keyword → IMAP flag. Keywords are case-insensitive (RFC 8621 §4.1.1), so custom
 * keywords are normalised to lower case; `existing` (the message's current flags)
 * lets an unchanged custom flag keep its original IMAP spelling.
 */
export function keywordToFlag(keyword: string, existing: readonly string[] = []): string {
  const lower = keyword.toLowerCase();
  const system = KEYWORD_TO_FLAG[lower];
  if (system) return system;
  return existing.find((f) => !f.startsWith('\\') && f.toLowerCase() === lower) ?? lower;
}

/**
 * All spellings a stored IMAP flag may have for `keyword` (for hasKeyword
 * filters/sorts; the database compares array elements case-sensitively).
 */
export function flagVariants(keyword: string): string[] {
  const lower = keyword.toLowerCase();
  const system = KEYWORD_TO_FLAG[lower];
  if (system) return lower === '$forwarded' ? [system, '\\Forwarded'] : [system];
  const out = new Set<string>([keyword, lower, keyword.toUpperCase()]);
  if (lower.startsWith('$')) {
    // IMAP convention: "$MDNSent", "$Forwarded", "$Label1", "$NotJunk", …
    const word = lower.slice(1);
    out.add(`$${word.charAt(0).toUpperCase()}${word.slice(1)}`);
    if (word.startsWith('not')) out.add(`$Not${word.charAt(3).toUpperCase()}${word.slice(4)}`);
    if (word === 'mdnsent') out.add('$MDNSent');
  }
  return [...out];
}

/** Case-insensitive membership test (RFC 8621 §4.1.1). */
export function hasKeywordFlag(flags: readonly string[], keyword: string): boolean {
  const want = keywordToFlag(keyword).toLowerCase();
  return flags.some((f) => f.toLowerCase() === want);
}

export function keywordsToFlags(keywords: Record<string, unknown>, existing: readonly string[] = []): string[] {
  const flags = new Map<string, string>(); // lower-case → flag (dedupes {Foo, foo})
  for (const [k, v] of Object.entries(keywords)) {
    if (v !== true) continue;
    const flag = keywordToFlag(k, existing);
    if (!flags.has(flag.toLowerCase())) flags.set(flag.toLowerCase(), flag);
  }
  return [...flags.values()];
}

/** Lower-case keyword keys (PatchObject tokens below "keywords/" included). */
export function normalizeKeywordPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'keywords' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([kw, x]) => [kw.toLowerCase(), x]));
    } else {
      out[k.startsWith('keywords/') ? `keywords/${k.slice('keywords/'.length).toLowerCase()}` : k] = v;
    }
  }
  return out;
}

/**
 * RFC 8621 §4.1.1: keyword = 1–255 characters of %x21-%x7E (printable ASCII,
 * no space) except ( ) { ] % * " \ — the IMAP atom-specials.
 */
export function isValidKeyword(k: string): boolean {
  return /^[\x21-\x7E]{1,255}$/.test(k) && !/[(){\]%*"\\]/.test(k);
}

const ROLE_BY_NAME: Record<string, string> = {
  INBOX: 'inbox',
  Drafts: 'drafts',
  Sent: 'sent',
  Trash: 'trash',
  Junk: 'junk',
  Archive: 'archive',
};

export function roleForFolder(name: string, parentId: string | null): string | null {
  if (parentId) return null;
  return ROLE_BY_NAME[name] ?? null;
}

export const SYSTEM_FOLDER_NAMES = new Set(Object.keys(ROLE_BY_NAME).concat(['Notes', 'Tasks']));
