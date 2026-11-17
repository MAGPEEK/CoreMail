/**
 * Protocol TLS (SMTP/IMAP/POP3) — single source of truth (9.3).
 *
 * The certificate that holds the mail services in the `certificates` table is
 * the certificate SMTP/IMAP/POP3 serve. Every path that assigns mail services
 * (PUT, upload, self-signed, ACME issuance/renewal, activate-protocol, startup
 * reconciliation) goes through `assignProtocolCert()`, which
 *   - gives the certificate all three mail services (one protocol certificate
 *     for SMTP, IMAP and POP3 — the servers share one TLS context source),
 *   - removes them from every other certificate,
 *   - writes ServerSettings.tlsCert/tlsKey with the full chain, sets
 *     isActiveProtocol exclusively and publishes CHANNEL_SETTINGS_RELOAD
 *     (applyProtocolCert), and
 *   - writes an audit entry `certificate.protocol.switch`.
 * Removing the mail services from the protocol certificate falls back to the
 * self-signed default for the public host name (`fallbackToSelfSigned()`).
 *
 * Before 9.3 the PUT only moved the `services` label while the servers kept
 * serving the previous certificate (BCP showed SMTP/IMAP/POP3 on a Let's
 * Encrypt certificate, ports 993/465/587 served CN=mail.localhost).
 */
