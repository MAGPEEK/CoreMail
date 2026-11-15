/**
 * v8.1: SMTPUTF8 (RFC 6531), DSN (RFC 3461) and CHUNKING + BINARYMIME
 * (RFC 3030) are on by default on every SMTP listener (25, 465, 587) and can be
 * switched off with SMTP_EXT_SMTPUTF8 / SMTP_EXT_DSN / SMTP_EXT_CHUNKING=false.
 */
import type { EsmtpExtensions } from './types.js';

function flag(env: Record<string, string | undefined>, name: string): boolean {
  const raw = (env[name] ?? '').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

export function esmtpEnvFlags(env: Record<string, string | undefined> = process.env): Pick<EsmtpExtensions, 'smtputf8' | 'dsn' | 'chunking'> {
  return {
    smtputf8: flag(env, 'SMTP_EXT_SMTPUTF8'),
    dsn:      flag(env, 'SMTP_EXT_DSN'),
    chunking: flag(env, 'SMTP_EXT_CHUNKING'),
  };
}
