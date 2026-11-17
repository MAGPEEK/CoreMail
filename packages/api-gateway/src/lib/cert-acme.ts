/**
 * Certificate side effects shared by the admin router and the renewal
 * scheduler: ACME HTTP-01 issuance/renewal, protocol TLS binding
 * (SMTP/IMAP/POP3), and the reload notifications.
 *
 * Extracted from routes/admin/certificates.ts (v6) so that the scheduler in
 * lib/cert-renewal.ts can reuse the exact issuance code path.
 */
import dns from 'node:dns';
import { isIP } from 'node:net';
import { prisma, encryptPrivateKey } from '@coremail/storage';
import { decryptMfaSecret, encryptMfaSecret } from '@coremail/storage/auth';
import { getRedisClient, createLogger, CHANNEL_SETTINGS_RELOAD, isBlockedAddress } from '@coremail/core';
import { deriveCertStatus, hostnameUpdateFor, parseCertValidity } from './cert-lifecycle.js';
import {
  configureAcmeHttp, httpGetText, runAcmeFlow, throwIfAborted,
  type AcmeClientLike, type AcmeStep, type ChallengeServing, type HttpTextResult,
} from './acme-flow.js';
import { AcmeProblemError, toAcmeFailure } from './acme-errors.js';
import { definiteDnsProblem } from './acme-preflight.js';

const log = createLogger('admin:certificates');

/** Redis channel the integrated HTTPS proxy (tls-proxy.ts) listens on. */
export const CHANNEL_TLS_RELOAD = 'coremail:tls:reload';

/** Redis used for challenges, reload notifications and the pre-flight lock (test seam: globalThis.__certAcmeRedis). */
function redisClient(): ReturnType<typeof getRedisClient> {
  return (globalThis as { __certAcmeRedis?: ReturnType<typeof getRedisClient> }).__certAcmeRedis ?? getRedisClient();
}

export async function publishTlsReload(certId = ''): Promise<void> {
  await redisClient().publish(CHANNEL_TLS_RELOAD, certId).catch(() => {});
}

// ── ACME challenge token store (Redis, TTL 10 min) ────────────────────────────
const CHALLENGE_PREFIX = 'acme:challenge:';

export async function storeAcmeChallenge(token: string, keyAuth: string, ttlSeconds = 600) {
  await redisClient().set(`${CHALLENGE_PREFIX}${token}`, keyAuth, 'EX', ttlSeconds);
}

export async function getAcmeChallenge(token: string): Promise<string | null> {
  return redisClient().get(`${CHALLENGE_PREFIX}${token}`);
}

export async function removeAcmeChallenge(token: string): Promise<void> {
  await redisClient().del(`${CHALLENGE_PREFIX}${token}`);
}

/** Port of this api-gateway's plain-HTTP listener (the challenge route). */
function gatewayHttpPort(): number {
  return parseInt(process.env['API_PORT'] ?? '3000', 10);
}

/** Resolves a host name to all its addresses (test seam: ChallengeServingOptions.lookup). */
export type PublicLookup = (hostname: string) => Promise<string[]>;

const systemLookup: PublicLookup = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** Reported (as the error message) when the public name points to a private address. */
export const PRIVATE_TARGET_MESSAGE = 'privat/intern, nicht geprüft';

export interface ChallengeServingOptions {
  publicCheck?: boolean;
  ttlSeconds?: number;
  /** Test seam: DNS lookup of the public check. */
  lookup?: PublicLookup;
  /** Test seam: the HTTP GET used by the checks. */
  httpGet?: typeof httpGetText;
}

/**
 * Fetch of the token over the public name, SSRF-safe (9.2.x review): the name
 * is resolved first; when any address is private / loopback / link-local /
 * CGNAT / ULA / metadata (core `isBlockedAddress`) nothing is fetched and the
 * check reports "privat/intern, nicht geprüft" (error code EPRIVATE). Otherwise
 * the request goes to the vetted IP with the Host header — no second
 * resolution, so a rebinding DNS answer cannot redirect it. Only status and
 * body are returned: a redirect target (Location) is never echoed back.
 */
