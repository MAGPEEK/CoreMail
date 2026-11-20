/**
 * The certificate the integrated HTTPS server serves for the public host name
 * and whether clients trust it (shared by the protocol overview and, 10.4.2,
 * the BCP dashboard card "Zertifikat einrichten").
 *
 * Selection = tls-proxy.ts (lib/cert-lifecycle.ts servedProxyCert: SNI exact →
 * wildcard → default), trust = lib/protocol-overview.ts isTrustedHttpsCert
 * (CA-issued, not staging, currently valid, covers the host name).
 */
import { prisma, decryptPrivateKey } from '@coremail/storage';
import { servedProxyCert } from './cert-lifecycle.js';
import { isTrustedHttpsCert } from './protocol-overview.js';

/**
 * A row whose private key cannot be decrypted is not served by the HTTPS proxy
 * (tls-proxy.ts logs it on every reload); here it only drops out of the selection.
 */
export function withReadableKey<T extends { keyPem: string | null }>(row: T): T {
  if (!row.keyPem) return row;
  try {
    decryptPrivateKey(row.keyPem);
    return row;
  } catch {
    return { ...row, keyPem: null };
  }
}

export interface ServedHttpsCert {
  /** Public host name (lower case; 'localhost' when none is configured). */
  hostname: string;
  cert: { id: string; name: string; trusted: boolean } | null;
}

export async function loadServedHttpsCert(): Promise<ServedHttpsCert> {
  const [settings, rows] = await Promise.all([
    prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } }),
    prisma.certificate.findMany({
      where: { certPem: { not: null }, keyPem: { not: null } },
      select: {
        id: true, name: true, type: true, status: true, acmeStaging: true, isActiveHttps: true, createdAt: true,
        certPem: true, keyPem: true, chainPem: true, domains: true,
      },
    }),
  ]);
  const hostname = (settings?.publicHostname ?? '').trim().toLowerCase() || 'localhost';
  const cert = servedProxyCert(rows.map(withReadableKey), hostname);
  return { hostname, cert: cert ? { id: cert.id, name: cert.name, trusted: isTrustedHttpsCert(cert, hostname) } : null };
}