import { X509Certificate, generateKeyPair, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { prisma } from '@coremail/storage';
import { createLogger, getRedisClient } from '@coremail/core';
import { applyProtocolCert, clearProtocolCert, publishTlsReload } from './cert-acme.js';
import type { RenewRedis } from './cert-renewal.js';
import {
  buildFullChainPem, deriveCertStatus, extractCertHostnames, isDefaultHostname, isPemCurrentlyValid,
} from './cert-lifecycle.js';
import { audit, type AuditEntry } from './audit.js';

const log = createLogger('admin:certificates');
const generateKeyPairAsync = promisify(generateKeyPair);

export const MAIL_SERVICES = ['SMTP', 'IMAP', 'POP3'] as const;
const MAIL_SET = new Set<string>(MAIL_SERVICES);

/** Self-signed fallback name when no usable public host name is configured. */
export const DEFAULT_SELF_SIGNED_HOSTNAME = 'mail.localhost';

export function hasMailService(services: readonly string[] | null | undefined): boolean {
  return (services ?? []).some((s) => MAIL_SET.has(s));
}

/** Services with the mail group replaced by SMTP+IMAP+POP3 (non-mail entries kept). */
export function withMailServices(services: readonly string[] | null | undefined, on: boolean): string[] {
  const rest = (services ?? []).filter((s) => !MAIL_SET.has(s));
  return on ? [...rest, ...MAIL_SERVICES] : rest;
}

/** An issued certificate that is not a Let's Encrypt staging (untrusted) one. */
export function holdsTrustedPem(c: { type?: unknown; acmeStaging?: unknown; certPem?: unknown }): boolean {
  return typeof c.certPem === 'string' && c.certPem.length > 0 && !(c.type === 'LETSENCRYPT' && c.acmeStaging === true);
}

export function isStagingCert(c: { type?: unknown; acmeStaging?: unknown }): boolean {
  return c.type === 'LETSENCRYPT' && c.acmeStaging === true;
}

/** Why a certificate cannot serve SMTP/IMAP/POP3 right now, or null when it can. */
export type ProtocolBlocker = 'staging' | 'no-pem' | 'not-valid';

export function protocolBlocker(
  c: { type?: unknown; acmeStaging?: unknown; certPem?: string | null; keyPem?: string | null; status?: unknown },
  now: Date = new Date(),
): ProtocolBlocker | null {
  if (isStagingCert(c)) return 'staging';
  if (!c.certPem || !c.keyPem || c.status === 'PENDING') return 'no-pem';
  if (!isPemCurrentlyValid(c.certPem, now)) return 'not-valid';
  return null;
}

/** True when the PEM's subject equals its issuer (self-signed / self-issued). */
export function isSelfIssuedPem(pem: string | null | undefined): boolean {
  if (!pem) return false;
  try {
    const x = new X509Certificate(pem);
    return x.subject === x.issuer;
  } catch {
    return false;
  }
}

/** Common name of a PEM certificate (lowercased) or null. */
export function certCommonName(pem: string | null | undefined): string | null {
  if (!pem) return null;
  try {
    const m = /(?:^|\n|,\s*)CN=([^,\n]+)/i.exec(new X509Certificate(pem).subject);
    return m?.[1]?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Host name for the self-signed default: the configured public host name, else mail.localhost. */
export function selfSignedHostnameFor(publicHostname: string | null | undefined): string {
  const h = (publicHostname ?? '').trim().toLowerCase();
  return h && HOSTNAME_RE.test(h) && !isDefaultHostname(h) ? h : DEFAULT_SELF_SIGNED_HOSTNAME;
}

/**
 * Ensures exclusivity of the services assignment: removes the given services
 * from all other certificates.
 *
 * 9.2.x review: for a Let's Encrypt STAGING certificate the services are never
 * taken away from a certificate that holds an issued, trusted PEM.
 */
export async function claimServices(
  certId: string, services: readonly string[], opts: { staging?: boolean; onlyIssued?: boolean } = {},
): Promise<void> {
  if (services.length === 0) return;
  const all = await prisma.certificate.findMany({
    where:  { id: { not: certId } },
    select: { id: true, services: true, type: true, acmeStaging: true, certPem: true },
  });
  // onlyIssued: a not-yet-issued certificate keeps its pending assignment (startup repair)
  const others = all.filter((o) => (!opts.staging || !holdsTrustedPem(o)) && (!opts.onlyIssued || !!o.certPem));
  for (const other of others) {
    const current = (other.services ?? []) as string[];
    const remaining = current.filter((s) => !services.includes(s));
    if (remaining.length !== current.length) {
      await prisma.certificate.update({ where: { id: other.id }, data: { services: remaining } });
      log.info({ fromCertId: other.id, toCertId: certId, services }, 'Services transferred to another certificate (exclusivity enforced)');
    }
  }
}

/** Who triggered a switch (HTTP request) — absent for background switches. */
export type ProtocolActor = Pick<AuditEntry, 'actorId' | 'actorEmail' | 'ipAddress' | 'userAgent'>;

export interface AssignOptions {
  /** Why the switch happens — goes into the log and the audit entry. */
  reason: string;
  actor?: ProtocolActor;
  /** Keep ServerSettings.publicHostname unchanged (renewal, startup repair). */
  keepHostname?: boolean;
  /** Do not take the mail services away from not-yet-issued certificates. */
  keepPendingClaims?: boolean;
}

export type AssignResult =
  | { applied: true; certId: string; previousCertIds: string[] }
  | { applied: false; certId: string; blocker: ProtocolBlocker | 'not-found' };

/**
 * Makes `certId` the certificate of SMTP/IMAP/POP3: all three mail services,
 * removed from every other certificate, full chain applied, reload published,
 * audited. Refuses (applied:false) for staging, unissued or invalid PEMs —
 * the caller decides how to report that.
 */
export async function assignProtocolCert(certId: string, opts: AssignOptions): Promise<AssignResult> {
  const cert = await prisma.certificate.findUnique({
    where:  { id: certId },
    select: {
      id: true, name: true, type: true, status: true, acmeStaging: true, certPem: true, keyPem: true,
      chainPem: true, domains: true, services: true,
    },
  });
  if (!cert) return { applied: false, certId, blocker: 'not-found' };
  const blocker = protocolBlocker(cert);
  if (blocker) return { applied: false, certId, blocker };

  const previous = await prisma.certificate.findMany({
    where: { isActiveProtocol: true }, select: { id: true, name: true },
  });
  const previousCertIds = previous.map((p) => p.id).filter((id) => id !== certId);

  const services = withMailServices(cert.services as string[], true);
  if (services.join(',') !== ((cert.services ?? []) as string[]).join(',')) {
    await prisma.certificate.update({ where: { id: certId }, data: { services } });
  }
  await claimServices(certId, MAIL_SERVICES, { onlyIssued: !!opts.keepPendingClaims });
  await applyProtocolCert(
    certId, buildFullChainPem(cert.certPem!, cert.chainPem), cert.keyPem!, (cert.domains ?? []) as string[],
    { isRenewal: !!opts.keepHostname },
  );

  log.info({ certId, name: cert.name, previous: previousCertIds, reason: opts.reason },
    'SMTP/IMAP/POP3 now use this certificate');
  audit({
    ...(opts.actor ?? {}),
    action: 'certificate.protocol.switch',
    targetType: 'certificate',
    targetId: certId,
    targetName: cert.name,
    changes: {
      reason: opts.reason,
      from: previous.filter((p) => p.id !== certId).map((p) => ({ id: p.id, name: p.name })),
      to: { id: certId, name: cert.name },
    },
  });
  return { applied: true, certId, previousCertIds };
}

/** RSA-2048 self-signed certificate (node crypto key, node-forge signature). */
export async function createSelfSignedPem(domains: string[], days = 3650): Promise<{ certPem: string; keyPem: string; expiresAt: Date }> {
  const forge = (await import('node-forge')).default;
  const { privateKey: keyPem } = await generateKeyPairAsync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const pki = forge.pki;
  const privateKey = pki.privateKeyFromPem(keyPem) as import('node-forge').pki.rsa.PrivateKey;
  const cert = pki.createCertificate();
  cert.publicKey = pki.setRsaPublicKey(privateKey.n, privateKey.e);
  // Unique positive serial: browsers reject two certificates with the same issuer + serial.
  cert.serialNumber = '00' + randomBytes(16).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notAfter.getDate() + days);
  const attrs = [{ name: 'commonName', value: domains[0] }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'subjectAltName', altNames: domains.map((d) => ({ type: 2, value: d })) },
    { name: 'keyUsage', keyCertSign: false, digitalSignature: true, nonRepudiation: true, keyEncipherment: true, dataEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);
  cert.sign(privateKey, forge.md.sha256.create());
  return { certPem: pki.certificateToPem(cert), keyPem, expiresAt: cert.validity.notAfter };
}

async function publicHostname(): Promise<string | null> {
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { publicHostname: true },
  }).catch(() => null);
  return s?.publicHostname ?? null;
}