export async function checkPublicChallenge(
  domain: string,
  path: string,
  opts: { lookup?: PublicLookup; httpGet?: typeof httpGetText; timeoutMs?: number } = {},
): Promise<HttpTextResult> {
  const addrs = await (opts.lookup ?? systemLookup)(domain);
  if (addrs.length === 0) throw Object.assign(new Error('name does not resolve (ENOTFOUND)'), { code: 'ENOTFOUND' });
  if (addrs.some((a) => isBlockedAddress(a))) {
    throw Object.assign(new Error(PRIVATE_TARGET_MESSAGE), { code: 'EPRIVATE' });
  }
  const ip = addrs.find((a) => isIP(a) === 4) ?? addrs[0]!;
  const hostPart = isIP(ip) === 6 ? `[${ip}]` : ip;
  const res = await (opts.httpGet ?? httpGetText)(`http://${hostPart}${path}`, { host: domain, timeoutMs: opts.timeoutMs ?? 5_000 });
  return { status: res.status, body: res.body };
}

/**
 * Real challenge serving: Redis token store, loopback self-check against this
 * gateway (proves route + store + middleware without depending on hairpin NAT)
 * and the informational fetch over the public name (checkPublicChallenge).
 */
export function makeChallengeServing(opts: ChallengeServingOptions = {}): ChallengeServing {
  const path = (token: string) => `/.well-known/acme-challenge/${token}`;
  const get = opts.httpGet ?? httpGetText;
  return {
    store: (token, keyAuth) => storeAcmeChallenge(token, keyAuth, opts.ttlSeconds ?? 600),
    remove: (token) => removeAcmeChallenge(token),
    checkLocal: (domain, token) =>
      get(`http://127.0.0.1:${gatewayHttpPort()}${path(token)}`, { host: domain, timeoutMs: 5_000 }),
    ...(opts.publicCheck === false ? {} : {
      checkPublic: (domain: string, token: string) => checkPublicChallenge(domain, path(token), {
        ...(opts.lookup ? { lookup: opts.lookup } : {}), httpGet: get,
      }),
    }),
  };
}

// ── ACME client construction (test seam: globalThis.__acmeClientFactory) ──────

export type AcmeClientFactory = (directoryUrl: string, accountKeyPem: string) => AcmeClientLike | Promise<AcmeClientLike>;

export const LE_DIRECTORY = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging:    'https://acme-staging-v02.api.letsencrypt.org/directory',
} as const;

export function acmeDirectoryUrl(staging: boolean): string {
  return staging ? LE_DIRECTORY.staging : LE_DIRECTORY.production;
}

let acmeLoggerInstalled = false;

export async function createAcmeClient(directoryUrl: string, accountKeyPem: string): Promise<AcmeClientLike> {
  const factory = (globalThis as { __acmeClientFactory?: AcmeClientFactory }).__acmeClientFactory;
  if (factory) return factory(directoryUrl, accountKeyPem);
  const acme = await import('acme-client');
  configureAcmeHttp(acme);
  if (!acmeLoggerInstalled) {
    acmeLoggerInstalled = true;
    // acme-client's own trace (debug level) — the step logs below are info.
    acme.setLogger((msg: string) => log.debug({ acme: msg }, 'acme-client'));
  }
  return new acme.Client({ directoryUrl, accountKey: Buffer.from(accountKeyPem) }) as unknown as AcmeClientLike;
}

export async function createAccountKeyPem(): Promise<string> {
  const factory = (globalThis as { __acmeClientFactory?: AcmeClientFactory }).__acmeClientFactory;
  if (factory) return '-----BEGIN TEST ACCOUNT KEY-----';
  const acme = await import('acme-client');
  return (await acme.crypto.createPrivateKey(2048)).toString();
}

async function createCsrPem(domains: string[]): Promise<{ keyPem: string; csr: Buffer }> {
  const acme = await import('acme-client');
  const [key, csr] = await acme.crypto.createCsr({ altNames: domains });
  return { keyPem: key.toString(), csr };
}

/**
 * Network error towards the CA: find out what is wrong (DNS of the server,
 * blocked outbound HTTPS, …) with one bounded request to the directory.
 */
