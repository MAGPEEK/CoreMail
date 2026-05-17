/**
 * TLS-Zertifikat-Utilities — CoreMail
 *
 * Generiert selbstsignierte Zertifikate für SMTP (Port 465),
 * IMAP (Port 993) und POP3 (Port 995) implizites TLS.
 *
 * Erfordert: openssl im PATH (in Alpine-Containern standardmäßig verfügbar).
 */

import { execSync }                       from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir }                          from 'node:os';
import { join }                            from 'node:path';

export interface TlsCertPair {
  /** PEM-kodiertes Zertifikat */
  certPem: string;
  /** PEM-kodierter privater Schlüssel */
  keyPem: string;
}

/**
 * Generiert ein selbstsigniertes RSA-2048 TLS-Zertifikat via openssl.
 *
 * - Gültig 10 Jahre
 * - SAN: DNS:<hostname> + IP:127.0.0.1
 * - Kein Passwort (-nodes)
 *
 * @throws Wenn openssl nicht im PATH ist oder die Generierung fehlschlägt.
 */
export function generateSelfSignedCert(hostname: string): TlsCertPair {
  const dir = mkdtempSync(join(tmpdir(), 'coremail-tls-'));
  try {
    const keyFile  = join(dir, 'key.pem');
    const certFile = join(dir, 'cert.pem');

    // subjectAltName via -addext erfordert OpenSSL ≥ 1.1.1
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
 * Konvertiert ein PEM-Zertifikat und einen PEM-Schlüssel in Buffer-Objekte,
 * wie sie von node:tls.createServer() erwartet werden.
 */
export function tlsPemToBuffers(certPem: string, keyPem: string): { cert: Buffer; key: Buffer } {
  return {
    cert: Buffer.from(certPem, 'utf8'),
    key:  Buffer.from(keyPem,  'utf8'),
  };
}
