/**
 * Certificate side effects shared by the admin router and the renewal
 * scheduler: ACME HTTP-01 issuance/renewal, protocol TLS binding
 * (SMTP/IMAP/POP3), and the reload notifications.
 *
 * Extracted from routes/admin/certificates.ts (v6) so that the scheduler in
 * lib/cert-renewal.ts can reuse the exact issuance code path.
 */
import { prisma } from '@coremail/storage';
import { getRedisClient, createLogger, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { deriveCertStatus, hostnameUpdateFor, parseCertValidity } from './cert-lifecycle.js';

const log = createLogger('admin:certificates');

/** Redis channel the integrated HTTPS proxy (tls-proxy.ts) listens on. */
export const CHANNEL_TLS_RELOAD = 'coremail:tls:reload';

export async function publishTlsReload(certId = ''): Promise<void> {
  await getRedisClient().publish(CHANNEL_TLS_RELOAD, certId).catch(() => {});
}

// ── ACME challenge token store (Redis, TTL 10 min) ────────────────────────────
const CHALLENGE_PREFIX = 'acme:challenge:';

export async function storeAcmeChallenge(token: string, keyAuth: string) {
  await getRedisClient().set(`${CHALLENGE_PREFIX}${token}`, keyAuth, 'EX', 600);
}

export async function getAcmeChallenge(token: string): Promise<string | null> {
  return getRedisClient().get(`${CHALLENGE_PREFIX}${token}`);
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
 * Writes certPem/keyPem to ServerSettings.tlsCert/tlsKey, marks this cert as
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
    create: { id: 'singleton', tlsCert: certPem, tlsKey: keyPem, ...(newHostname ? { publicHostname: newHostname } : {}) },
    update: { tlsCert: certPem, tlsKey: keyPem, ...(newHostname ? { publicHostname: newHostname } : {}) },
  });
  await prisma.$transaction([
    prisma.certificate.updateMany({ where: { id: { not: certId } }, data: { isActiveProtocol: false } }),
    prisma.certificate.update({ where: { id: certId }, data: { isActiveProtocol: true } }),
  ]);
  await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, certId);
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
  await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, '');
  log.info('Protocol TLS cert cleared — SMTP/IMAP/POP3 reverting to self-signed');
}

// ── ACME HTTP-01 issuance / renewal ───────────────────────────────────────────

/** Hard timeout for the whole ACME process (5 minutes). */
export const ACME_TIMEOUT_MS = 5 * 60_000;

export class AcmeTimeoutError extends Error {
  constructor() {
    super(
      `ACME timeout: certificate issuance aborted after ${ACME_TIMEOUT_MS / 60_000} minutes. ` +
      'Port 80 must be publicly reachable (/.well-known/acme-challenge/).',
    );
    this.name = 'AcmeTimeoutError';
  }
}

export interface AcmeRunOptions {
  /** Renewal of an existing certificate (keeps publicHostname, re-applies protocol TLS only if active). */
  isRenewal?: boolean;
  /**
   * Called once the issuance work has really finished — also when the
   * timeout already rejected the returned promise. Used to release the
   * per-certificate renewal lock only after the work stopped.
   */
  onSettled?: () => void | Promise<void>;
  /** Test seam: override the timeout. */
  timeoutMs?: number;
}

/**
 * Issues (or renews) a Let's Encrypt certificate. Rejects with
 * AcmeTimeoutError after ACME_TIMEOUT_MS; in that case the running work is
 * cancelled through an AbortSignal (checked between ACME steps and inside the
 * challenge callback) and never writes a late result over the ERROR status.
 */