export async function probeAcmeDirectory(directoryUrl: string): Promise<string> {
  try {
    const res = await fetch(directoryUrl, { signal: AbortSignal.timeout(10_000) });
    return `the directory ${new URL(directoryUrl).host} answers (HTTP ${res.status}) — the failure was transient, retry`;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const reason = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
    return `cannot reach ${new URL(directoryUrl).host}: ${reason}`;
  }
}

// ── Protocol TLS binding ──────────────────────────────────────────────────────
//
// DESIGN PRINCIPLE (v3.17.35):
//   • Default state: SMTP/IMAP/POP3 use a self-signed cert (auto-generated).
//     server_settings.tlsCert/tlsKey = NULL.
//   • Explicit activation (activate-protocol) or ACME issuance with mail
//     services stores a CA-signed cert in ServerSettings.
//   • Renewal of the active protocol cert re-applies it (v6).
//   • Deletion: active cert deleted → tlsCert/tlsKey = NULL → self-signed.

/**
 * Writes certPem/keyPem to ServerSettings.tlsCert/tlsKey (key encrypted at rest;
 * `keyPem` may be plain PEM or an already encrypted stored value), marks this cert as
 * the only isActiveProtocol cert and publishes CHANNEL_SETTINGS_RELOAD
 * (SMTP/IMAP/POP3 swap their TLS context) plus the TLS proxy reload.
 *
 * publicHostname is only set from the cert when it is still a default
 * (unconfigured) hostname, and never on renewal (v6 — previously every
 * activation silently overwrote an admin-chosen hostname).
 */
export async function applyProtocolCert(
  certId:  string,
  certPem: string,
  keyPem:  string,
  domains: string[],
  opts: { isRenewal?: boolean } = {},
): Promise<void> {
  const settings = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { publicHostname: true },
  }).catch(() => null);
  const newHostname = hostnameUpdateFor(settings?.publicHostname, domains, { isRenewal: !!opts.isRenewal });

  await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', tlsCert: certPem, tlsKey: encryptPrivateKey(keyPem), ...(newHostname ? { publicHostname: newHostname } : {}) },
    update: { tlsCert: certPem, tlsKey: encryptPrivateKey(keyPem), ...(newHostname ? { publicHostname: newHostname } : {}) },
  });
  await prisma.$transaction([
    prisma.certificate.updateMany({ where: { id: { not: certId } }, data: { isActiveProtocol: false } }),
    prisma.certificate.update({ where: { id: certId }, data: { isActiveProtocol: true } }),
  ]);
  // A failed reload notification must not turn a stored certificate into a
  // failed issuance (the servers also pick it up on their next start).
  await redisClient().publish(CHANNEL_SETTINGS_RELOAD, certId)
    .catch((err: unknown) => log.warn({ err, certId }, 'Settings reload notification failed — SMTP/IMAP/POP3 use the cert after their next reload'));
  await publishTlsReload(certId);
  log.info({ certId, publicHostname: newHostname ?? '(unchanged)', renewal: !!opts.isRenewal },
    'Protocol TLS cert applied (SMTP/IMAP/POP3) — servers reloading');
}

/**
 * Removes the protocol cert from ServerSettings and clears isActiveProtocol
 * everywhere. SMTP/IMAP/POP3 fall back to self-signed immediately.
 */
export async function clearProtocolCert(): Promise<void> {
  await prisma.serverSettings.update({
    where: { id: 'singleton' },
    data: { tlsCert: null, tlsKey: null },
  }).catch(() => { /* singleton missing — NULL is the default */ });
  await prisma.certificate.updateMany({ data: { isActiveProtocol: false } });
  await redisClient().publish(CHANNEL_SETTINGS_RELOAD, '');
  log.info('Protocol TLS cert cleared — SMTP/IMAP/POP3 reverting to self-signed');
}

// ── ACME HTTP-01 issuance / renewal ───────────────────────────────────────────


/** Hard timeout for the whole ACME process (5 minutes). */
export const ACME_TIMEOUT_MS = 5 * 60_000;

