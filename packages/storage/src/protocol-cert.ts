/**
 * Protocol TLS cert loader (v5.2.8+)
 *
 * Loads the matching TLS certificate for a protocol server (SMTP/IMAP/POP3)
 * **directly from the `certificates` table** based on the `services` list.
 *
 * Lookup order:
 *   1. ACTIVE cert with `isActiveProtocol = true` AND `services` containing the
 *      requested service name (e.g. 'SMTP', 'IMAP', 'POP3').
 *   2. Fallback: legacy `ServerSettings.tlsCert` + `tlsKey` (for older
 *      setups before v5.2.8 — pre-services model).
 *   3. If nothing is found: returns `null`, the caller generates a
 *      self-signed cert (only sensible on the very first start).
 *
 * This architecture replaces the fragile ServerSettings.tlsCert sync that until
 * v5.2.7 was updated by hand in `applyProtocolCert()` and could be
 * overwritten by the smtp-server on every restart.
 */

import { prisma } from './prisma/index.js';

export interface ProtocolCert {
  certPem: string;
  keyPem:  string;
  source:  'protocol-cert' | 'legacy-server-settings';
  certId?: string;
  certName?: string;
}

/**
 * @param service 'SMTP' | 'IMAP' | 'POP3' (case-insensitive, uppercase internally)
 */
export async function loadProtocolCert(service: string): Promise<ProtocolCert | null> {
  const svc = service.toUpperCase();

  // 1. Cert with services[svc] + isActiveProtocol
  const cert = await prisma.certificate.findFirst({
    where: {
      status:           'ACTIVE',
      isActiveProtocol: true,
      services:         { has: svc },
      certPem:          { not: null },
      keyPem:           { not: null },
    },
    select: { id: true, name: true, certPem: true, keyPem: true },
  }).catch(() => null);

  if (cert?.certPem && cert.keyPem) {
    return {
      certPem:  cert.certPem,
      keyPem:   cert.keyPem,
      source:   'protocol-cert',
      certId:   cert.id,
      certName: cert.name,
    };
  }

  // 2. Fallback: legacy ServerSettings.tlsCert
  const settings = await prisma.serverSettings.findUnique({
    where:  { id: 'singleton' },
    select: { tlsCert: true, tlsKey: true },
  }).catch(() => null);

  if (settings?.tlsCert && settings?.tlsKey) {
    return {
      certPem: settings.tlsCert,
      keyPem:  settings.tlsKey,
      source:  'legacy-server-settings',
    };
  }

  return null;
}
