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

export function keywordToFlag(keyword: string): string {
  return KEYWORD_TO_FLAG[keyword.toLowerCase()] ?? keyword;
}

export function keywordsToFlags(keywords: Record<string, unknown>): string[] {
  const flags = new Set<string>();
  for (const [k, v] of Object.entries(keywords)) {
    if (v === true) flags.add(keywordToFlag(k));
  }
  return [...flags];
}

/** RFC 8621 §4.1.1: keyword syntax (IMAP atom without certain characters, 1–255). */
export function isValidKeyword(k: string): boolean {
  return /^[^\s()\]{%*"\\]{1,255}$/.test(k);
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
