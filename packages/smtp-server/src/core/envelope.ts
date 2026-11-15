/**
 * Envelope command parsing (RFC 5321 §4.1.1.2–3, §4.1.2, §4.1.1.11) with the
 * parameters of the advertised extensions: SIZE (RFC 1870), BODY (RFC 6152,
 * RFC 3030 BINARYMIME), AUTH (RFC 4954), SMTPUTF8 (RFC 6531), DSN (RFC 3461).
 *
 * Pure functions — the session maps the results onto reply codes.
 */
import { domainToASCII, domainToUnicode } from 'node:url';
import { BARE_POSTMASTER } from './types.js';
import { parseEnvid, parseNotify, parseOrcpt, parseRet, type RcptDsn, type DsnRet } from './dsn-params.js';

export type BodyType = '7BIT' | '8BITMIME' | 'BINARYMIME';

/** MAIL FROM parse result with the interpreted parameters. */
export type MailFromParse =
  | {
      ok: true; address: string; params: Map<string, string>;
      smtputf8: boolean; body: BodyType; ret?: DsnRet; envid?: string;
    }
  | { ok: false; reply: string };

/** RCPT TO parse result with the interpreted DSN parameters. */
export type RcptToParse =
  | { ok: true; address: string; params: Map<string, string>; dsn?: RcptDsn }
  | { ok: false; reply: string };

/** Which optional extensions are advertised (only their parameters are accepted). */
export interface EnvelopeOptions {
  /** SMTPUTF8 advertised (MAIL parameter SMTPUTF8, UTF-8 addresses). */
  smtputf8?: boolean;
  /** DSN advertised (RET, ENVID, NOTIFY, ORCPT). */
  dsn?: boolean;
  /** CHUNKING/BINARYMIME advertised (BODY=BINARYMIME). */
  chunking?: boolean;
  /** RCPT only: the transaction was opened with MAIL … SMTPUTF8. */
  utf8Transaction?: boolean;
}

/** RFC 5321 §4.1.2 Domain (ASCII sub-domains) or an address literal. */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const ADDRESS_LITERAL_RE = /^\[[^[\]\\\s]+\]$/;
/**
 * esmtp-param = esmtp-keyword ["=" esmtp-value] (§4.1.2); RFC 6531 §3.3 adds
 * UTF8-non-ascii to esmtp-value.
 */
const PARAM_RE = /^([A-Za-z0-9][A-Za-z0-9-]*)(?:=([\x21-\x3c\x3e-\x7e\u0080-￿]+))?$/;

const NON_ASCII_RE = /[^\x00-\x7f]/;

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain) || ADDRESS_LITERAL_RE.test(domain);
}

/**
 * RFC 6531 §3.3: a domain may be given in U-labels. Valid when its A-label
 * form (IDNA / UTS #46 processing) is a valid ASCII domain. Returns the
 * normalised U-label form (lower case) or null.
 */
function normalizeIdnDomain(domain: string): string | null {
  const ascii = domainToASCII(domain);
  if (!ascii || !DOMAIN_RE.test(ascii)) return null;
  return domainToUnicode(ascii).toLowerCase() || null;
}

/**
 * Validates a mailbox (local-part "@" domain). The local-part keeps its case
 * (RFC 5321 §2.4: it MUST be preserved when relaying); the domain is lower-cased.
 * UTF-8 local-parts and U-label domains are allowed (RFC 6531 §3.3) — whether
 * the transaction may carry them is checked by the caller (SMTPUTF8).
 * Returns null when the syntax is invalid.
 */
