/**
 * S/MIME Signature Verification
 *
 * Verifies incoming S/MIME signed messages (RFC 8551):
 *   - multipart/signed  (detached signature) — the signed content is the
 *     exact first body part INCLUDING its MIME headers (RFC 1847 §2.1)
 *   - application/pkcs7-mime; smime-type=signed-data  (opaque signed)
 *
 * Cryptography: ./cms-verify.ts (Node `crypto`, no forge — forge has no
 * PKCS#7 verify). The result is stored as JSON in Message.smimeMeta.
 *
 * Result semantics (honest reporting):
 *   valid     — signature correct, content unmodified, signer certificate
 *               within its validity period at signing time
 *   trusted   — additionally the certificate chains to a root of the
 *               bundled Mozilla CA store
 *   status    — 'trusted' | 'valid-untrusted' | 'invalid'
 *   fromMatches — the From header address equals the certificate address
 */

import { createLogger } from '@coremail/core';
import { verifyCmsSignedData, type TrustState } from './cms-verify.js';

const log = createLogger('smime:verify');

export interface SmimeVerifyResult {
  signed: boolean;
  valid: boolean;
  trusted?: boolean;
  status?: 'trusted' | 'valid-untrusted' | 'invalid';
  trust?: TrustState;
  trustReason?: string;
  signerEmail?: string;
  signerName?: string;
  fromMatches?: boolean;
  notBefore?: string;
  notAfter?: string;
  signingTime?: string;
  digestAlgorithm?: string;
  emailProtectionEku?: boolean;
  error?: string;
}

/**
 * Attempt to verify S/MIME signature in a raw message buffer.
 * Returns a result object — never throws (errors are captured in result.error).
 */
export async function verifyIncomingSmime(rawMessage: Buffer, opts: { now?: Date } = {}): Promise<SmimeVerifyResult> {
  // latin1 keeps a 1:1 byte mapping, so slices can be turned back into the exact bytes
  const msg = rawMessage.toString('latin1');
  const { head, bodyStart } = splitHeaders(msg);
  const contentType = headerValue(head, 'content-type');
  if (!contentType) return { signed: false, valid: false };

  const lower = contentType.toLowerCase();
  const isMultipartSigned = lower.startsWith('multipart/signed');
  const isOpaqueSigned = (lower.startsWith('application/pkcs7-mime') || lower.startsWith('application/x-pkcs7-mime'))
    && /smime-type\s*=\s*"?signed-data/i.test(contentType);
  if (!isMultipartSigned && !isOpaqueSigned) return { signed: false, valid: false };

  try {
    let der: Buffer;
    let detached: Buffer | null = null;
    if (isMultipartSigned) {
      const boundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
      const b = boundary?.[1] ?? boundary?.[2];
      if (!b) return { signed: true, valid: false, status: 'invalid', error: 'No boundary parameter found' };
      const parts = splitMultipart(msg.slice(bodyStart), b);
      if (parts.length < 2) return { signed: true, valid: false, status: 'invalid', error: 'Expected 2 MIME parts' };
      detached = Buffer.from(parts[0]!, 'latin1');
      der = decodePartBody(parts[1]!);
    } else {
      const cte = headerValue(head, 'content-transfer-encoding').toLowerCase();
      const body = msg.slice(bodyStart);
      der = cte === 'base64' || cte === '' ? Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64') : Buffer.from(body, 'latin1');
    }

    let r = verifyCmsSignedData(der, detached, opts.now ? { now: opts.now } : {});
    // Some transports convert CRLF → LF; retry once with canonical CRLF line endings.
    if (!r.signatureValid && detached && !detached.includes(Buffer.from('\r\n'))) {
      const canon = Buffer.from(detached.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
      const r2 = verifyCmsSignedData(der, canon, opts.now ? { now: opts.now } : {});
      if (r2.signatureValid) r = r2;
    }

    const from = bareAddress(headerValue(head, 'from'));
    const valid = r.signatureValid && r.certTimeValid;
    const trusted = valid && r.trust === 'trusted';
    return {
      signed: true,
      valid,
      trusted,
      status: trusted ? 'trusted' : valid ? 'valid-untrusted' : 'invalid',
      trust: r.trust,
      trustReason: r.trustReason,
      emailProtectionEku: r.emailProtectionEku,
      ...(r.signerEmail ? { signerEmail: r.signerEmail, fromMatches: !!from && from === r.signerEmail } : {}),
      ...(r.signerName ? { signerName: r.signerName } : {}),
      ...(r.notBefore ? { notBefore: r.notBefore } : {}),
      ...(r.notAfter ? { notAfter: r.notAfter } : {}),
      ...(r.signingTime ? { signingTime: r.signingTime } : {}),
      ...(r.digestAlgorithm ? { digestAlgorithm: r.digestAlgorithm } : {}),
      ...(r.error ? { error: r.error } : (!r.certTimeValid ? { error: 'certificate not valid at signing time' } : {})),
    };
  } catch (err) {
    log.warn({ err }, 'S/MIME verification error');
    return { signed: true, valid: false, status: 'invalid', error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ── MIME helpers (byte-exact, latin1 strings) ─────────────────────────────────

function splitHeaders(msg: string): { head: string; bodyStart: number } {
  const m = /\r?\n\r?\n/.exec(msg);
  if (!m) return { head: msg, bodyStart: msg.length };
  return { head: msg.slice(0, m.index), bodyStart: m.index + m[0].length };
}

function headerValue(head: string, name: string): string {
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im');
  return re.exec(unfolded)?.[1]?.trim() ?? '';
}

function bareAddress(v: string): string {
  const m = /<([^>]*)>/.exec(v);
  return (m ? m[1]! : v).trim().toLowerCase();
}

/**
 * Body parts of a multipart body. A part spans from after the CRLF that
 * ends a delimiter line up to (excluding) the CRLF that precedes the next
 * delimiter (RFC 2046 §5.1.1 — that CRLF belongs to the delimiter).
 */
export function splitMultipart(body: string, boundary: string): string[] {
  const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\r?\\n)--${esc}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  let prevEnd = -1;
  while ((m = re.exec(body)) !== null) {
    if (prevEnd >= 0) parts.push(body.slice(prevEnd, m.index));
    if (m[2]) break; // closing delimiter
    const lineEnd = body.indexOf('\n', m.index + m[0].length - 1);
    prevEnd = lineEnd >= 0 ? lineEnd + 1 : body.length;
    re.lastIndex = prevEnd;
  }
  return parts;
}

function decodePartBody(part: string): Buffer {
  const { head, bodyStart } = splitHeaders(part);
  const cte = headerValue(head, 'content-transfer-encoding').toLowerCase();
  const body = part.slice(bodyStart);
  if (cte === 'base64' || cte === '') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  return Buffer.from(body, 'latin1');
}
