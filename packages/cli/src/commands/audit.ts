/**
 * `coremail audit …` — audit-log tooling (v8.1).
 *
 *   coremail audit verify <file> --signature <value>
 *
 * Sends the exported file (CSV / JSON / PDF, byte-exact) and the value of the
 * export's `X-CoreMail-Signature` header to
 * POST /api/v1/admin/audit-log/verify-export (compliance area). Exit code 0 =
 * valid, 1 = invalid. The server signs with AUDIT_EXPORT_SIGNING_KEY (or a key
 * derived from JWT_SECRET + PEPPER); exports signed before a key rotation
 * verify as invalid.
 */
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import type { CoreMailClient } from '../client.js';
import { printJson } from '../output.js';

export const VERIFY_EXPORT_PATH = '/api/v1/admin/audit-log/verify-export';

/** Accepts `hmac-sha256=<hex>`, the bare hex, or a pasted `X-CoreMail-Signature: …` line. */
export function normalizeSignature(value: string): string {
  const v = value.trim().replace(/^x-coremail-signature\s*:\s*/i, '').trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return `hmac-sha256=${v.toLowerCase()}`;
  if (/^hmac-sha256=[0-9a-f]{64}$/i.test(v)) return `hmac-sha256=${v.slice(12).toLowerCase()}`;
  throw new Error('--signature must be the X-CoreMail-Signature value (hmac-sha256=<64 hex>)');
}

export interface VerifyResult { valid: boolean; bytes?: number; algorithm?: string }

/** Uploads the file and returns the server's verdict. */
export async function verifyExport(api: Pick<CoreMailClient, 'postRaw'>, bytes: Uint8Array, signature: string): Promise<VerifyResult> {
  return api.postRaw<VerifyResult>(VERIFY_EXPORT_PATH, bytes, { 'X-CoreMail-Signature': normalizeSignature(signature) });
}

export function registerAudit(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const audit = program.command('audit').description('Audit log: verify signed exports');

  audit.command('verify <file>').description('Check the signature of an audit-log export (CSV / JSON / PDF)')
    .requiredOption('--signature <value>', 'value of the X-CoreMail-Signature header of the export')
    .action(async (file: string, opts: { signature: string }) => {
      const bytes = await readFile(file);
      const r = await verifyExport(api(), bytes, opts.signature);
      if (json()) printJson(r);
      else process.stdout.write(r.valid ? `VALID — ${file} matches its signature\n` : `INVALID — ${file} was modified or signed with another key\n`);
      if (!r.valid) process.exitCode = 1;
    });
}
