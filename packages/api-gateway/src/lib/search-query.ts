/**
 * Mail search query language (GET /api/v1/mail/search?q=…).
 *
 * Gmail/OWA-style operators on top of the existing free-text search:
 *   from:  to:  cc:  subject:            substring (from/subject) or full address (to/cc)
 *   has:attachment  hasattachment:yes|no
 *   is:unread  is:read  is:flagged  is:unflagged  (is:starred = is:flagged)
 *   before:YYYY-MM-DD  after:YYYY-MM-DD  received:YYYY-MM-DD   (UTC days)
 *   older_than:7d  newer_than:2w        units d / w / m (30 d) / y (365 d)
 *   in:<folder>                          system aliases (inbox, sent, drafts, trash,
 *                                        junk/spam, archive) or a folder name
 *   "quoted phrase"   -word   -"phrase"   -from:x (any operator can be negated)
 *
 * Free text: the positive, unquoted words are joined again and matched as ONE
 * substring against subject / from / body — a query without any operator, quote
 * or negation is matched exactly like before (the whole trimmed query).
 *
 * Only Prisma where-objects are produced (never SQL strings); dates are validated
 * (calendar round trip, year 1970–9999) and relative ages are capped, so a query
 * cannot produce raw SQL or an invalid Date.
 */

export const MAX_QUERY_LENGTH = 500;
const MAX_CLAUSES = 30;
const MAX_AGE_DAYS = 365 * 100;
const DAY_MS = 86_400_000;

export type SearchOperator =
  | 'from' | 'to' | 'cc' | 'subject' | 'has' | 'is'
  | 'before' | 'after' | 'received' | 'older_than' | 'newer_than' | 'in';

export type SearchClause =
  | { kind: 'text'; value: string; phrase: boolean; negate: boolean; raw: string }
  | { kind: 'from' | 'to' | 'cc' | 'subject'; value: string; negate: boolean; raw: string }
  | { kind: 'attachment'; value: boolean; negate: boolean; raw: string }
  | { kind: 'flag'; value: 'unread' | 'read' | 'flagged' | 'unflagged'; negate: boolean; raw: string }
  | { kind: 'date'; op: 'lt' | 'gte'; date: Date; negate: boolean; raw: string }
  | { kind: 'day'; date: Date; negate: boolean; raw: string }
  | { kind: 'in'; value: string; negate: boolean; raw: string };

export interface ParsedSearch {
  /** Positive unquoted free text (matched as one substring, as before). */
  freeText: string;
  /** Operator / phrase / negation clauses (freeText excluded). */
  clauses: SearchClause[];
  /** Tokens that looked like operators but had an invalid value (ignored). */
  invalid: string[];
}

/** A chip the client shows for a recognised (or rejected) operator. */
export interface SearchChip { key: string; value: string; negate: boolean; valid: boolean; raw: string }

const OPERATOR_ALIASES: Record<string, SearchOperator> = {
  from: 'from', to: 'to', cc: 'cc', subject: 'subject',
  has: 'has', hasattachment: 'has', hasattachments: 'has',
  is: 'is', before: 'before', after: 'after', received: 'received',
  older_than: 'older_than', newer_than: 'newer_than', in: 'in', folder: 'in',
};

interface Token { raw: string; negate: boolean; key: string | null; value: string; quoted: boolean }

/** Splits a query into tokens; honours "quotes" (also after `key:` and `-`). */
export function tokenize(input: string): Token[] {
  const q = input.slice(0, MAX_QUERY_LENGTH);
  const out: Token[] = [];
  let i = 0;
  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i]!)) i++;
    if (i >= q.length) break;
    const start = i;
    let negate = false;
    if (q[i] === '-' && i + 1 < q.length && !/\s/.test(q[i + 1]!)) { negate = true; i++; }
    let key: string | null = null;
    // key: prefix (letters/underscore only — "http://x" or "12:30" stay free text)
    const m = /^([A-Za-z_]+):/.exec(q.slice(i));
    if (m && OPERATOR_ALIASES[m[1]!.toLowerCase()] !== undefined) {
      key = m[1]!.toLowerCase();
      i += m[0].length;
    }
    let value = '';
    let quoted = false;
    if (q[i] === '"') {
      quoted = true;
      const end = q.indexOf('"', i + 1);
      if (end === -1) { value = q.slice(i + 1); i = q.length; }
      else { value = q.slice(i + 1, end); i = end + 1; }
    } else {
      const s = i;
      while (i < q.length && !/\s/.test(q[i]!)) i++;
      value = q.slice(s, i);
    }
    out.push({ raw: q.slice(start, i), negate, key, value, quoted });
  }
  return out;
}