/**
 * The self-signed default for the public host name: an existing usable
 * SELF_SIGNED row covering the name (newest first), else a new one. Becomes
 * the protocol certificate. When nothing can be generated the protocol
 * certificate is cleared (the servers generate their own fallback).
 */
export async function fallbackToSelfSigned(opts: AssignOptions & { excludeId?: string }): Promise<AssignResult | null> {
  const hostname = selfSignedHostnameFor(await publicHostname());
  try {
    const rows = await prisma.certificate.findMany({
      where:  { type: 'SELF_SIGNED' },
      select: { id: true, certPem: true, keyPem: true, status: true, type: true, acmeStaging: true, createdAt: true },
    });
    const candidate = rows
      .filter((r) => r.id !== opts.excludeId && !protocolBlocker(r) && extractCertHostnames(r.certPem!).includes(hostname))
      .sort((a, b) => (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0))[0];
    let id = candidate?.id;
    if (!id) {
      const { certPem, keyPem, expiresAt } = await createSelfSignedPem([hostname]);
      const created = await prisma.certificate.create({
        data: {
          name: hostname, domains: [hostname], services: [], type: 'SELF_SIGNED',
          status: deriveCertStatus(expiresAt), certPem, keyPem, issuedAt: new Date(), expiresAt, autoRenew: false,
        },
        select: { id: true },
      });
      id = created.id;
      await publishTlsReload(id);
      log.info({ id, hostname }, 'Self-signed default certificate generated');
    }
    const r = await assignProtocolCert(id, opts);
    if (r.applied) return r;
    throw new Error(`self-signed default not usable (${r.blocker})`);
  } catch (err) {
    log.error({ err, hostname }, 'Self-signed default could not be applied — clearing protocol TLS (servers generate their own fallback)');
    await clearProtocolCert().catch(() => undefined);
    return null;
  }
}

