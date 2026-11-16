/**
 * `X-CoreMail-Virus-Scan` header for inbound mail that is delivered or
 * quarantined without a clean ClamAV scan (security-filter `virusScan` note):
 *
 *   X-CoreMail-Virus-Scan: infected; signature="Win.Test.EICAR_HDB-1"; host=mx.example.com
 *   X-CoreMail-Virus-Scan: suspicious; signature="PUA.Win.Packer.Upx-1"; host=…
 *   X-CoreMail-Virus-Scan: unscanned; reason=too-large; host=…
 *   X-CoreMail-Virus-Scan: unscanned; reason=scanner-error; host=…
 *
 * The header is internal (storage INTERNAL_MAIL_HEADERS): a copy sent by an
 * outside sender is stripped before filtering, so it cannot be forged. Mail
 * rules can match on it (e.g. move "suspicious" mail to a folder).
 */
/**
 * Same value as storage `VIRUS_SCAN_HEADER` (listed in INTERNAL_MAIL_HEADERS);
 * kept local so this pure module does not load @coremail/storage (test asserts equality).
 */
export const VIRUS_SCAN_HEADER = 'X-CoreMail-Virus-Scan';

export interface VirusScanNote {
  status: 'infected' | 'suspicious' | 'unscanned';
  signature?: string;
  reason?: 'too-large' | 'scanner-error';
}

const STATUSES = new Set(['infected', 'suspicious', 'unscanned']);
const REASONS = new Set(['too-large', 'scanner-error']);

/** Pure: validate the untrusted JSON field of the filter answer. */
export function parseVirusScanNote(v: unknown): VirusScanNote | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o['status'] !== 'string' || !STATUSES.has(o['status'])) return undefined;
  const note: VirusScanNote = { status: o['status'] as VirusScanNote['status'] };
  if (typeof o['signature'] === 'string') {
    // clamd signature names: letters, digits, . _ - : (no quotes, no CR/LF)
    const sig = o['signature'].replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 120);
    if (sig) note.signature = sig;
  }
  if (typeof o['reason'] === 'string' && REASONS.has(o['reason'])) note.reason = o['reason'] as NonNullable<VirusScanNote['reason']>;
  return note;
}

/** Pure: the header line (CRLF-terminated) for a validated note. */
export function virusScanHeaderLine(note: VirusScanNote, hostname: string): string {
  const host = hostname.replace(/[^A-Za-z0-9.-]/g, '').slice(0, 253) || 'localhost';
  const parts: string[] = [note.status];
  if (note.signature) parts.push(`signature="${note.signature}"`);
  if (note.reason) parts.push(`reason=${note.reason}`);
  parts.push(`host=${host}`);
  return `${VIRUS_SCAN_HEADER}: ${parts.join('; ')}\r\n`;
}