export function normalizeMailbox(mailbox: string): string | null {
  const at = mailbox.lastIndexOf('@');
  if (at <= 0 || at === mailbox.length - 1) return null;
  const local = mailbox.slice(0, at);
  const domain = mailbox.slice(at + 1);
  // Local-part: dot-string or quoted-string; reject whitespace, control
  // characters (incl. C1 and the replacement character of broken UTF-8) and
  // angle brackets (a quoted local-part may contain spaces).
  const quoted = /^"(?:[^"\\\r\n]|\\.)*"$/.test(local);
  if (!quoted && /[\s<>()[\]\\,;:"\x00-\x1f\x7f-\x9f�]/.test(local)) return null;
  if (quoted && /[\x00-\x08\x0a-\x1f\x7f-\x9f�]/.test(local)) return null;
  if (NON_ASCII_RE.test(domain)) {
    const idn = normalizeIdnDomain(domain);
    return idn === null ? null : `${local}@${idn}`;
  }
  if (!isValidDomain(domain)) return null;
  return `${local}@${domain.toLowerCase()}`;
}

/** Parameter list; null on a syntax error or a repeated keyword. */
function parseParams(rest: string): Map<string, string> | null {
  const params = new Map<string, string>();
  const trimmed = rest.trim();
  if (trimmed === '') return params;
  // Parameters must be separated from the path by a space.
  if (!/^\s/.test(rest)) return null;
  for (const token of trimmed.split(/\s+/)) {
    const m = PARAM_RE.exec(token);
    if (!m) return null;
    const key = m[1]!.toUpperCase();
    // RFC 3461 §4.1–4.4 / RFC 1870: a parameter MUST NOT appear twice.
    if (params.has(key)) return null;
    params.set(key, m[2] ?? '');
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

/** RFC 6531 §3.7.4.1 — a UTF-8 address in a transaction without SMTPUTF8. */
const NEEDS_SMTPUTF8 = '553 5.6.7 Non-ASCII address requires the SMTPUTF8 parameter';

/** `MAIL FROM:<reverse-path> [SP Mail-parameters]` */
export function parseMailFrom(arg: string, opts: EnvelopeOptions = {}): MailFromParse {
  const split = splitPath(arg, 'FROM');
  if (!split) return { ok: false, reply: '501 5.5.4 Syntax: MAIL FROM:<address>' };
  const params = parseParams(split.rest);
  if (!params) return { ok: false, reply: '501 5.5.4 Syntax error in MAIL parameters' };
  let body: BodyType = '7BIT';
  let smtputf8 = false;
  let ret: DsnRet | undefined;
  let envid: string | undefined;
  for (const [key, value] of params) {
    switch (key) {
      case 'SIZE':
        if (!/^\d{1,20}$/.test(value)) return { ok: false, reply: '501 5.5.4 Invalid SIZE parameter' };
        break;
      case 'AUTH':
        break;
      case 'BODY': {
        const v = value.toUpperCase();
        if (v === '7BIT' || v === '8BITMIME' || (v === 'BINARYMIME' && opts.chunking)) { body = v; break; }
        return { ok: false, reply: '555 5.5.4 BODY value not supported' };
      }
      case 'SMTPUTF8':
        if (!opts.smtputf8) return { ok: false, reply: '555 5.5.4 MAIL parameter SMTPUTF8 not recognized or not implemented' };
        if (value !== '') return { ok: false, reply: '501 5.5.4 SMTPUTF8 takes no value' };
        smtputf8 = true;
        break;
      case 'RET': {
        if (!opts.dsn) return { ok: false, reply: '555 5.5.4 MAIL parameter RET not recognized or not implemented' };
        const r = parseRet(value);
        if (!r) return { ok: false, reply: '501 5.5.4 Invalid RET parameter (FULL or HDRS)' };
        ret = r;
        break;
      }
      case 'ENVID': {
        if (!opts.dsn) return { ok: false, reply: '555 5.5.4 MAIL parameter ENVID not recognized or not implemented' };
        const e = parseEnvid(value);
        if (e === null) return { ok: false, reply: '501 5.5.4 Invalid ENVID parameter' };
        envid = e;
        break;
      }
      default:
        return { ok: false, reply: `555 5.5.4 MAIL parameter ${key} not recognized or not implemented` };
    }
  }
  const extra = { smtputf8, body, ...(ret ? { ret } : {}), ...(envid !== undefined ? { envid } : {}) };
  if (split.path === '') return { ok: true, address: '', params, ...extra };
  if (NON_ASCII_RE.test(split.path) && !smtputf8) return { ok: false, reply: NEEDS_SMTPUTF8 };
  const address = normalizeMailbox(split.path);
  if (address === null) return { ok: false, reply: '501 5.1.7 Bad sender address syntax' };
  return { ok: true, address, params, ...extra };
}

/** `RCPT TO:<forward-path> [SP Rcpt-parameters]` — NOTIFY / ORCPT when DSN is advertised. */
export function parseRcptTo(arg: string, opts: EnvelopeOptions = {}): RcptToParse {
  const split = splitPath(arg, 'TO');
  if (!split) return { ok: false, reply: '501 5.5.4 Syntax: RCPT TO:<address>' };
  const params = parseParams(split.rest);
  if (!params) return { ok: false, reply: '501 5.5.4 Syntax error in RCPT parameters' };
  const dsn: RcptDsn = {};
  for (const [key, value] of params) {
    if (!opts.dsn || (key !== 'NOTIFY' && key !== 'ORCPT')) {
      return { ok: false, reply: `555 5.5.4 RCPT parameter ${key} not recognized or not implemented` };
    }
    if (key === 'NOTIFY') {
      const n = parseNotify(value);
      if (!n) return { ok: false, reply: '501 5.5.4 Invalid NOTIFY parameter' };
      dsn.notify = n;
    } else {
      const o = parseOrcpt(value);
      if (!o) return { ok: false, reply: '501 5.5.4 Invalid ORCPT parameter' };
      if ((o.type === 'utf-8' || NON_ASCII_RE.test(o.address)) && !opts.utf8Transaction) return { ok: false, reply: NEEDS_SMTPUTF8 };
      dsn.orcpt = o;
    }
  }
  const dsnPart = dsn.notify || dsn.orcpt ? { dsn } : {};
  // RFC 5321 §4.1.1.3: "RCPT TO:<Postmaster>" (no domain) MUST be accepted.
  if (/^postmaster$/i.test(split.path)) return { ok: true, address: BARE_POSTMASTER, params, ...dsnPart };
  if (NON_ASCII_RE.test(split.path) && !opts.utf8Transaction) return { ok: false, reply: NEEDS_SMTPUTF8 };
  const address = split.path === '' ? null : normalizeMailbox(split.path);
  if (address === null) return { ok: false, reply: '501 5.1.3 Bad recipient address syntax' };
  return { ok: true, address, params, ...dsnPart };
}

/**
 * Command arguments arrive as octets (latin1 string). RFC 6531 §3.3: MAIL and
 * RCPT may carry UTF-8 — decode strictly (NFC); null for ill-formed UTF-8.
 */
export function decodeUtf8Command(octets: string): string | null {
  if (!/[\x80-\xff]/.test(octets)) return octets;
  const bytes = Buffer.from(octets, 'latin1');
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text.normalize('NFC') : null;
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