/** Strict YYYY-MM-DD (or YYYY/MM/DD) → UTC midnight, or null. */
export function parseDay(value: string): Date | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Calendar round trip rejects 2024-02-31 etc.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** "7d" / "2w" / "3m" / "1y" → days, or null (capped at 100 years). */
export function parseAge(value: string): number | null {
  const m = /^(\d{1,6})([dwmy])$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const days = unit === 'd' ? n : unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : n * 365;
  if (days <= 0 || days > MAX_AGE_DAYS) return null;
  return days;
}

export function parseSearchQuery(input: string, now: Date = new Date()): ParsedSearch {
  const trimmed = input.trim().slice(0, MAX_QUERY_LENGTH);
  const tokens = tokenize(trimmed);
  const hasSyntax = tokens.some((t) => t.key !== null || t.negate || t.quoted);
  if (!hasSyntax) return { freeText: trimmed, clauses: [], invalid: [] };

  const words: string[] = [];
  const clauses: SearchClause[] = [];
  const invalid: string[] = [];
  const push = (c: SearchClause) => { if (clauses.length < MAX_CLAUSES) clauses.push(c); };

  for (const t of tokens) {
    const { raw, negate } = t;
    if (t.key === null) {
      if (!t.value) continue;
      if (!negate && !t.quoted) words.push(t.value);
      else push({ kind: 'text', value: t.value, phrase: t.quoted, negate, raw });
      continue;
    }
    const op = OPERATOR_ALIASES[t.key]!;
    const value = t.value.trim();
    const lower = value.toLowerCase();
    if (!value) { invalid.push(raw); continue; }
    switch (op) {
      case 'from': case 'to': case 'cc': case 'subject':
        push({ kind: op, value, negate, raw });
        break;
      case 'has': {
        // has:attachment(s) | hasattachment:yes|no|true|false
        if (t.key === 'has') {
          if (lower === 'attachment' || lower === 'attachments') push({ kind: 'attachment', value: true, negate, raw });
          else invalid.push(raw);
        } else if (['yes', 'true', '1'].includes(lower)) push({ kind: 'attachment', value: true, negate, raw });
        else if (['no', 'false', '0'].includes(lower)) push({ kind: 'attachment', value: false, negate, raw });
        else invalid.push(raw);
        break;
      }
      case 'is': {
        const map: Record<string, 'unread' | 'read' | 'flagged' | 'unflagged'> = {
          unread: 'unread', read: 'read', flagged: 'flagged', starred: 'flagged', unflagged: 'unflagged',
        };
        const v = map[lower];
        if (v) push({ kind: 'flag', value: v, negate, raw });
        else invalid.push(raw);
        break;
      }
      case 'before': case 'after': case 'received': {
        const day = parseDay(value);
        if (!day) { invalid.push(raw); break; }
        if (op === 'received') push({ kind: 'day', date: day, negate, raw });
        else push({ kind: 'date', op: op === 'before' ? 'lt' : 'gte', date: day, negate, raw });
        break;
      }
      case 'older_than': case 'newer_than': {
        const days = parseAge(value);
        if (days === null) { invalid.push(raw); break; }
        const date = new Date(now.getTime() - days * DAY_MS);
        push({ kind: 'date', op: op === 'older_than' ? 'lt' : 'gte', date, negate, raw });
        break;
      }
      case 'in':
        push({ kind: 'in', value, negate, raw });
        break;
    }
  }
  return { freeText: words.join(' '), clauses, invalid };
}

/** True when the query restricts anything (an empty result is returned otherwise). */
export function hasCriteria(p: ParsedSearch): boolean {
  return p.freeText.length >= 2 || p.clauses.length > 0;
}

const ci = (value: string) => ({ contains: value, mode: 'insensitive' as const });

function textMatch(value: string): Record<string, unknown> {
  return {
    OR: [
      { subject: ci(value) },
      { fromAddr: ci(value) },
      { fromName: ci(value) },
      { bodyText: ci(value) },
    ],
  };
}

function addressVariants(value: string): string[] {
  return [...new Set([value, value.toLowerCase()])];
}