export class AcmeTimeoutError extends Error {
  constructor(lastStep = 'starting', timeoutMs = ACME_TIMEOUT_MS) {
    const span = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${Math.max(1, Math.round(timeoutMs / 1000))} seconds`;
    super(`ACME timeout: certificate issuance did not finish within ${span} (last step: ${lastStep}).`);
    this.name = 'AcmeTimeoutError';
  }
}

export interface AcmeRunOptions {
  /**
   * Renewal of an existing certificate (keeps publicHostname, re-applies
   * protocol TLS only if active). Default: derived from the stored PEM — a
   * retry of a never-issued certificate is a first issuance.
   */
  isRenewal?: boolean;
  /**
   * Called once the issuance work has really finished — also when the
   * timeout already rejected the returned promise (and after the timeout's
   * ERROR write). Used to release the per-certificate lock.
   */
  onSettled?: () => void | Promise<void>;
  /** Test seam: override the timeout. */
  timeoutMs?: number;
}

/** Human-readable progress text (logs + timeout message). */
export function acmeStepText(step: AcmeStep | 'starting', info?: Record<string, unknown>): string {
  const d = typeof info?.['domain'] === 'string' ? info['domain'] : '';
  switch (step) {
    case 'starting':       return 'starting';
    case 'account':        return "registering the Let's Encrypt account";
    case 'order':          return 'creating the order';
    case 'authorizations': return 'fetching the domain authorizations';
    case 'challenge':      return `publishing the validation token for ${d}`;
    case 'local-check':    return `token for ${d} is served locally`;
    case 'public-check':   return `fetch of the token over the public name ${d}: ${String(info?.['result'] ?? '')}`;
    case 'validate':       return `waiting for Let's Encrypt to validate ${d} over port 80`;
    case 'validated':      return 'all domains validated';
    case 'finalize':       return 'finalizing the order';
    case 'download':       return 'downloading the certificate';
    case 'retry':          return `retrying after a network error (${String(info?.['label'] ?? '')})`;
    default:               return String(step);
  }
}

/** Challenge serving for issuance / pre-flight (test seam: globalThis.__acmeChallengeServing). */
export function getChallengeServing(opts: ChallengeServingOptions = {}): ChallengeServing {
  return (globalThis as { __acmeChallengeServing?: ChallengeServing }).__acmeChallengeServing ?? makeChallengeServing(opts);
}

function challengeServing(): ChallengeServing {
  return getChallengeServing();
}

/**
 * Issues (or renews) a Let's Encrypt certificate. Rejects with
 * AcmeTimeoutError after ACME_TIMEOUT_MS; the running work is cancelled
 * through an AbortSignal (every CA call and every poll sleep is abortable, so
 * it stops within seconds) and never writes a late result over the ERROR.
 * Any other failure ends in status ERROR with lastError = readable message
 * including the CA's problem detail and lastErrorCode = classified code.
 */