export async function runAcmeIssuance(
  certId: string,
  domains: string[],
  email: string,
  autoRenew: boolean,
  staging: boolean,
  opts: AcmeRunOptions = {},
): Promise<void> {
  const ac = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new AcmeTimeoutError();
      ac.abort(err);
      reject(err);
    }, opts.timeoutMs ?? ACME_TIMEOUT_MS);
  });

  const work = runAcmeIssuanceCore(certId, domains, email, autoRenew, staging, ac.signal, !!opts.isRenewal);
  // Settlement hook: runs when the work really ends (not when the race ends).
  void work.then(() => undefined, () => undefined).then(async () => {
    try { await opts.onSettled?.(); } catch (err) { log.warn({ err, certId }, 'ACME onSettled hook failed'); }
  });

  try {
    await Promise.race([work, timeout]);
  } catch (err) {
    if (err instanceof AcmeTimeoutError) {
      log.warn({ certId, domains }, 'ACME issuance timed out — cancelled, marking certificate as ERROR');
      await prisma.certificate.update({
        where: { id: certId },
        data:  { status: 'ERROR', lastError: err.message.slice(0, 1000) },
      }).catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new AcmeTimeoutError();
}

async function runAcmeIssuanceCore(
  certId: string,
  domains: string[],
  email: string,
  _autoRenew: boolean,
  staging: boolean,
  signal: AbortSignal,
  isRenewal: boolean,
): Promise<void> {
  try {
    const acme = await import('acme-client');
    throwIfAborted(signal);

    // Load or generate the account key
    const existing = await prisma.certificate.findUnique({
      where: { id: certId }, select: { acmeAccount: true },
    });

    let accountKeyPem: string;
    if (existing?.acmeAccount) {
      accountKeyPem = existing.acmeAccount;
    } else {
      const newKey = await acme.crypto.createPrivateKey(2048);
      if (Buffer.isBuffer(newKey)) {
        accountKeyPem = (newKey as Buffer).toString('utf8');
      } else {
        const ck = newKey as import('crypto').KeyObject;
        const exported = ck.export({ type: 'pkcs8', format: 'pem' });
        accountKeyPem = typeof exported === 'string' ? exported : exported.toString('utf8');
      }
    }
    throwIfAborted(signal);

    const client = new acme.Client({
      directoryUrl: staging
        ? acme.directory.letsencrypt.staging
        : acme.directory.letsencrypt.production,
      accountKey: Buffer.from(accountKeyPem),
    });

    await client.createAccount({ termsOfServiceAgreed: true, contact: [`mailto:${email}`] });
    throwIfAborted(signal);

    const [certKey, csr] = await acme.crypto.createCsr({ altNames: domains });
    const certKeyPem = certKey.toString();
    throwIfAborted(signal);

    const certPem = await client.auto({
      csr,
      email,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      skipChallengeVerification: false,
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        // Abort the ACME order as soon as the timeout fired.
        throwIfAborted(signal);
        const token = (challenge as { token: string }).token;
        await storeAcmeChallenge(token, keyAuthorization);
        log.info({ token }, 'ACME HTTP-01 challenge token stored — Port 80 must be reachable');
      },
      challengeRemoveFn: async () => { /* token expires via Redis TTL */ },
    });
    // Late result after the timeout: discard — the cert is already ERROR and a
    // new attempt may be scheduled; never overwrite state from a zombie run.
    throwIfAborted(signal);

    const expiresAt = parseCertValidity(certPem.toString())?.validTo
      ?? new Date(Date.now() + 90 * 24 * 3600 * 1000); // LE default as fallback

    const issued = await prisma.certificate.update({
      where: { id: certId },
      data: {
        status:      deriveCertStatus(expiresAt),
        certPem:     certPem.toString(),
        keyPem:      certKeyPem,
        acmeAccount: accountKeyPem,
        issuedAt:    new Date(),
        expiresAt,
        lastError:   null,
      },
      select: { services: true, domains: true, isActiveProtocol: true },
    });

    log.info({ id: certId, expiresAt, renewal: isRenewal }, 'Let\'s Encrypt certificate issued successfully');

    // HTTPS proxy: rebuild the SNI map with the new PEM.
    await publishTlsReload(certId);

    // Protocol TLS: renewal re-applies the cert wherever it is active for
    // SMTP/IMAP/POP3; a first issuance auto-activates when mail services are assigned.
    const hasMailProtocol = (issued.services as string[]).some(s => ['SMTP', 'IMAP', 'POP3'].includes(s));
    if (issued.isActiveProtocol || (!isRenewal && hasMailProtocol)) {
      await applyProtocolCert(certId, certPem.toString(), certKeyPem, issued.domains as string[], { isRenewal });
    }
  } catch (err) {
    if (signal.aborted) {
      // The timeout handler already recorded the ERROR state.
      log.warn({ certId }, 'ACME issuance stopped after timeout');
      throw err;
    }
    const raw = err instanceof Error ? err.message : String(err);
    const hint = /challenge|http-01|connection|ECONNREFUSED|timeout/i.test(raw)
      ? ' — Hint: the HTTP-01 ACME challenge requires port 80 to be reachable from outside (/.well-known/acme-challenge/).'
      : '';
    await prisma.certificate.update({
      where: { id: certId },
      data: { status: 'ERROR', lastError: (raw + hint).slice(0, 1000) },
    }).catch(() => {});
    throw err;
  }
}