/** Current protocol TLS state: the active certificate and whether it is the self-signed default. */
export async function protocolState(): Promise<{
  active: { id: string; type: string; certPem: string | null } | null;
  usesSelfSigned: boolean;
}> {
  const active = (await prisma.certificate.findMany({
    where: { isActiveProtocol: true }, select: { id: true, type: true, certPem: true, acmeStaging: true },
  })).find((c) => !isStagingCert(c)) ?? null;
  if (active) {
    return { active, usesSelfSigned: active.type === 'SELF_SIGNED' };
  }
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { tlsCert: true },
  }).catch(() => null);
  const tlsCert = (s as { tlsCert?: string | null } | null)?.tlsCert ?? null;
  return { active: null, usesSelfSigned: !tlsCert || isSelfIssuedPem(tlsCert) };
}

/**
 * After a successful (non-staging) Let's Encrypt issuance or renewal:
 *   - a certificate that is the protocol certificate or holds mail services is
 *     applied (renewal keeps the host name);
 *   - otherwise, when its domains include ServerSettings.publicHostname and
 *     SMTP/IMAP/POP3 still use the self-signed default, it is assigned
 *     automatically — and activated for HTTPS when no trusted HTTPS
 *     certificate is active.
 */
export async function afterAcmeIssued(certId: string, opts: { isRenewal: boolean }): Promise<'applied' | 'auto-assigned' | 'none'> {
  const cert = await prisma.certificate.findUnique({
    where: { id: certId }, select: { id: true, name: true, domains: true, services: true, isActiveProtocol: true },
  });
  if (!cert) return 'none';
  if (cert.isActiveProtocol || hasMailService(cert.services as string[])) {
    const r = await assignProtocolCert(certId, { reason: opts.isRenewal ? 'acme-renewal' : 'acme-issued', keepHostname: opts.isRenewal });
    return r.applied ? 'applied' : 'none';
  }
  const host = (await publicHostname())?.trim().toLowerCase() ?? '';
  if (!host || isDefaultHostname(host)) return 'none';
  if (!((cert.domains ?? []) as string[]).some((d) => d.toLowerCase() === host)) return 'none';
  const state = await protocolState();
  if (!state.usesSelfSigned) return 'none';

  const r = await assignProtocolCert(certId, { reason: 'acme-auto-assign-public-hostname', keepHostname: true });
  if (!r.applied) return 'none';

  const https = await prisma.certificate.findMany({
    where: { isActiveHttps: true }, select: { id: true, type: true, acmeStaging: true, certPem: true },
  });
  const trustedHttps = https.some((c) => c.type !== 'SELF_SIGNED' && holdsTrustedPem(c) && isPemCurrentlyValid(c.certPem));
  if (!trustedHttps) {
    await prisma.$transaction([
      prisma.certificate.updateMany({ data: { isActiveHttps: false } }),
      prisma.certificate.update({ where: { id: certId }, data: { isActiveHttps: true } }),
    ]);
    await publishTlsReload(certId);
    log.info({ certId }, 'Certificate for the public host name also activated for the HTTPS proxy (no trusted HTTPS certificate was active)');
    audit({
      action: 'certificate.https.activate', targetType: 'certificate', targetId: certId, targetName: cert.name,
      changes: { reason: 'acme-auto-assign-public-hostname' },
    });
  }
  return 'auto-assigned';
}

// ── Startup reconciliation ───────────────────────────────────────────────────

export interface ReconcileReport {
  action: 'consistent' | 'applied' | 'fallback-self-signed' | 'regenerated-self-signed' | 'none';
  certId?: string;
  notes: string[];
}

type CertRow = {
  id: string; name: string; type: string; status: string; acmeStaging: boolean; certPem: string | null;
  keyPem: string | null; chainPem: string | null; domains: string[]; services: string[];
  isActiveProtocol: boolean; updatedAt?: Date;
};

