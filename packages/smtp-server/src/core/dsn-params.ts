/**
 * DSN envelope parameters (RFC 3461) — pure helpers shared by the SMTP
 * session (parsing MAIL/RCPT parameters), the handlers (passing them on) and
 * the DSN generator (honouring NOTIFY / RET / ENVID / ORCPT).
 */

export type DsnNotify = 'SUCCESS' | 'FAILURE' | 'DELAY';
export type DsnRet = 'FULL' | 'HDRS';

/** Per-recipient DSN request (RCPT TO parameters). */
export interface RcptDsn {
  /** NOTIFY=NEVER → empty list; absent → the default FAILURE,DELAY applies. */
  notify?: DsnNotify[];
  /** ORCPT, decoded: address type (e.g. "rfc822") and the original address. */
  orcpt?: { type: string; address: string };
}

/** DSN request of one transaction (MAIL FROM + every RCPT TO). */
export interface EnvelopeDsn {
  ret?: DsnRet;
  /** ENVID, decoded (printable US-ASCII, at most 100 characters). */
  envid?: string;
  /** Keyed by the lower-cased recipient address as accepted in RCPT TO. */
  rcpts?: Record<string, RcptDsn>;
}

/** Notification kinds a DSN generator produces. */
export type DsnKind = 'success' | 'failure' | 'delay';

/** RFC 3461 §4: xtext = *( xchar / hexchar ), hexchar = "+" 2(upper-case HEX). */
export function decodeXtext(value: string): string | null {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x2b) { // "+"
      const hex = value.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
      continue;
    }
    // xchar: "!" (33) .. "~" (126) except "+" and "=".
    if (c < 0x21 || c > 0x7e || c === 0x3d) return null;
    out += value[i];
  }
  return out;
}

/** Encodes a string as xtext (bytes outside xchar → "+HH"). */
export function encodeXtext(value: string): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    out += byte < 0x21 || byte > 0x7e || byte === 0x2b || byte === 0x3d
      ? `+${byte.toString(16).toUpperCase().padStart(2, '0')}`
      : String.fromCharCode(byte);
  }
  return out;
}

/** `RET=FULL|HDRS` (case-insensitive). */
export function parseRet(value: string): DsnRet | null {
  const v = value.toUpperCase();
  return v === 'FULL' || v === 'HDRS' ? v : null;
}

/**
 * `ENVID=<xtext>` — RFC 3461 §4.4: at most 100 characters, the decoded value
 * consists of printable US-ASCII characters.
 */
export function parseEnvid(value: string): string | null {
  if (value.length === 0 || value.length > 100) return null;
  const decoded = decodeXtext(value);
  if (decoded === null || !/^[\x20-\x7e]+$/.test(decoded)) return null;
  return decoded;
}

/** `NOTIFY=NEVER` or a comma list of SUCCESS / FAILURE / DELAY (RFC 3461 §4.1). */
export function parseNotify(value: string): DsnNotify[] | null {
  const items = value.toUpperCase().split(',');
  if (items.length === 1 && items[0] === 'NEVER') return [];
  const out: DsnNotify[] = [];
  for (const item of items) {
    if (item !== 'SUCCESS' && item !== 'FAILURE' && item !== 'DELAY') return null;
    if (out.includes(item)) return null;
    out.push(item);
  }
  return out;
}

/**
 * `ORCPT=addr-type ";" xtext` (RFC 3461 §4.2), at most 500 characters. The
 * address type is an atom ("rfc822", or "utf-8" from RFC 6533 whose value may
 * carry UTF-8 when the transaction uses SMTPUTF8).
 */
export function parseOrcpt(value: string): { type: string; address: string } | null {
  if (value.length > 500) return null;
  const semi = value.indexOf(';');
  if (semi <= 0) return null;
  const type = value.slice(0, semi);
  if (!/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/.test(type)) return null;
  const raw = value.slice(semi + 1);
  if (raw === '') return null;
  let address: string | null;
  if (type.toLowerCase() === 'utf-8') {
    // RFC 6533 utf-8-addr-xtext: UTF-8 as is, "\x{HEX}" for specials.
    address = /[\x00-\x20]/.test(raw)
      ? null
      : raw.replace(/\\x\{([0-9A-Fa-f]{1,6})\}/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
  } else {
    address = decodeXtext(raw);
  }
  if (address === null || /[\r\n]/.test(address)) return null;
  return { type: type.toLowerCase(), address };
}

/** The DSN request of a recipient (case-insensitive address match). */
export function rcptDsn(dsn: EnvelopeDsn | undefined, rcpt: string): RcptDsn | undefined {
  return dsn?.rcpts?.[rcpt.toLowerCase()];
}

/**
 * RFC 3461 §4.1: does the recipient want a notification of this kind?
 * Without NOTIFY the server may act as for NOTIFY=FAILURE or FAILURE,DELAY —
 * CoreMail uses FAILURE,DELAY. SUCCESS only when explicitly requested;
 * NOTIFY=NEVER → no DSN at all.
 */
export function wantsNotification(rcpt: RcptDsn | undefined, kind: DsnKind): boolean {
  const notify = rcpt?.notify;
  if (notify === undefined) return kind !== 'success';
  return notify.includes(kind === 'success' ? 'SUCCESS' : kind === 'failure' ? 'FAILURE' : 'DELAY');
}

/** True when the DSN request carries anything worth passing on. */
export function hasDsnRequest(dsn: EnvelopeDsn | undefined): boolean {
  return !!dsn && (dsn.ret !== undefined || dsn.envid !== undefined || Object.keys(dsn.rcpts ?? {}).length > 0);
}

/** Restricts the per-recipient part of a DSN request to `rcpts`. */
export function dsnForRecipients(dsn: EnvelopeDsn | undefined, rcpts: string[]): EnvelopeDsn | undefined {
  if (!dsn) return undefined;
  const subset: Record<string, RcptDsn> = {};
  for (const r of rcpts) {
    const d = rcptDsn(dsn, r);
    if (d) subset[r.toLowerCase()] = d;
  }
  const out: EnvelopeDsn = {
    ...(dsn.ret ? { ret: dsn.ret } : {}),
    ...(dsn.envid !== undefined ? { envid: dsn.envid } : {}),
    ...(Object.keys(subset).length > 0 ? { rcpts: subset } : {}),
  };
  return hasDsnRequest(out) ? out : undefined;
}

/** Renames recipient keys (e.g. after IDN canonicalisation of local addresses). */
export function remapDsnRecipients(dsn: EnvelopeDsn | undefined, rename: Map<string, string>): EnvelopeDsn | undefined {
  if (!dsn?.rcpts) return dsn;
  const rcpts: Record<string, RcptDsn> = {};
  for (const [key, value] of Object.entries(dsn.rcpts)) rcpts[(rename.get(key) ?? key).toLowerCase()] = value;
  return { ...dsn, rcpts };
}
