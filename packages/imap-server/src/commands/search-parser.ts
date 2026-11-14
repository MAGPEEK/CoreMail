/**
 * IMAP SEARCH (RFC 9051 §6.4.4, RFC 4731 ESEARCH, RFC 7162 §3.1.5 MODSEQ).
 *
 * Pure module: parses the search program into an AST and evaluates it
 * against message rows. No database access.
 */
import { ImapParseError, tokenString, type Token } from '../server/tokenizer.js';

export type DateField = 'internal' | 'sent';
export type DateCmp = 'before' | 'on' | 'since';
export type TextField = 'from' | 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'text';

export type SearchKey =
  | { op: 'all' }
  | { op: 'and'; keys: SearchKey[] }
  | { op: 'or'; left: SearchKey; right: SearchKey }
  | { op: 'not'; key: SearchKey }
  | { op: 'flag'; flag: string; set: boolean }
  | { op: 'text'; field: TextField; value: string }
  | { op: 'header'; name: string; value: string }
  | { op: 'date'; field: DateField; cmp: DateCmp; day: number }
  | { op: 'size'; cmp: 'larger' | 'smaller'; octets: number }
  | { op: 'uid'; set: string }
  | { op: 'seq'; set: string }
  | { op: 'modseq'; value: bigint };

export type ReturnOption = 'MIN' | 'MAX' | 'COUNT' | 'ALL';

export interface SearchProgram {
  /** null = classic SEARCH response; otherwise ESEARCH with these options. */
  returnOptions: ReturnOption[] | null;
  charset: string | null;
  key: SearchKey;
}

export class SearchSyntaxError extends ImapParseError {}

const SEQUENCE_SET = /^(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?(?:,(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?)*$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const FLAG_KEYS: Record<string, [string, boolean]> = {
  ANSWERED: ['\\Answered', true], UNANSWERED: ['\\Answered', false],
  DELETED: ['\\Deleted', true], UNDELETED: ['\\Deleted', false],
  DRAFT: ['\\Draft', true], UNDRAFT: ['\\Draft', false],
  FLAGGED: ['\\Flagged', true], UNFLAGGED: ['\\Flagged', false],
  SEEN: ['\\Seen', true], UNSEEN: ['\\Seen', false],
  // \Recent is not tracked (removed in IMAP4rev2). For compatibility with
  // older clients RECENT/NEW behave like UNSEEN and OLD like SEEN.
  RECENT: ['\\Seen', false], NEW: ['\\Seen', false], OLD: ['\\Seen', true],
};

const TEXT_KEYS: Record<string, TextField> = {
  FROM: 'from', TO: 'to', CC: 'cc', BCC: 'bcc', SUBJECT: 'subject', BODY: 'body', TEXT: 'text',
};

const DATE_KEYS: Record<string, [DateField, DateCmp]> = {
  BEFORE: ['internal', 'before'], ON: ['internal', 'on'], SINCE: ['internal', 'since'],
  SENTBEFORE: ['sent', 'before'], SENTON: ['sent', 'on'], SENTSINCE: ['sent', 'since'],
};

export function isSequenceSet(value: string): boolean {
  return SEQUENCE_SET.test(value);
}

/** Parses an IMAP date ("1-Feb-2026" / "01-Feb-2026") into a UTC day number. */
export function parseSearchDate(value: string): number | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (!m) return null;
  const month = MONTHS.indexOf((m[2] as string).toUpperCase());
  const day = Number(m[1]);
  if (month < 0 || day < 1 || day > 31) return null;
  return Date.UTC(Number(m[3]), month, day) / 86_400_000;
}

/** UTC day number of a timestamp (time and timezone are disregarded, RFC 9051 §6.4.4). */
export function dayOf(date: Date): number {
  return Math.floor(date.getTime() / 86_400_000);
}

class Cursor {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}
  get done(): boolean { return this.i >= this.tokens.length; }
  peek(): Token | undefined { return this.tokens[this.i]; }
  next(): Token | undefined { return this.tokens[this.i++]; }
  string(what: string): string {
    const value = tokenString(this.next());
    if (value === null) throw new SearchSyntaxError(`${what} expects a string argument`);
    return value;
  }
  atom(what: string): string {
    const t = this.next();
    if (!t || t.type !== 'atom') throw new SearchSyntaxError(`${what} expects an atom argument`);
    return t.value;
  }
}

