/**
 * Envelope command parsing (RFC 5321 §4.1.1.2–3, §4.1.2, §4.1.1.11).
 *
 * Pure functions — the session maps the results onto reply codes.
 */
import { BARE_POSTMASTER } from './types.js';

export type EnvelopeParse =
  | { ok: true; address: string; params: Map<string, string> }
  | { ok: false; reply: string };

/** RFC 5321 §4.1.2 Domain (ASCII sub-domains) or an address literal. */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const ADDRESS_LITERAL_RE = /^\[[^[\]\\\s]+\]$/;
/** esmtp-param = esmtp-keyword ["=" esmtp-value] (§4.1.2). */
const PARAM_RE = /^([A-Za-z0-9][A-Za-z0-9-]*)(?:=([\x21-\x3c\x3e-\x7e]+))?$/;

/** MAIL parameters this server implements (advertised extensions only). */
const MAIL_PARAMS = new Set(['SIZE', 'BODY', 'AUTH']);

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain) || ADDRESS_LITERAL_RE.test(domain);
}

/**
 * Validates a mailbox (local-part "@" domain). The local-part keeps its case
 * (RFC 5321 §2.4: it MUST be preserved when relaying); the domain is lower-cased.
 * Returns null when the syntax is invalid.
 */
export function normalizeMailbox(mailbox: string): string | null {
  const at = mailbox.lastIndexOf('@');
  if (at <= 0 || at === mailbox.length - 1) return null;
  const local = mailbox.slice(0, at);
  const domain = mailbox.slice(at + 1);
  // Local-part: dot-string or quoted-string; reject whitespace, control
  // characters and angle brackets (a quoted local-part may contain spaces).
  const quoted = /^"(?:[^"\\\r\n]|\\.)*"$/.test(local);
  if (!quoted && /[\s<>()[\]\\,;:"\x00-\x1f\x7f]/.test(local)) return null;
  if (!isValidDomain(domain)) return null;
  return `${local}@${domain.toLowerCase()}`;
}

function parseParams(rest: string): Map<string, string> | null {
  const params = new Map<string, string>();
  const trimmed = rest.trim();
  if (trimmed === '') return params;
  // Parameters must be separated from the path by a space.
  if (!/^\s/.test(rest)) return null;
  for (const token of trimmed.split(/\s+/)) {
    const m = PARAM_RE.exec(token);
    if (!m) return null;
    params.set(m[1]!.toUpperCase(), m[2] ?? '');
  }
  return params;
}

function splitPath(arg: string, keyword: 'FROM' | 'TO'): { path: string; rest: string } | null {
  const m = new RegExp(`^${keyword}:\\s*<([^<>]*)>(.*)$`, 'i').exec(arg.trim());
  if (!m) return null;
  // A source route (<@a,@b:user@d>) MUST be accepted and SHOULD be ignored (§4.1.1.3, Appendix C).
  const path = (m[1] ?? '').trim().replace(/^@[^:]*:/, '');
  return { path, rest: m[2] ?? '' };
}

/** `MAIL FROM:<reverse-path> [SP Mail-parameters]` */
export function parseMailFrom(arg: string): EnvelopeParse {
  const split = splitPath(arg, 'FROM');
  if (!split) return { ok: false, reply: '501 5.5.4 Syntax: MAIL FROM:<address>' };
  const params = parseParams(split.rest);
  if (!params) return { ok: false, reply: '501 5.5.4 Syntax error in MAIL parameters' };
  for (const [key, value] of params) {
    if (!MAIL_PARAMS.has(key)) return { ok: false, reply: `555 5.5.4 MAIL parameter ${key} not recognized or not implemented` };
    if (key === 'SIZE' && !/^\d{1,20}$/.test(value)) return { ok: false, reply: '501 5.5.4 Invalid SIZE parameter' };
    if (key === 'BODY' && !/^(7BIT|8BITMIME)$/i.test(value)) return { ok: false, reply: '555 5.5.4 BODY value not supported' };
  }
  if (split.path === '') return { ok: true, address: '', params };
  const address = normalizeMailbox(split.path);
  if (address === null) return { ok: false, reply: '501 5.1.7 Bad sender address syntax' };
  return { ok: true, address, params };
}

/** `RCPT TO:<forward-path> [SP Rcpt-parameters]` (no RCPT parameters are implemented). */
export function parseRcptTo(arg: string): EnvelopeParse {
  const split = splitPath(arg, 'TO');
  if (!split) return { ok: false, reply: '501 5.5.4 Syntax: RCPT TO:<address>' };
  const params = parseParams(split.rest);
  if (!params) return { ok: false, reply: '501 5.5.4 Syntax error in RCPT parameters' };
  if (params.size > 0) {
    return { ok: false, reply: `555 5.5.4 RCPT parameter ${[...params.keys()][0]} not recognized or not implemented` };
  }
  // RFC 5321 §4.1.1.3: "RCPT TO:<Postmaster>" (no domain) MUST be accepted.
  if (/^postmaster$/i.test(split.path)) return { ok: true, address: BARE_POSTMASTER, params };
  const address = split.path === '' ? null : normalizeMailbox(split.path);
  if (address === null) return { ok: false, reply: '501 5.1.3 Bad recipient address syntax' };
  return { ok: true, address, params };
}

/** Strict base64 (RFC 4648 §4) as required for SASL responses (RFC 4954 §4). */
export function decodeBase64Strict(text: string): Buffer | null {
  const s = text.trim();
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  return Buffer.from(s, 'base64');
}

/** One reply line: strips CR/LF so a handler message can never break the reply framing. */
export function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}