/**
 * Idempotent startup repair of the protocol TLS state (9.3):
 *   - staging certificates never hold mail services / isActiveProtocol;
 *   - the usable certificate holding the mail services wins ("services win" —
 *     that is what the admin sees in the BCP): when ServerSettings.tlsCert,
 *     isActiveProtocol or the service set disagree with it, it is applied;
 *   - no certificate holds mail services: a usable isActiveProtocol
 *     certificate (activated before services existed) keeps serving and gets
 *     the services; otherwise the self-signed default is applied;
 *   - the active self-signed default with CN=mail.localhost is regenerated
 *     for the real public host name (a trusted certificate is never replaced).
 */
export async function reconcileProtocolCertState(now: Date = new Date()): Promise<ReconcileReport> {
  const notes: string[] = [];
  const certs = (await prisma.certificate.findMany({
    select: {
      id: true, name: true, type: true, status: true, acmeStaging: true, certPem: true, keyPem: true,
      chainPem: true, domains: true, services: true, isActiveProtocol: true, updatedAt: true,
    },
  })) as unknown as CertRow[];
  const settings = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { tlsCert: true, publicHostname: true },
  }).catch(() => null) as { tlsCert?: string | null; publicHostname?: string | null } | null;
  const tlsCert = settings?.tlsCert ?? null;
  const opts: AssignOptions = { reason: 'startup-reconcile', keepHostname: true, keepPendingClaims: true };

  // 1. Staging certificates never hold mail services or the protocol flag.
  for (const c of certs.filter(isStagingCert)) {
    if (hasMailService(c.services) || c.isActiveProtocol) {
      await prisma.certificate.update({
        where: { id: c.id }, data: { services: withMailServices(c.services, false), isActiveProtocol: false },
      });
      c.services = withMailServices(c.services, false);
      c.isActiveProtocol = false;
      notes.push(`staging certificate ${c.name}: mail services removed`);
    }
  }

  const usable = (c: CertRow) => !protocolBlocker(c, now);
  const holders = certs.filter((c) => hasMailService(c.services) && usable(c));
  const active = certs.filter((c) => c.isActiveProtocol);
  const anyHolder = certs.some((c) => hasMailService(c.services));

  let target: CertRow | null = null;
  if (holders.length > 0) {
    target = holders.find((c) => c.isActiveProtocol)
      ?? [...holders].sort((a, b) =>
        (Number(a.type === 'SELF_SIGNED') - Number(b.type === 'SELF_SIGNED'))
        || ((b.updatedAt?.getTime?.() ?? 0) - (a.updatedAt?.getTime?.() ?? 0)))[0]!;
  } else {
    // nothing usable holds mail services → a usable active cert keeps serving
    target = active.find(usable) ?? null;
    if (target && anyHolder) {
      // a not-yet-issued certificate waits for its issuance — keep serving the active one
      const full = buildFullChainPem(target.certPem!, target.chainPem);
      if (tlsCert !== full) {
        await applyProtocolCert(target.id, full, target.keyPem!, target.domains, { isRenewal: true });
        notes.push(`tlsCert re-applied from active certificate ${target.name}`);
        log.warn({ certId: target.id, notes }, 'Startup reconciliation: protocol TLS repaired');
        return { action: 'applied', certId: target.id, notes };
      }
      return { action: 'consistent', certId: target.id, notes };
    }
  }

  if (target) {
    const full = buildFullChainPem(target.certPem!, target.chainPem);
    const consistent = target.isActiveProtocol
      && active.length === 1
      && tlsCert === full
      && MAIL_SERVICES.every((s) => target!.services.includes(s))
      && !certs.some((c) => c.id !== target!.id && hasMailService(c.services) && usable(c));
    if (!consistent) {
      const r = await assignProtocolCert(target.id, opts);
      if (r.applied) {
        notes.push(`protocol certificate set to ${target.name} (services and server settings aligned)`);
        log.warn({ certId: target.id, name: target.name, previous: r.previousCertIds, notes },
          'Startup reconciliation: SMTP/IMAP/POP3 certificate repaired');
        target.isActiveProtocol = true;
      }
    }
    const regen = await regenerateDefaultSelfSigned(target, settings?.publicHostname ?? null, opts);
    if (regen) return { action: 'regenerated-self-signed', certId: target.id, notes: [...notes, regen] };
    return { action: consistent ? 'consistent' : 'applied', certId: target.id, notes };
  }

  // No usable certificate at all for SMTP/IMAP/POP3 → the self-signed default.
  const r = await fallbackToSelfSigned(opts);
  notes.push(r?.applied ? 'self-signed default applied' : 'self-signed default could not be applied');
  log.warn({ notes, hadTlsCert: !!tlsCert }, 'Startup reconciliation: no certificate for SMTP/IMAP/POP3 — self-signed default');
  return { action: r?.applied ? 'fallback-self-signed' : 'none', ...(r?.applied ? { certId: r.certId } : {}), notes };
}

