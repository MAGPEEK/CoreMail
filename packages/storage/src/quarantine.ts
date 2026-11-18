/**
 * Quarantine helpers shared by smtp-server (store) and api-gateway (release).
 *
 * Envelope data (MAIL FROM + all RCPT TO) is kept in `Quarantine.details.envelope`
 * so that a release can re-inject the message for every original recipient —
 * `Quarantine.toAddr` only holds the first recipient (list/search column).
 *
 * The "released" state of a re-injected message is carried exclusively by an
 * internal flag on the BullMQ job / StoreOptions, never by a message header.
 * The informational header below is added on release for traceability and is
 * stripped from every message that arrives from outside (port 25), so it can
 * neither be forged nor ever be trusted.
 */

import { INTERNAL_MAIL_HEADERS } from './internal-headers.js';

// The complete internal header list (incl. the quarantine trace header) lives in internal-headers.ts.
export {
  QUARANTINE_RELEASE_HEADER, VIRUS_SCAN_HEADER, RULE_FORWARDED_HEADER, INTERNAL_MAIL_HEADERS, internalHeadersExcept,
} from './internal-headers.js';

export type QuarantineReason = 'VIRUS' | 'SPAM' | 'POLICY';

export interface QuarantineEnvelope {
  from:       string;
  recipients: string[];
}

/** Locate the end of the RFC 5322 header block (CRLF or bare LF). */
function headerEnd(raw: Buffer): { end: number; sepLen: number } | null {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf   = raw.indexOf('\n\n');
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { end: crlf, sepLen: 4 };
  if (lf >= 0) return { end: lf, sepLen: 2 };
  return null;
}

/**
 * Removes the given headers (case-insensitive, including folded continuation
 * lines) from the header block of a raw RFC 5322 message. The body is untouched.
 */
export function stripHeaders(raw: Buffer, names: readonly string[] = INTERNAL_MAIL_HEADERS): Buffer {
  const he = headerEnd(raw);
  const headerBuf = he ? raw.subarray(0, he.end) : raw;
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const lines = headerBuf.toString('binary').split(/\r?\n/);
  const kept: string[] = [];
  let dropping = false;
  let changed = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {           // folded continuation line
      if (dropping) { changed = true; continue; }
      kept.push(line);
      continue;
    }
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : '';
    dropping = name !== '' && lower.has(name);
    if (dropping) { changed = true; continue; }
    kept.push(line);
  }
  if (!changed) return raw;
  const newHeader = Buffer.from(kept.join('\r\n'), 'binary');
  if (!he) return newHeader;
  return Buffer.concat([newHeader, Buffer.from('\r\n\r\n'), raw.subarray(he.end + he.sepLen)]);
}

/** Prepends a header line to a raw message (used for the release trace header). */
export function prependHeader(raw: Buffer, name: string, value: string): Buffer {
  const safe = value.replace(/[\r\n]+/g, ' ');
  return Buffer.concat([Buffer.from(`${name}: ${safe}\r\n`, 'binary'), raw]);
}

/**
 * Reads the envelope of a quarantine record. Records written before v6.x have
 * no `details.envelope` — fall back to `fromAddr` / `toAddr`.
 */
export function quarantineEnvelope(item: { fromAddr: string; toAddr: string; details: unknown }): QuarantineEnvelope {
  const details = (item.details && typeof item.details === 'object') ? item.details as Record<string, unknown> : {};
  const env = (details['envelope'] && typeof details['envelope'] === 'object')
    ? details['envelope'] as Record<string, unknown>
    : null;
  const from = typeof env?.['from'] === 'string' ? env['from'] : item.fromAddr;
  const recipients = Array.isArray(env?.['recipients'])
    ? (env['recipients'] as unknown[]).filter((r): r is string => typeof r === 'string' && r.includes('@'))
    : [];
  return {
    from,
    recipients: recipients.length > 0 ? recipients : (item.toAddr ? [item.toAddr] : []),
  };
}
