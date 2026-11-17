/**
 * Protocol TLS cert loader (v5.2.8+)
 *
 * Loads the matching TLS certificate for a protocol server (SMTP/IMAP/POP3)
 * **directly from the `certificates` table** based on the `services` list.
 *
 * Lookup order:
 *   1. Issued (non-PENDING) cert with `isActiveProtocol = true` AND `services` containing the
 *      requested service name (e.g. 'SMTP', 'IMAP', 'POP3').
 *   2. Fallback: legacy `ServerSettings.tlsCert` + `tlsKey` (for older
 *      setups before v5.2.8 — pre-services model).
 *   3. If nothing is found: returns `null`, the caller generates a
 *      self-signed cert (only sensible on the very first start).
 *
 * The private key is stored encrypted (private-key-crypto.ts) and returned as
 * plain PEM; an undecryptable key throws PrivateKeyDecryptError (the caller logs
 * it and does not serve TLS) instead of silently switching certificates.
 *
 * This architecture replaces the fragile ServerSettings.tlsCert sync that until
 * v5.2.7 was updated by hand in `applyProtocolCert()` and could be
 * overwritten by the smtp-server on every restart.
 */

import { prisma } from './prisma/index.js';
import { decryptPrivateKey } from './private-key-crypto.js';

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Appends chain certificates that are not yet part of certPem (full chain for TLS servers). */
export function pemWithChain(certPem: string, chainPem: string | null | undefined): string {
  if (!chainPem) return certPem;
  const norm = (s: string) => s.replace(/\s+/g, '');
  const have = new Set((certPem.match(PEM_CERT_RE) ?? []).map(norm));
  const extra = (chainPem.match(PEM_CERT_RE) ?? []).filter((c) => !have.has(norm(c)));
  return extra.length === 0 ? certPem : `${certPem.trimEnd()}\n${extra.join('\n')}\n`;
}

const FALLBACK_HOSTNAME = 'mail.localhost';
const UNCONFIGURED_HOSTNAMES = new Set(['', 'mail.local', 'mail.localhost', 'localhost']);
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * 9.3: host name for a self-signed fallback certificate — the configured public
 * host name when it is a valid DNS name, otherwise mail.localhost. Strictly
 * validated: the protocol servers pass it to openssl.
 */
export function selfSignedHostnameFrom(publicHostname: string | null | undefined): string {
  const h = (publicHostname ?? '').trim().toLowerCase();
  return h && !UNCONFIGURED_HOSTNAMES.has(h) && HOSTNAME_RE.test(h) ? h : FALLBACK_HOSTNAME;
}

/** selfSignedHostnameFrom(ServerSettings.publicHostname); mail.localhost when unreadable. */
export async function selfSignedFallbackHostname(): Promise<string> {
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { publicHostname: true },
  }).catch(() => null);
  return selfSignedHostnameFrom(s?.publicHostname);
}

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

  // 1. Cert with services[svc] + isActiveProtocol.
  // v6: any issued status — an EXPIRING / RENEWING / ERROR (failed renewal)
  // cert keeps its still-valid PEM in service; only PENDING has no PEM yet.
  // 9.2.x review: a Let's Encrypt STAGING certificate (untrusted) is never
  // served on SMTP/IMAP/POP3.
  const cert = await prisma.certificate.findFirst({
    where: {
      status:           { not: 'PENDING' },
      isActiveProtocol: true,
      services:         { has: svc },
      certPem:          { not: null },
      keyPem:           { not: null },
      NOT:              { type: 'LETSENCRYPT', acmeStaging: true },
    },
    select: { id: true, name: true, certPem: true, keyPem: true, chainPem: true },
  }).catch(() => null);

  if (cert?.certPem && cert.keyPem) {
    return {
      // 9.2.x: leaf + intermediates — an uploaded certificate with a separate
      // chain was served without its intermediates on SMTP/IMAP/POP3.
      certPem:  pemWithChain(cert.certPem, cert.chainPem),
      keyPem:   decryptPrivateKey(cert.keyPem),
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
    // The legacy copy may be the PEM of a staging certificate (applied before
    // 9.2.x) — ignore it as well (the caller falls back to self-signed).
    const staging = await prisma.certificate.findFirst({
      where:  { type: 'LETSENCRYPT', acmeStaging: true, certPem: settings.tlsCert },
      select: { id: true },
    }).catch(() => null);
    if (staging) return null;
    return {
      certPem: settings.tlsCert,
      keyPem:  decryptPrivateKey(settings.tlsKey),
      source:  'legacy-server-settings',
    };
  }

  return null;
}
