/**
 * Delivery path of a stored message (10.2 message trace "Zustellweg") — pure
 * parsers for the header block of the raw original: the `Received:` chain
 * (RFC 5321 §4.4, oldest hop first) and an Authentication-Results / ARC
 * summary (RFC 8601, RFC 8617).
 *
 * Hostile input is expected: the header block is cut at HEADER_READ_LIMIT,
 * at most MAX_FIELDS fields and MAX_RECEIVED Received fields are looked at,
 * every value is capped, and every scan is linear (no backtracking regex over
 * attacker text). Nothing here is HTML — the BCP renders the strings as text.
 */
import { parseAuthenticationResults, authResultDomain, traceText } from '@coremail/storage';

/** Bytes of the raw message read for the header block. */
export const HEADER_READ_LIMIT = 64 * 1024;
/** Header fields looked at. */
export const MAX_FIELDS = 400;
/** Received fields parsed (newest first; older ones are dropped). */
export const MAX_RECEIVED = 40;
/** Characters of one header value. */
const MAX_VALUE = 4000;
/** Characters of a raw value shown when it cannot be parsed. */
const MAX_RAW = 500;

export interface HeaderField { name: string; value: string }

/** Pure: the header block of a raw message (up to the first empty line, capped). */
export function headerBlock(raw: Buffer, limit: number = HEADER_READ_LIMIT): string {
  const head = raw.subarray(0, Math.min(raw.length, limit)).toString('latin1');
  const crlf = head.indexOf('\r\n\r\n');
  const lf = head.indexOf('\n\n');
  const ends = [crlf, lf].filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) : head.length;
  // Header text is 7-bit or UTF-8 (RFC 6532); decoded as UTF-8 for display.
  return Buffer.from(head.slice(0, end), 'latin1').toString('utf8');
}

/** Pure: unfolded header fields in order (bounded). Lines without a field name are skipped. */
export function headerFields(block: string): HeaderField[] {
  const out: HeaderField[] = [];
  let cur: HeaderField | null = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (cur && cur.value.length < MAX_VALUE) cur.value = `${cur.value} ${line.trim()}`.slice(0, MAX_VALUE);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0 || colon > 76 || !/^[\x21-\x39\x3b-\x7e]+$/.test(line.slice(0, colon))) { cur = null; continue; }
    if (out.length >= MAX_FIELDS) break;
    cur = { name: line.slice(0, colon), value: line.slice(colon + 1).trim().slice(0, MAX_VALUE) };
    out.push(cur);
  }
  return out;
}

export interface ReceivedHop {
  /** Name the sending host gave (HELO/EHLO) — or its address literal. */
  from?: string;
  /** Reverse DNS name the receiving host recorded for the sender. */
  fromRdns?: string;
  /** Sender IP address as the receiving host saw it. */
  fromIp?: string;
  /** Receiving host. */
  by?: string;
  /** Protocol (`with`): SMTP, ESMTP, ESMTPS, ESMTPSA, LMTP, HTTPS, … */
  with?: string;
  id?: string;
  for?: string;
  /** Encrypted hop (ESMTPS / TLS noted in the field). */
  tls: boolean;
  tlsVersion?: string;
  tlsCipher?: string;
  /** ISO time stamp of the hop; absent when missing or not a date. */
  time?: string;
  /** Milliseconds since the previous (older) hop; negative = clock skew. */
  delayMs?: number;
  /** The unfolded field when it could not be parsed (shown as text). */
  raw?: string;
}

type Tok = { kind: 'word'; text: string } | { kind: 'comment'; text: string };

