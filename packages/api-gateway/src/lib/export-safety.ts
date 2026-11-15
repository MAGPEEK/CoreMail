/**
 * Export hardening helpers (8.0.x OWASP wave).
 *
 *  csvCell()          — RFC 4180 quoting + CSV/formula-injection neutralisation:
 *                       a value starting with = + - @ TAB or CR is prefixed with
 *                       a single quote so spreadsheet programs never evaluate it.
 *  exportSignature()  — keyed integrity signature for admin exports:
 *                       HMAC-SHA256 with a key derived via HKDF-SHA256 from
 *                       JWT_SECRET + PEPPER (info "audit-export"). Header value
 *                       `hmac-sha256=<hex>`. Unlike the former unkeyed SHA-256,
 *                       a modified file cannot be re-signed without the server secret.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: formula-safe, quoted when needed. */
export function csvCell(value: unknown): string {
  let v = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v) || v !== v.trim()) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** Same as csvCell, but always quoted (exports whose consumers expect quoted cells). */
export function csvCellQuoted(value: unknown): string {
  let v = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

const SIGNATURE_SALT = 'coremail-export-signature';
const SIGNATURE_INFO = 'audit-export';

function signatureKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const secret = env['JWT_SECRET'] ?? '';
  const pepper = env['PEPPER'] ?? '';
  if (!secret || !pepper) throw new Error('Export signature key derivation needs JWT_SECRET and PEPPER');
  return Buffer.from(hkdfSync('sha256', `${secret}\0${pepper}`, SIGNATURE_SALT, SIGNATURE_INFO, 32));
}

/** `hmac-sha256=<hex>` over the exact export payload. */
export function exportSignature(payload: string | Buffer, env: NodeJS.ProcessEnv = process.env): string {
  return `hmac-sha256=${createHmac('sha256', signatureKey(env)).update(payload).digest('hex')}`;
}

/** Constant-time verification of an `hmac-sha256=` header value. */
export function verifyExportSignature(payload: string | Buffer, header: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = Buffer.from(exportSignature(payload, env));
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}