export async function runAcmeIssuance(
  certId: string,
  domains: string[],
  email: string,
  _autoRenew: boolean,
  staging: boolean,
  opts: AcmeRunOptions = {},
): Promise<void> {
  const ac = new AbortController();
  const progress = { step: acmeStepText('starting') };
  const timeoutMs = opts.timeoutMs ?? ACME_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timeoutWrite: Promise<unknown> = Promise.resolve();
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new AcmeTimeoutError(progress.step, timeoutMs);
      log.warn({ certId, domains, lastStep: progress.step }, 'ACME issuance timed out — cancelled, marking certificate as ERROR');
      timeoutWrite = prisma.certificate.update({
        where: { id: certId },
        data:  { status: 'ERROR', lastError: err.message.slice(0, 1000), lastErrorCode: 'timeout' },
      }).catch(() => undefined);
      ac.abort(err);
      reject(err);
    }, timeoutMs);
  });

  const work = runAcmeIssuanceCore(certId, domains, email, staging, ac.signal, opts.isRenewal, progress);
  // Settlement hook: after the work really ended AND the timeout's ERROR write
  // (if any) is done — the lock must not be free while a stale write is pending.
  void work.then(() => undefined, () => undefined).then(() => timeoutWrite).then(async () => {
    try { await opts.onSettled?.(); } catch (err) { log.warn({ err, certId }, 'ACME onSettled hook failed'); }
  });

  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runAcmeIssuanceCore(
  certId: string,
  domains: string[],
  email: string,
  staging: boolean,
  signal: AbortSignal,
  isRenewalOpt: boolean | undefined,
  progress: { step: string },
): Promise<void> {
  const onStep = (step: AcmeStep, info?: Record<string, unknown>) => {
    progress.step = acmeStepText(step, info);
    log.info({ certId, step, ...(info ?? {}) }, `ACME: ${progress.step}`);
  };
  try {
    throwIfAborted(signal);
    // Definite DNS / CAA problems fail before Let's Encrypt is contacted — a
    // failed validation counts against the CA's per-hostname failure limit.
    for (const domain of domains) {
      const problem = await definiteDnsProblem(domain);
      if (problem) throw problem;
    }
    throwIfAborted(signal);

    const existing = await prisma.certificate.findUnique({
      where: { id: certId }, select: { acmeAccount: true, certPem: true },
    });
    if (!existing) throw new AcmeProblemError('unknown', 'the certificate was deleted during issuance');
    const isRenewal = isRenewalOpt ?? !!existing.certPem;

    // The account key is stored before the first CA call: every retry reuses
    // the same account (new registrations are rate limited, too).
    let accountKeyPem = existing.acmeAccount ?? null;
    if (!accountKeyPem) {
      accountKeyPem = await createAccountKeyPem();
      throwIfAborted(signal);
      await prisma.certificate.update({ where: { id: certId }, data: { acmeAccount: accountKeyPem } });
    }

    const directoryUrl = acmeDirectoryUrl(staging);
    const client = await createAcmeClient(directoryUrl, accountKeyPem);
    const { keyPem: certKeyPem, csr } = await createCsrPem(domains);
    throwIfAborted(signal);
    log.info({ certId, domains, staging, renewal: isRenewal }, 'ACME: issuance started');

    const result = await runAcmeFlow(client, challengeServing(), { domains, csr, email, signal, onStep });
    // Late result after the timeout: discard — never overwrite the ERROR state.
    throwIfAborted(signal);
    const certPem = String(result.certificate ?? '');

    const expiresAt = parseCertValidity(certPem)?.validTo
      ?? new Date(Date.now() + 90 * 24 * 3600 * 1000); // LE default as fallback

    const issued = await prisma.certificate.update({
      where: { id: certId },
      data: {
        status:        deriveCertStatus(expiresAt),
        certPem,
        keyPem:        encryptPrivateKey(certKeyPem),
        chainPem:      null, // certPem is the full chain
        issuedAt:      new Date(),
        expiresAt,
        lastError:     null,
        lastErrorCode: null,
      },
      select: { services: true, domains: true, isActiveProtocol: true },
    });

    log.info({ id: certId, expiresAt, renewal: isRenewal, staging }, "Let's Encrypt certificate issued successfully");

    // HTTPS proxy: rebuild the SNI map with the new PEM.
    await publishTlsReload(certId);

    // Protocol TLS (9.3, single source of truth): a certificate holding the
    // mail services (or the active protocol certificate) is applied — first
    // issuance and renewal alike; a certificate for the public host name is
    // assigned automatically while SMTP/IMAP/POP3 still use the self-signed
    // default (lib/protocol-cert-assign.ts → afterAcmeIssued).
    // 9.2.x review: a Let's Encrypt STAGING certificate is untrusted — it is
    // never activated or re-applied automatically (it must not replace the
    // working certificate of SMTP/IMAP/POP3).
    const hasMailProtocol = (issued.services as string[]).some(s => ['SMTP', 'IMAP', 'POP3'].includes(s));
    if (staging) {
      if (issued.isActiveProtocol || hasMailProtocol) {
        log.info({ certId }, 'Staging certificate issued — protocol TLS left unchanged (staging is never activated automatically)');
      }
    } else {
      // The certificate is issued and stored at this point: a failure while
      // applying it to SMTP/IMAP/POP3 must not turn it into a failed issuance
      // (status ERROR over a valid PEM). The startup reconciliation / a manual
      // assignment repairs the protocol state.
      try {
        // dynamic import: protocol-cert-assign imports this module
        const { afterAcmeIssued } = await import('./protocol-cert-assign.js');
        const outcome = await afterAcmeIssued(certId, { isRenewal });
        if (outcome !== 'none') log.info({ certId, outcome }, 'Protocol TLS updated after issuance');
      } catch (err) {
        log.error({ err, certId }, 'Certificate issued, but applying it to SMTP/IMAP/POP3 failed — assign it again in BCP → SSL/TLS');
      }
    }
  } catch (err) {
    if (signal.aborted) {
      // The timeout handler records the ERROR state.
      log.warn({ certId, lastStep: progress.step }, 'ACME issuance stopped after timeout');
      throw err;
    }
    const failure = toAcmeFailure(err);
    let message = failure.message;
    if (failure.code === 'network') message += ` (${await probeAcmeDirectory(acmeDirectoryUrl(staging))})`;
    log.error({ certId, domains, code: failure.code, lastStep: progress.step, reason: message }, "Let's Encrypt issuance failed");
    await prisma.certificate.update({
      where: { id: certId },
      data: { status: 'ERROR', lastError: message.slice(0, 1000), lastErrorCode: failure.code },
    }).catch(() => undefined);
    throw err instanceof AcmeProblemError ? err : new AcmeProblemError(failure.code, message, { message });
  }
}