function parseKey(c: Cursor): SearchKey {
  const token = c.next();
  if (!token) throw new SearchSyntaxError('Missing search key');
  if (token.type === 'list') {
    if (token.items.length === 0) throw new SearchSyntaxError('Empty search key list');
    return andOf(parseKeys(new Cursor(token.items)));
  }
  if (token.type !== 'atom') throw new SearchSyntaxError('Unexpected string in search program');

  const name = token.value.toUpperCase();
  if (name === 'ALL') return { op: 'all' };
  const flag = FLAG_KEYS[name];
  if (flag) return { op: 'flag', flag: flag[0], set: flag[1] };
  const textField = TEXT_KEYS[name];
  if (textField) return { op: 'text', field: textField, value: c.string(name) };
  const dateKey = DATE_KEYS[name];
  if (dateKey) {
    const day = parseSearchDate(c.string(name));
    if (day === null) throw new SearchSyntaxError(`${name} expects a date (d-Mon-yyyy)`);
    return { op: 'date', field: dateKey[0], cmp: dateKey[1], day };
  }
  switch (name) {
    case 'NOT': return { op: 'not', key: parseKey(c) };
    case 'OR': { const left = parseKey(c); const right = parseKey(c); return { op: 'or', left, right }; }
    case 'KEYWORD':
    case 'UNKEYWORD':
      return { op: 'flag', flag: c.atom(name), set: name === 'KEYWORD' };
    case 'HEADER': {
      const field = c.string(name);
      return { op: 'header', name: field.toLowerCase(), value: c.string(name) };
    }
    case 'LARGER':
    case 'SMALLER': {
      const n = c.atom(name);
      if (!/^\d+$/.test(n)) throw new SearchSyntaxError(`${name} expects a number`);
      return { op: 'size', cmp: name === 'LARGER' ? 'larger' : 'smaller', octets: Number(n) };
    }
    case 'UID': {
      const set = c.atom(name);
      if (!isSequenceSet(set)) throw new SearchSyntaxError('UID expects a sequence set');
      return { op: 'uid', set };
    }
    case 'MODSEQ': {
      // MODSEQ [<entry-name> <entry-type-req>] <mod-sequence-valzer>
      let value = c.string(name);
      if (!/^\d+$/.test(value)) {
        // value was the entry-name; skip entry-type-req (priv/shared/all)
        c.atom(name);
        value = c.atom(name);
      }
      if (!/^\d+$/.test(value)) throw new SearchSyntaxError('MODSEQ expects a number');
      return { op: 'modseq', value: BigInt(value) };
    }
  }
  if (isSequenceSet(token.value)) return { op: 'seq', set: token.value };
  throw new SearchSyntaxError(`Unknown search key ${token.value}`);
}

function parseKeys(c: Cursor): SearchKey[] {
  const keys: SearchKey[] = [];
  while (!c.done) keys.push(parseKey(c));
  return keys;
}

function andOf(keys: SearchKey[]): SearchKey {
  return keys.length === 1 ? (keys[0] as SearchKey) : { op: 'and', keys };
}

/**
 * Parses the arguments of SEARCH / UID SEARCH:
 *   [RETURN (<options>)] [CHARSET <charset>] <search-key>+
 */
export function parseSearch(tokens: Token[]): SearchProgram {
  const c = new Cursor(tokens);
  let returnOptions: ReturnOption[] | null = null;
  let charset: string | null = null;

  const first = c.peek();
  if (first?.type === 'atom' && first.value.toUpperCase() === 'RETURN') {
    c.next();
    const list = c.next();
    if (!list || list.type !== 'list') throw new SearchSyntaxError('RETURN expects a list');
    returnOptions = [];
    for (const item of list.items) {
      const opt = item.type === 'atom' ? item.value.toUpperCase() : '';
      if (opt !== 'MIN' && opt !== 'MAX' && opt !== 'COUNT' && opt !== 'ALL') {
        throw new SearchSyntaxError(`Unsupported RETURN option ${opt || '?'}`);
      }
      if (!returnOptions.includes(opt)) returnOptions.push(opt);
    }
    // RFC 4731 §3.1: "RETURN ()" is equivalent to "RETURN (ALL)".
    if (returnOptions.length === 0) returnOptions.push('ALL');
  }

  const maybeCharset = c.peek();
  if (maybeCharset?.type === 'atom' && maybeCharset.value.toUpperCase() === 'CHARSET') {
    c.next();
    charset = c.string('CHARSET').toUpperCase();
  }

  const keys = parseKeys(c);
  if (keys.length === 0) throw new SearchSyntaxError('Missing search key');
  return { returnOptions, charset, key: andOf(keys) };
}

/** True when evaluating the key needs bodyText/bodyHtml. */
export function needsBody(key: SearchKey): boolean {
  switch (key.op) {
    case 'text': return key.field === 'body' || key.field === 'text';
    case 'and': return key.keys.some(needsBody);
    case 'or': return needsBody(key.left) || needsBody(key.right);
    case 'not': return needsBody(key.key);
    default: return false;
  }
}

export interface SearchableMessage {
  uid: number;
  modSeq: bigint;
  flags: string[];
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: string[];
  ccAddrs: string[];
  bccAddrs: string[];
  replyTo?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  date: Date;
  createdAt?: Date | null;
  rawSize: number;
  bodyText?: string;
  bodyHtml?: string;
}

export interface SearchContext {
  /** 1-based message sequence number of the message being evaluated. */
  seq: number;
  /** Number of messages in the mailbox (value of "*" for sequence sets). */
  maxSeq: number;
  /** Highest UID in the mailbox (value of "*" for UID sets). */
  maxUid: number;
}

