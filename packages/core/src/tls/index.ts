/**
 * TLS certificate utilities — CoreMail
 *
 * Generates self-signed certificates for SMTP (port 465),
 * IMAP (port 993) and POP3 (port 995) implicit TLS.
 *
 * Requires: openssl in PATH (available by default in Alpine containers).
 */

import { execSync }                       from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir }                          from 'node:os';
import { join }                            from 'node:path';

export interface TlsCertPair {
  /** PEM-encoded certificate */
  certPem: string;
  /** PEM-encoded private key */
  keyPem: string;
}

/**
 * Generates a self-signed RSA-2048 TLS certificate via openssl.
 *
 * - Valid for 10 years
 * - SAN: DNS:<hostname> + IP:127.0.0.1
 * - No password (-nodes)
 *
 * @throws If openssl is not in PATH or generation fails.
 */
export function generateSelfSignedCert(hostname: string): TlsCertPair {
  const dir = mkdtempSync(join(tmpdir(), 'coremail-tls-'));
  try {
    const keyFile  = join(dir, 'key.pem');
    const certFile = join(dir, 'cert.pem');

    // subjectAltName via -addext requires OpenSSL ≥ 1.1.1
    const cmd =
      `openssl req -x509 -newkey rsa:2048 ` +
      `-keyout "${keyFile}" -out "${certFile}" ` +
      `-days 3650 -nodes ` +
      `-subj "/CN=${hostname}/O=CoreMail/OU=Auto" ` +
      `-addext "subjectAltName=DNS:${hostname},DNS:localhost,IP:127.0.0.1"`;

    execSync(cmd, { stdio: 'pipe', timeout: 30_000 });

    return {
      keyPem:  readFileSync(keyFile,  'utf8'),
      certPem: readFileSync(certFile, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Converts a PEM certificate and a PEM key into Buffer objects,
 * as expected by node:tls.createServer().
 */
export function tlsPemToBuffers(certPem: string, keyPem: string): { cert: Buffer; key: Buffer } {
  return {
    cert: Buffer.from(certPem, 'utf8'),
    key:  Buffer.from(keyPem,  'utf8'),
  };
}