// ── Pre-flight: validation test against Let's Encrypt staging ─────────────────

const PREFLIGHT_LOCK = 'acme:preflight:lock';
const PREFLIGHT_ACCOUNT = 'acme:preflight:account-key';
export const PREFLIGHT_TIMEOUT_MS = 90_000;

/** Decrypts the stored pre-flight account key; null for plaintext / undecryptable values. */
export function decryptPreflightAccountKey(stored: string): string | null {
  if (!stored.startsWith('v1:')) return null;
  return decryptMfaSecret(stored)?.secret ?? null;
}

export type ExternalTestResult =
  | { status: 'ok'; message: string }
  | { status: 'error'; code: string; message: string };

/**
 * Real external check: asks the Let's Encrypt STAGING environment to validate
 * the domains over port 80 (no certificate is issued; production limits are
 * not touched). The authorizations are deactivated afterwards so the next test
 * validates again. One test at a time (Redis lock).
 */
export async function runAcmeValidationTest(domains: string[], timeoutMs = PREFLIGHT_TIMEOUT_MS): Promise<ExternalTestResult> {
  const redis = redisClient();
  const lock = await redis.set(PREFLIGHT_LOCK, '1', 'PX', timeoutMs + 10_000, 'NX');
  if (lock !== 'OK') return { status: 'error', code: 'busy', message: 'Another validation test is running — try again in a minute.' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new AcmeProblemError('timeout',
    `no result from the Let's Encrypt staging environment within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  try {
    // 9.2.x review: the account key is stored AES-256-GCM encrypted (same
    // helper as the TOTP secrets); a plaintext value from an older version or
    // one that no longer decrypts is replaced by a new key.
    const stored = await redis.get(PREFLIGHT_ACCOUNT);
    let keyPem = stored ? decryptPreflightAccountKey(stored) : null;
    if (!keyPem) {
      keyPem = await createAccountKeyPem();
      await redis.set(PREFLIGHT_ACCOUNT, encryptMfaSecret(keyPem), 'EX', 30 * 24 * 3600);
    }
    const client = await createAcmeClient(LE_DIRECTORY.staging, keyPem);
    await runAcmeFlow(client, getChallengeServing({ publicCheck: false, ttlSeconds: 180 }), {
      domains, signal: ac.signal, validateOnly: true, validationTimeoutMs: Math.max(5_000, timeoutMs - 15_000),
      onStep: (step, info) => log.info({ step, ...(info ?? {}) }, `ACME pre-flight: ${acmeStepText(step, info)}`),
    });
    return { status: 'ok', message: "Let's Encrypt (staging) reached this server over port 80 and validated every domain." };
  } catch (err) {
    const e = ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : err;
    const f = toAcmeFailure(e);
    let message = f.message;
    if (f.code === 'network') message += ` (${await probeAcmeDirectory(LE_DIRECTORY.staging)})`;
    log.warn({ domains, code: f.code, reason: message }, 'ACME pre-flight validation test failed');
    return { status: 'error', code: f.code, message };
  } finally {
    clearTimeout(timer);
    await redis.del(PREFLIGHT_LOCK).catch(() => undefined);
  }
}
