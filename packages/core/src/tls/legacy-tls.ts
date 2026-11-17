/**
 * TLS protocol policy for mail listeners and the HTTPS proxy.
 *
 * Default: TLS 1.2 and 1.3 only (Node's default cipher list).
 *
 * Opt-in per listener ("Ältere Clients erlauben"): TLS 1.0 and 1.1 are accepted
 * as well, for old mail clients that cannot speak TLS 1.2. OpenSSL 3 refuses
 * TLS < 1.2 at security level 1 and above (SHA-1 handshake signatures), so the
 * legacy policy has to lower the level with `@SECLEVEL=0`. Because that level
 * would also admit weak suites, the cipher list is explicit and closed:
 *
 *  - TLS 1.2 forward-secret AEAD suites first (modern clients keep them),
 *  - then ECDHE + AES-CBC-SHA (what TLS 1.0/1.1 clients can negotiate),
 *  - then plain-RSA AES as the last resort for very old stacks,
 *  - explicit exclusions: no NULL / anonymous / EXPORT / DES / 3DES / RC4 /
 *    MD5 / PSK / SRP, and no DHE (no DH parameters are configured).
 *
 * TLS 1.3 suites are configured separately by OpenSSL and stay unchanged.
 * This is the only place that knows about `@SECLEVEL=0`.
 */

/** TLS versions a listener accepts at minimum. */
export type TlsMinVersion = 'TLSv1' | 'TLSv1.2';

/** Options merged into tls.createServer / createSecureContext / setSecureContext. */
export interface TlsProtocolOptions {
  minVersion: TlsMinVersion;
  ciphers?: string;
  honorCipherOrder?: boolean;
}

/** Ordered allow-list of the legacy policy (OpenSSL names). */
export const LEGACY_TLS_CIPHER_SUITES: readonly string[] = [
  // TLS 1.2, forward secrecy, AEAD
  'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
  // TLS 1.2, forward secrecy, CBC
  'ECDHE-ECDSA-AES128-SHA256', 'ECDHE-RSA-AES128-SHA256',
  'ECDHE-ECDSA-AES256-SHA384', 'ECDHE-RSA-AES256-SHA384',
  // TLS 1.0/1.1 with forward secrecy
  'ECDHE-ECDSA-AES128-SHA', 'ECDHE-RSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA', 'ECDHE-RSA-AES256-SHA',
  // Last resort for very old stacks (no forward secrecy, still AES)
  'AES128-GCM-SHA256', 'AES256-GCM-SHA384',
  'AES128-SHA256', 'AES256-SHA256',
  'AES128-SHA', 'AES256-SHA',
];

/** Cipher classes that are never negotiated, whatever OpenSSL's defaults are. */
export const LEGACY_TLS_EXCLUSIONS: readonly string[] = [
  '!aNULL', '!eNULL', '!EXPORT', '!DES', '!3DES', '!RC4', '!MD5', '!PSK', '!SRP', '!kDHE',
];

/** The complete OpenSSL cipher string of the legacy policy. */
export const LEGACY_TLS_CIPHERS = [...LEGACY_TLS_CIPHER_SUITES, ...LEGACY_TLS_EXCLUSIONS, '@SECLEVEL=0'].join(':');

/** Name fragments that must never appear in an allowed suite (see tests). */
export const FORBIDDEN_CIPHER_FRAGMENTS: readonly string[] = ['RC4', 'DES', 'NULL', 'EXP', 'MD5', 'PSK', 'SRP', 'ADH', 'AECDH'];

/**
 * TLS options for one listener. `allowLegacy` false (the default) keeps the
 * pre-existing policy exactly: `{ minVersion: 'TLSv1.2' }`.
 */
export function tlsProtocolOptions(allowLegacy = false): TlsProtocolOptions {
  if (!allowLegacy) return { minVersion: 'TLSv1.2' };
  return { minVersion: 'TLSv1', ciphers: LEGACY_TLS_CIPHERS, honorCipherOrder: true };
}

/** Certificate material plus the protocol policy, ready for node:tls. */
export function tlsServerOptions(
  material: { cert: Buffer | string; key: Buffer | string },
  allowLegacy = false,
): { cert: Buffer | string; key: Buffer | string } & TlsProtocolOptions {
  return { cert: material.cert, key: material.key, ...tlsProtocolOptions(allowLegacy) };
}
