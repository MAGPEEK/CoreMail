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
 * plain PEM; an undecryptable key throws UnreadableCertKeyError (a
 * PrivateKeyDecryptError naming the certificate). The mail servers use
 * loadProtocolTls(), which then serves the self-signed replacement for the
 * public host name — TLS stays on (an implicit-TLS port never falls back to
 * plaintext) and the condition is visible in the BCP (unreadableInUseCertKeys).
 *
 * This architecture replaces the fragile ServerSettings.tlsCert sync that until
 * v5.2.7 was updated by hand in `applyProtocolCert()` and could be
 * overwritten by the smtp-server on every restart.
 */

import { generateSelfSignedCert } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { PrivateKeyDecryptError, decryptPrivateKey } from './private-key-crypto.js';

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

/** Identifies a stored certificate in errors and the BCP (never key material). */
export interface CertIdentity {
  certId?: string;
  certName: string;
}

/** Name used for the legacy ServerSettings.tlsCert/tlsKey pair. */
export const LEGACY_SERVER_CERT_NAME = 'ServerSettings.tlsCert (legacy)';

/** The private key of an assigned certificate cannot be read (wrong encryption key or malformed). */
export class UnreadableCertKeyError extends PrivateKeyDecryptError {
  constructor(readonly cert: CertIdentity, cause: PrivateKeyDecryptError) {
    super(cause.reason);
    this.name = 'UnreadableCertKeyError';
    this.message = `Certificate "${cert.certName}": ${cause.message}`;
  }
}

function decryptKeyOf(cert: CertIdentity, stored: string): string {
  try {
    return decryptPrivateKey(stored);
  } catch (err) {
    if (err instanceof PrivateKeyDecryptError) throw new UnreadableCertKeyError(cert, err);
    throw err;
  }
}

/**
 * @param service 'SMTP' | 'IMAP' | 'POP3' (case-insensitive, uppercase internally)
 * @throws UnreadableCertKeyError when the assigned certificate's private key cannot be read
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
      keyPem:   decryptKeyOf({ certId: cert.id, certName: cert.name }, cert.keyPem),
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
      keyPem:  decryptKeyOf({ certName: LEGACY_SERVER_CERT_NAME }, settings.tlsKey),
      source:  'legacy-server-settings',
    };
  }

  return null;
}

// ── Unreadable private keys: self-signed replacement (w1 integration) ─────────

export interface SelfSignedPem { certPem: string; keyPem: string }
export type SelfSignedGenerator = (hostname: string) => SelfSignedPem;

export interface SelfSignedReplacement extends SelfSignedPem {
  hostname: string;
  /** Set when the visible self-signed default row of the certificates table is used. */
  certId?: string;
  certName?: string;
}

/** Generated replacements, once per process and host name (stable across reloads). */
const generatedReplacements = new Map<string, SelfSignedPem>();

/**
 * The self-signed certificate the mail servers (and the HTTPS proxy) fall back to
 * while an assigned certificate cannot be used: the self-signed default row for
 * the public host name when its key is readable, else a certificate generated in
 * memory (once per process and host name — nothing is written to the database,
 * so the stored certificates stay as they are until the admin replaces them).
 */
export async function selfSignedReplacement(generate: SelfSignedGenerator = generateSelfSignedCert): Promise<SelfSignedReplacement> {
  const hostname = await selfSignedFallbackHostname();
  const rows = await prisma.certificate.findMany({
    where:   { type: 'SELF_SIGNED', domains: { has: hostname }, certPem: { not: null }, keyPem: { not: null } },
    select:  { id: true, name: true, certPem: true, keyPem: true },
    orderBy: { createdAt: 'desc' },
  }).catch(() => []);
  for (const row of rows ?? []) {
    try {
      return { hostname, certPem: row.certPem!, keyPem: decryptPrivateKey(row.keyPem!), certId: row.id, certName: row.name };
    } catch { /* this row's key is unreadable as well — try the next one */ }
  }
  let generated = generatedReplacements.get(hostname);
  if (!generated) {
    generated = generate(hostname);
    generatedReplacements.set(hostname, generated);
  }
  return { hostname, ...generated };
}

export interface ProtocolTls {
  certPem: string;
  keyPem:  string;
  source:  ProtocolCert['source'] | 'self-signed-replacement';
  certId?: string;
  certName?: string;
  /** The assigned certificate whose private key is unreadable (the replacement is served instead). */
  unreadable?: CertIdentity;
}

/**
 * loadProtocolCert() for the mail servers: an assigned certificate whose private
 * key cannot be read is replaced by the self-signed replacement (TLS stays on,
 * an implicit-TLS port never falls back to plaintext); `unreadable` names it so
 * the server logs an error. null = nothing configured (first start).
 */
export async function loadProtocolTls(service: string, generate?: SelfSignedGenerator): Promise<ProtocolTls | null> {
  try {
    return await loadProtocolCert(service);
  } catch (err) {
    if (!(err instanceof UnreadableCertKeyError)) throw err;
    const r = await selfSignedReplacement(generate);
    return {
      certPem: r.certPem,
      keyPem:  r.keyPem,
      source:  'self-signed-replacement',
      ...(r.certId ? { certId: r.certId } : {}),
      ...(r.certName ? { certName: r.certName } : {}),
      unreadable: err.cert,
    };
  }
}

export interface UnreadableKeyCert {
  id: string;
  name: string;
  /** SMTP/IMAP/POP3 this certificate is assigned to (empty when it is not the protocol certificate). */
  services: string[];
  /** The certificate is the active HTTPS certificate. */
  https: boolean;
}

const MAIL_SERVICES = new Set(['SMTP', 'IMAP', 'POP3']);

/**
 * Certificates in use (protocol TLS or HTTPS) whose stored private key cannot be
 * read — for the BCP warning. Reads keys only to test them; returns no key data.
 */
export async function unreadableInUseCertKeys(): Promise<UnreadableKeyCert[]> {
  const rows = await prisma.certificate.findMany({
    where:  { status: { not: 'PENDING' }, keyPem: { not: null }, OR: [{ isActiveProtocol: true }, { isActiveHttps: true }] },
    select: { id: true, name: true, keyPem: true, services: true, isActiveProtocol: true, isActiveHttps: true },
  });
  const out: UnreadableKeyCert[] = [];
  for (const r of rows) {
    try { decryptPrivateKey(r.keyPem!); continue; } catch { /* unreadable → reported */ }
    out.push({
      id: r.id,
      name: r.name,
      services: r.isActiveProtocol ? r.services.filter((x) => MAIL_SERVICES.has(x)) : [],
      https: r.isActiveHttps,
    });
  }
  return out;
}