/** Membership test for a sequence set; "*" stands for `max`. */
export function inSequenceSet(set: string, n: number, max: number): boolean {
  for (const part of set.split(',')) {
    const [a, b] = part.split(':') as [string, string | undefined];
    const start = a === '*' ? max : Number(a);
    const end = b === undefined ? start : b === '*' ? max : Number(b);
    if (n >= Math.min(start, end) && n <= Math.max(start, end)) return true;
  }
  return false;
}

const contains = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

function addressText(name: string, addr: string): string {
  return name ? `${name} <${addr}>` : addr;
}

function headerValue(msg: SearchableMessage, name: string): string | null {
  switch (name) {
    case 'subject': return msg.subject;
    case 'from': return addressText(msg.fromName, msg.fromAddr);
    case 'to': return msg.toAddrs.length ? msg.toAddrs.join(', ') : null;
    case 'cc': return msg.ccAddrs.length ? msg.ccAddrs.join(', ') : null;
    case 'bcc': return msg.bccAddrs.length ? msg.bccAddrs.join(', ') : null;
    case 'reply-to': return msg.replyTo ?? null;
    case 'message-id': return msg.messageId ?? null;
    case 'in-reply-to': return msg.inReplyTo ?? null;
    case 'date': return msg.date.toUTCString();
    // Other header fields are not stored separately and never match.
    default: return null;
  }
}

function textValue(msg: SearchableMessage, field: TextField): string {
  switch (field) {
    case 'from': return addressText(msg.fromName, msg.fromAddr);
    case 'to': return msg.toAddrs.join(', ');
    case 'cc': return msg.ccAddrs.join(', ');
    case 'bcc': return msg.bccAddrs.join(', ');
    case 'subject': return msg.subject;
    case 'body': return `${msg.bodyText ?? ''}\n${msg.bodyHtml ?? ''}`;
    case 'text':
      return [
        `Subject: ${msg.subject}`,
        `From: ${addressText(msg.fromName, msg.fromAddr)}`,
        `To: ${msg.toAddrs.join(', ')}`,
        `Cc: ${msg.ccAddrs.join(', ')}`,
        msg.bodyText ?? '',
        msg.bodyHtml ?? '',
      ].join('\n');
  }
}

export function evaluateSearch(key: SearchKey, msg: SearchableMessage, ctx: SearchContext): boolean {
  switch (key.op) {
    case 'all': return true;
    case 'and': return key.keys.every((k) => evaluateSearch(k, msg, ctx));
    case 'or': return evaluateSearch(key.left, msg, ctx) || evaluateSearch(key.right, msg, ctx);
    case 'not': return !evaluateSearch(key.key, msg, ctx);
    case 'flag': {
      const has = msg.flags.some((f) => f.toLowerCase() === key.flag.toLowerCase());
      return has === key.set;
    }
    case 'text': return contains(textValue(msg, key.field), key.value);
    case 'header': {
      const value = headerValue(msg, key.name);
      return value !== null && contains(value, key.value);
    }
    case 'date': {
      const source = key.field === 'internal' ? (msg.createdAt ?? msg.date) : msg.date;
      const day = dayOf(source);
      if (key.cmp === 'before') return day < key.day;
      if (key.cmp === 'on') return day === key.day;
      return day >= key.day;
    }
    case 'size': return key.cmp === 'larger' ? msg.rawSize > key.octets : msg.rawSize < key.octets;
    case 'uid': return inSequenceSet(key.set, msg.uid, ctx.maxUid);
    case 'seq': return inSequenceSet(key.set, ctx.seq, ctx.maxSeq);
    case 'modseq': return msg.modSeq >= key.value;
  }
}

/** Compresses ascending numbers into an IMAP sequence set ("1:3,7,9:10"). */
export function toSequenceSet(numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i] as number;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) { end += 1; i++; }
    parts.push(start === end ? `${start}` : `${start}:${end}`);
    i++;
  }
  return parts.join(',');
}

/** Builds the ESEARCH response data (RFC 4731 §3.1) without the leading "ESEARCH". */
export function formatEsearch(tag: string, byUid: boolean, results: number[], options: ReturnOption[]): string {
  const parts = [`(TAG "${tag.replace(/[\\"]/g, '\\$&')}")`];
  if (byUid) parts.push('UID');
  const sorted = [...results].sort((a, b) => a - b);
  for (const opt of options) {
    if (opt === 'COUNT') parts.push(`COUNT ${sorted.length}`);
    else if (sorted.length === 0) continue;
    else if (opt === 'MIN') parts.push(`MIN ${sorted[0]}`);
    else if (opt === 'MAX') parts.push(`MAX ${sorted[sorted.length - 1]}`);
    else if (opt === 'ALL') parts.push(`ALL ${toSequenceSet(sorted)}`);
  }
  return parts.join(' ');
}
