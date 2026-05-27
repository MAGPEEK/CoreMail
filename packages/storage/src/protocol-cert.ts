/**
 * Protocol-TLS-Cert-Loader (v5.2.8+)
 *
 * Lädt das passende TLS-Zertifikat für einen Protokoll-Server (SMTP/IMAP/POP3)
 * **direkt aus der `certificates`-Tabelle** anhand der `services`-Liste.
 *
 * Sucht in der Reihenfolge:
 *   1. ACTIVE Cert mit `isActiveProtocol = true` UND `services` enthält den
 *      gewünschten Service-Namen (z.B. 'SMTP', 'IMAP', 'POP3').
 *   2. Fallback: legacy `ServerSettings.tlsCert` + `tlsKey` (für ältere
 *      Setups bevor v5.2.8 — pre-services-Modell).
 *   3. Wenn nichts gefunden: liefert `null`, der Caller generiert ein
 *      self-signed Cert (nur beim allerersten Start sinnvoll).
 *
 * Diese Architektur ersetzt den fragilen ServerSettings.tlsCert-Sync der bis
 * v5.2.7 von Hand in `applyProtocolCert()` aktualisiert wurde und vom
 * smtp-server auf jedem Restart überschrieben werden konnte.
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
 * @param service 'SMTP' | 'IMAP' | 'POP3' (case-insensitive, intern uppercase)
 */
export async function loadProtocolCert(service: string): Promise<ProtocolCert | null> {
  const svc = service.toUpperCase();

  // 1. Cert mit services[svc] + isActiveProtocol
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