/** Linear tokenizer: words, (nested comments), <angle> and [bracket] tokens; quoted strings kept. */
function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length && toks.length < 200) {
    const c = s[i]!;
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '(') {
      let depth = 1; let j = i + 1; let text = '';
      while (j < s.length && depth > 0) {
        const d = s[j]!;
        if (d === '\\' && j + 1 < s.length) { text += s[j + 1]; j += 2; continue; }
        if (d === '(') depth++;
        else if (d === ')') { depth--; if (depth === 0) break; }
        text += d; j++;
      }
      toks.push({ kind: 'comment', text: text.trim() });
      i = j + 1;
      continue;
    }
    const close = c === '<' ? '>' : c === '[' ? ']' : c === '"' ? '"' : null;
    if (close) {
      const j = s.indexOf(close, i + 1);
      const end = j < 0 ? s.length : j + 1;
      toks.push({ kind: 'word', text: s.slice(i, end) });
      i = end;
      continue;
    }
    let j = i;
    while (j < s.length && !' \t(<['.includes(s[j]!)) j++;
    toks.push({ kind: 'word', text: s.slice(i, j) });
    i = j;
  }
  return toks;
}

const KEYWORDS = new Set(['from', 'by', 'via', 'with', 'id', 'for']);
const TLS_PROTOCOLS = /^(?:E?SMTPS|ESMTPSA|UTF8SMTPSA?|UTF8SMTPS|LMTPS|HTTPS)$/i;
const IP_LITERAL = /^\[(?:IPv6:)?([0-9a-f:.]{2,45})\]$/i;
const TLS_VERSION_RE = /\b(TLS\s?v?1(?:[._]\d)?|TLS1_\d|SSLv3)\b/i;
const CIPHER_RE = /\bcipher[= ]\s*([A-Z0-9_-]{4,80})/i;
const word = (t: Tok | undefined): string | undefined => (t && t.kind === 'word' ? t.text : undefined);
const clean = (v: string, max = 255): string => traceText(v.replace(/^<|>$/g, ''), max);

/** Last `;` outside comments (the date separator), or -1. */
function lastSemicolon(s: string): number {
  let depth = 0; let last = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) last = i;
  }
  return last;
}

function parseDate(s: string): string | undefined {
  const bare = s.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!bare || bare.length > 80) return undefined;
  const d = new Date(bare);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Pure: one Received field value → a hop (or `raw` when nothing recognisable is in it). */
export function parseReceived(value: string): ReceivedHop {
  const v = value.slice(0, MAX_VALUE).replace(/\r?\n[ \t]*/g, ' ');
  const semi = lastSemicolon(v);
  const clauses = semi >= 0 ? v.slice(0, semi) : v;
  const time = semi >= 0 ? parseDate(v.slice(semi + 1)) : undefined;
  const toks = tokenize(clauses);
  const hop: ReceivedHop = { tls: false };
  const comments: string[] = [];
  let section = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === 'comment') {
      comments.push(t.text);
      if (section === 'from') {
        // "(rdns [ip])", "([ip])", "(helo=name)", "(rdns. [IPv6:…])", bare IPv6 "(2603:10a6::34)"
        // Exim: "from rdns ([ip] helo=name)" / "from [ip] (helo=name)" — `from` was the
        // looked-up name or the literal, the HELO name is in the comment.
        const helo = /\bhelo=([^\s)]+)/i.exec(t.text)?.[1];
        if (helo) {
          if (hop.from && !hop.from.startsWith('[')) hop.fromRdns ??= hop.from.replace(/\.$/, '').toLowerCase();
          hop.from = clean(helo);
        }
        const lit = /\[(?:IPv6:)?([0-9a-f:.]{2,45})\]/i.exec(t.text)?.[1];
        if (lit) hop.fromIp ??= lit;
        else if (/^[0-9a-f:.]{3,45}$/i.test(t.text) && /[.:]/.test(t.text)) hop.fromIp ??= t.text;
        const rdns = /^([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9.])\s+\[/.exec(t.text)?.[1];
        if (rdns) hop.fromRdns ??= rdns.replace(/\.$/, '').toLowerCase();
      }
      continue;
    }
    const kw = t.text.toLowerCase();
    if (KEYWORDS.has(kw) && word(toks[i + 1]) !== undefined) {
      const next = word(toks[i + 1])!;
      section = kw;
      i++;
      if (kw === 'from') {
        const lit = IP_LITERAL.exec(next)?.[1];
        if (lit) hop.fromIp ??= lit;
        hop.from ??= clean(next);
      } else if (kw === 'by') hop.by ??= clean(next);
      else if (kw === 'with') hop.with ??= clean(next, 40);
      else if (kw === 'id') hop.id ??= clean(next, 120);
      else if (kw === 'for') hop.for ??= clean(next);
      continue;
    }
    // Exim: "… with esmtps (TLS1.3) tls TLS_AES_256_GCM_SHA384"
    const cipherWord = kw === 'tls' ? word(toks[i + 1]) : undefined;
    if (cipherWord && /^TLS_[A-Z0-9_]{1,80}$/i.test(cipherWord)) {
      hop.tlsCipher ??= cipherWord;
      hop.tls = true;
      i++;
    }
  }
  const notes = comments.join(' ');
  const version = TLS_VERSION_RE.exec(notes)?.[1];
  const cipher = CIPHER_RE.exec(notes)?.[1];
  if (version) hop.tlsVersion = version.replace(/\s+/g, '');
  if (cipher) hop.tlsCipher ??= cipher;
  if ((hop.with && TLS_PROTOCOLS.test(hop.with)) || version || cipher || /Transport Security|\busing TLS/i.test(notes)) hop.tls = true;
  if (time) hop.time = time;
  if (!hop.from && !hop.by) return { tls: false, raw: traceText(value, MAX_RAW) };
  return hop;
}