// ── Startup reconciliation lock ──────────────────────────────────────────────
// Several api-gateway instances start at the same time (rolling update,
// replicas): without a lock each of them could create its own self-signed
// default row. Same pattern as the certificate renewal locks (cert-renewal.ts:
// SET NX PX with a random token, compare-and-delete release, test seam
// globalThis.__certRenewRedis).

export const RECONCILE_LOCK_KEY = 'cert:protocol:reconcile:lock';
/** Upper bound for one run (a self-signed key pair takes well under a second). */
export const RECONCILE_LOCK_TTL_MS = 2 * 60_000;
const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

type LockRedis = Pick<RenewRedis, 'set' | 'eval'>;

function lockRedis(): LockRedis {
  return (globalThis as { __certRenewRedis?: LockRedis }).__certRenewRedis
    ?? getRedisClient() as unknown as LockRedis;
}

/**
 * reconcileProtocolCertState() under a cluster-wide Redis lock. Returns null —
 * without touching anything — when another instance holds the lock (it does
 * the repair) or the lock cannot be taken (Redis unavailable).
 */
export async function reconcileProtocolCertStateLocked(
  now: Date = new Date(), r: LockRedis = lockRedis(),
): Promise<ReconcileReport | null> {
  const token = randomUUID();
  let got: 'OK' | null;
  try {
    got = await r.set(RECONCILE_LOCK_KEY, token, 'PX', RECONCILE_LOCK_TTL_MS, 'NX');
  } catch (err) {
    log.warn({ err }, 'Protocol TLS reconciliation skipped — lock not available (Redis)');
    return null;
  }
  if (got !== 'OK') {
    log.debug('Protocol TLS reconciliation skipped — another instance holds the lock');
    return null;
  }
  try {
    return await reconcileProtocolCertState(now);
  } finally {
    await r.eval(RELEASE_LOCK_SCRIPT, 1, RECONCILE_LOCK_KEY, token)
      .catch((err: unknown) => log.warn({ err }, 'Protocol TLS reconciliation lock release failed (expires by TTL)'));
  }
}

/**
 * The active protocol certificate is the self-signed default for
 * mail.localhost while a real public host name is configured → regenerate it
 * in place for the public host name. Never touches a non-self-signed cert.
 */
async function regenerateDefaultSelfSigned(target: CertRow, hostname: string | null, opts: AssignOptions): Promise<string | null> {
  if (target.type !== 'SELF_SIGNED') return null;
  const wanted = selfSignedHostnameFor(hostname);
  if (wanted === DEFAULT_SELF_SIGNED_HOSTNAME) return null;
  if (certCommonName(target.certPem) !== DEFAULT_SELF_SIGNED_HOSTNAME) return null;
  const { certPem, keyPem, expiresAt } = await createSelfSignedPem([wanted]);
  await prisma.certificate.update({
    where: { id: target.id },
    data: {
      name: wanted, domains: [wanted], certPem, keyPem, chainPem: null,
      status: deriveCertStatus(expiresAt), issuedAt: new Date(), expiresAt,
    },
  });
  await assignProtocolCert(target.id, { ...opts, reason: 'self-signed-regenerated-for-public-hostname' });
  log.warn({ certId: target.id, hostname: wanted }, 'Self-signed default regenerated for the public host name (was CN=mail.localhost)');
  return `self-signed default regenerated for ${wanted}`;
}