/** Prisma where-fragment for one clause (without negation), or null for `in:`. */
function clauseWhere(c: SearchClause): Record<string, unknown> | null {
  switch (c.kind) {
    case 'text': return textMatch(c.value);
    case 'from': return { OR: [{ fromAddr: ci(c.value) }, { fromName: ci(c.value) }] };
    // Address arrays support no substring match in Prisma: full address, either case.
    case 'to': return { toAddrs: { hasSome: addressVariants(c.value) } };
    case 'cc': return { ccAddrs: { hasSome: addressVariants(c.value) } };
    case 'subject': return { subject: ci(c.value) };
    case 'attachment': return c.value ? { attachments: { some: {} } } : { attachments: { none: {} } };
    case 'flag':
      switch (c.value) {
        case 'read': return { flags: { has: '\\Seen' } };
        case 'unread': return { NOT: { flags: { has: '\\Seen' } } };
        case 'flagged': return { flags: { has: '\\Flagged' } };
        case 'unflagged': return { NOT: { flags: { has: '\\Flagged' } } };
      }
      return null;
    case 'date': return { date: { [c.op]: c.date } };
    case 'day': return { date: { gte: c.date, lt: new Date(c.date.getTime() + DAY_MS) } };
    case 'in': return null;
  }
}

/** The AND-list of Prisma where-fragments for the parsed query (folder scope excluded). */
export function buildSearchConditions(p: ParsedSearch): Record<string, unknown>[] {
  const and: Record<string, unknown>[] = [];
  if (p.freeText.length >= 1) and.push(textMatch(p.freeText));
  for (const c of p.clauses) {
    const w = clauseWhere(c);
    if (!w) continue;
    and.push(c.negate ? { NOT: w } : w);
  }
  return and;
}

const FOLDER_ALIASES: Record<string, string> = {
  inbox: 'INBOX', posteingang: 'INBOX',
  sent: 'Sent', 'sent items': 'Sent', gesendet: 'Sent',
  drafts: 'Drafts', draft: 'Drafts', entwürfe: 'Drafts',
  trash: 'Trash', deleted: 'Trash', 'deleted items': 'Trash', papierkorb: 'Trash',
  junk: 'Junk', spam: 'Junk',
  archive: 'Archive', archiv: 'Archive',
  outbox: 'Outbox',
};

export interface FolderRef { id: string; name: string; displayName: string | null }

/** Folder ids matching an `in:` value (system alias, name or display name, case-insensitive). */
export function matchFolders(value: string, folders: FolderRef[]): string[] {
  const v = value.trim().toLowerCase();
  const alias = FOLDER_ALIASES[v];
  return folders
    .filter((f) => (alias && f.name === alias)
      || f.name.toLowerCase() === v
      || (f.displayName ?? '').toLowerCase() === v)
    .map((f) => f.id);
}

/**
 * Applies the `in:` clauses to the folders in scope. Positive `in:` clauses
 * replace the scope (an explicit folder wins over the list's folder scope) and
 * are intersected; negative ones remove folders.
 */
export function resolveFolderScope(p: ParsedSearch, scope: string[], allFolders: FolderRef[]): string[] {
  const ins = p.clauses.filter((c): c is Extract<SearchClause, { kind: 'in' }> => c.kind === 'in');
  let ids = ins.some((c) => !c.negate) ? allFolders.map((f) => f.id) : [...scope];
  for (const c of ins) {
    const hit = new Set(matchFolders(c.value, allFolders));
    ids = ids.filter((id) => (c.negate ? !hit.has(id) : hit.has(id)));
  }
  return ids;
}

const CHIP_KEY: Record<SearchClause['kind'], string> = {
  text: 'text', from: 'from', to: 'to', cc: 'cc', subject: 'subject',
  attachment: 'has', flag: 'is', date: 'date', day: 'received', in: 'in',
};

/** Chips for the client (recognised operators + rejected operator tokens). */
export function searchChips(p: ParsedSearch): SearchChip[] {
  const chips: SearchChip[] = p.clauses.map((c) => {
    const [k, ...rest] = c.raw.replace(/^-/, '').split(':');
    const value = c.kind === 'text' ? c.value : rest.join(':').replace(/^"|"$/g, '');
    return { key: c.kind === 'text' ? 'text' : (k ?? CHIP_KEY[c.kind]).toLowerCase(), value, negate: c.negate, valid: true, raw: c.raw };
  });
  for (const raw of p.invalid) {
    const [k, ...rest] = raw.replace(/^-/, '').split(':');
    chips.push({ key: (k ?? '').toLowerCase(), value: rest.join(':').replace(/^"|"$/g, ''), negate: raw.startsWith('-'), valid: false, raw });
  }
  return chips;
}