/**
 * Pure: the Received chain of a header block, oldest hop first, with the delay
 * to the previous hop where both time stamps are known.
 */
export function parseReceivedChain(fields: readonly HeaderField[]): ReceivedHop[] {
  const received = fields.filter((f) => f.name.toLowerCase() === 'received').slice(0, MAX_RECEIVED);
  const hops = received.map((f) => parseReceived(f.value)).reverse();
  let prev: number | undefined;
  for (const h of hops) {
    const t = h.time ? Date.parse(h.time) : undefined;
    if (t !== undefined && prev !== undefined) h.delayMs = t - prev;
    if (t !== undefined) prev = t;
  }
  return hops;
}

export interface AuthSummaryEntry {
  /** `Authentication-Results` or `ARC-Authentication-Results` (with its instance). */
  source: string;
  authservId: string;
  results: Array<{ method: string; result: string; domain?: string }>;
}

export interface ArcSealEntry { instance: number; cv: string; domain?: string }

export interface HeaderAuthSummary {
  authResults: AuthSummaryEntry[];
  arcSeals: ArcSealEntry[];
}

const MAX_AUTH_FIELDS = 10;

/** Pure: Authentication-Results, ARC-Authentication-Results and ARC-Seal fields (newest first, bounded). */
export function authSummary(fields: readonly HeaderField[]): HeaderAuthSummary {
  const authResults: AuthSummaryEntry[] = [];
  const arcSeals: ArcSealEntry[] = [];
  for (const f of fields) {
    const name = f.name.toLowerCase();
    if ((name === 'authentication-results' || name === 'arc-authentication-results') && authResults.length < MAX_AUTH_FIELDS) {
      const parsed = parseAuthenticationResults(f.value);
      const instance = name === 'arc-authentication-results' ? /^\s*i\s*=\s*(\d{1,3})/i.exec(f.value)?.[1] : undefined;
      authResults.push({
        source: instance ? `ARC-Authentication-Results i=${instance}` : f.name,
        authservId: parsed.authservId,
        results: parsed.results.map((r) => {
          const domain = authResultDomain(r);
          return { method: r.method, result: r.result, ...(domain ? { domain } : {}) };
        }),
      });
    } else if (name === 'arc-seal' && arcSeals.length < MAX_AUTH_FIELDS) {
      const tags = Object.fromEntries(f.value.slice(0, 2000).split(';').map((p) => {
        const eq = p.indexOf('=');
        return eq < 0 ? ['', ''] : [p.slice(0, eq).trim().toLowerCase(), p.slice(eq + 1).trim()];
      }));
      const instance = Number.parseInt(tags['i'] ?? '', 10);
      if (Number.isFinite(instance)) {
        arcSeals.push({
          instance, cv: traceText(tags['cv'] ?? 'none', 20).toLowerCase(),
          ...(tags['d'] ? { domain: traceText(tags['d'], 255).toLowerCase() } : {}),
        });
      }
    }
  }
  return { authResults, arcSeals };
}
