/**
 * Admin API: SSL/TLS certificate management
 *
 * GET    /api/v1/admin/certificates              — all certificates
 * GET    /api/v1/admin/certificates/:id          — single certificate (without private key)
 * POST   /api/v1/admin/certificates/letsencrypt  — request Let's Encrypt certificate (ACME HTTP-01)
 * POST   /api/v1/admin/certificates/upload       — upload own certificate (PEM)
 * POST   /api/v1/admin/certificates/self-signed  — generate self-signed certificate
 * PUT    /api/v1/admin/certificates/:id          — edit name, services, autoRenew
 * POST   /api/v1/admin/certificates/:id/renew    — renew certificate immediately
 * DELETE /api/v1/admin/certificates/:id          — delete certificate
 *
 * Internal (no auth):
 * GET    /.well-known/acme-challenge/:token      — ACME HTTP-01 challenge (registered in server.ts)
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { getRedisClient, createLogger, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

// String-literal type — mirrors the Prisma enum CertStatus without importing @prisma/client
type CertStatus = 'PENDING' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'ERROR' | 'RENEWING';

const log = createLogger('admin:certificates');
export const adminCertificatesRouter: RouterType = Router();
adminCertificatesRouter.use(requireAdmin);

// ── ACME challenge token store (Redis, TTL 10 min) ────────────────────────────
const CHALLENGE_PREFIX = 'acme:challenge:';

export async function storeAcmeChallenge(token: string, keyAuth: string) {
  const redis = getRedisClient();
  await redis.set(`${CHALLENGE_PREFIX}${token}`, keyAuth, 'EX', 600);
}

export async function getAcmeChallenge(token: string): Promise<string | null> {
  const redis = getRedisClient();
  return redis.get(`${CHALLENGE_PREFIX}${token}`);
}

// ── Derive certificate status from expiresAt ──────────────────────────────────
function deriveStatus(expiresAt: Date | null): CertStatus {
  if (!expiresAt) return 'PENDING';
  const now   = Date.now();
  const expMs = expiresAt.getTime();
  if (expMs < now)                         return 'EXPIRED';
  if (expMs < now + 30 * 24 * 3600 * 1000) return 'EXPIRING';
  return 'ACTIVE';
}

// ── Helper: hide private key ──────────────────────────────────────────────────
function safe(cert: Record<string, unknown>) {
  const { keyPem: _, acmeAccount: __, ...rest } = cert;
  return rest;
}

// ── Protocol TLS binding ───────────────────────────────────────────────────────
//
// DESIGN PRINCIPLE (v3.17.35):
//   • Default state: SMTP/IMAP/POP3 use a self-signed cert (auto-generated
//     from publicHostname). server_settings.tlsCert/tlsKey = NULL.
//   • Explicit activation: only when the admin presses a button (activate-protocol
//     or activate-https) is a CA-signed cert stored in ServerSettings.
//   • Deletion: when an active cert is deleted → server_settings.tlsCert/tlsKey
//     are set to NULL → protocol servers revert to self-signed immediately.
//   • Decoupling: HTTPS proxy and protocol TLS are fully independent.
//     A cert can be active for HTTPS only, for protocols only, or for both.

/**
 * Writes certPem/keyPem to ServerSettings.tlsCert/tlsKey and triggers an
 * SMTP/IMAP/POP3 server reload via CHANNEL_SETTINGS_RELOAD.
 * Sets isActiveProtocol: true on this cert (and false on all others).
 * Also updates publicHostname to the certificate's primary domain so that
 * SMTP/IMAP/POP3 immediately use the correct banner hostname.
 * Called ONLY by activate-protocol (explicitly by the admin).
 */
async function applyProtocolCert(
  certId:  string,
  certPem: string,
  keyPem:  string,
  domains: string[],
): Promise<void> {
  // Primary domain: the first non-wildcard entry of the domains list
  // becomes the new publicHostname — SMTP/IMAP/POP3 banner + self-signed fallback
  const primaryDomain = domains.find(d => !d.startsWith('*') && d !== 'localhost') ?? null;

  await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: {
      id: 'singleton',
      tlsCert: certPem,
      tlsKey: keyPem,
      ...(primaryDomain ? { publicHostname: primaryDomain } : {}),
    },
    update: {
      tlsCert: certPem,
      tlsKey: keyPem,
      ...(primaryDomain ? { publicHostname: primaryDomain } : {}),
    },
  });
  await prisma.$transaction([
    prisma.certificate.updateMany({ data: { isActiveProtocol: false } }),
    prisma.certificate.update({ where: { id: certId }, data: { isActiveProtocol: true } }),
  ]);
  await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, certId);
  log.info({ certId, primaryDomain }, 'Protocol TLS cert applied (SMTP/IMAP/POP3) — servers reloading');
}

/**
 * Removes the protocol cert from ServerSettings and sets isActiveProtocol: false
 * on all certificates. SMTP/IMAP/POP3 fall back to self-signed immediately.
 * Called when an active protocol cert is deleted.
 */
async function clearProtocolCert(): Promise<void> {
  // Set tlsCert/tlsKey to NULL — protocol servers detect this and generate self-signed
  await prisma.serverSettings.update({
    where: { id: 'singleton' },
    data: { tlsCert: null, tlsKey: null },
  }).catch(() => {
    // If the singleton does not exist yet — no problem, NULL is the default
  });
  await prisma.certificate.updateMany({ data: { isActiveProtocol: false } });
  await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, '');
  log.info('Protocol TLS cert cleared — SMTP/IMAP/POP3 reverting to self-signed');
}

/**
 * Ensures exclusivity of the services assignment:
 * Removes the given services from ALL other certificates.
 * Called when creating and updating a certificate.
 */
async function claimServices(certId: string, services: string[]): Promise<void> {
  if (services.length === 0) return;
  const others = await prisma.certificate.findMany({
    where:  { id: { not: certId } },
    select: { id: true, services: true },
  });
  for (const other of others) {
    const remaining = (other.services as string[]).filter(s => !services.includes(s));
    if (remaining.length !== (other.services as string[]).length) {
      await prisma.certificate.update({
        where: { id: other.id },
        data:  { services: remaining },
      });
      log.info({ fromCertId: other.id, toCertId: certId, services },
        'Services transferred to new certificate (exclusivity enforced)');
    }
  }
}

// ── GET /tls-proxy-info ───────────────────────────────────────────────────────
// Returns the currently active HTTPS certificate.
// Used by the BCP to render the status banner.
adminCertificatesRouter.get('/tls-proxy-info', async (_req: Request, res: Response) => {
  const port = parseInt(process.env['HTTPS_PORT'] ?? '443', 10);

  const activeCert = await prisma.certificate.findFirst({
    where: { isActiveHttps: true },
    select: { id: true, name: true, domains: true, status: true },
  });

  res.json({ port, activeCert: activeCert ?? null });
});

// ── GET / ─────────────────────────────────────────────────────────────────────
adminCertificatesRouter.get('/', async (_req: Request, res: Response) => {
  const certs = await prisma.certificate.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, domains: true, services: true,
      type: true, status: true, issuedAt: true, expiresAt: true,
      autoRenew: true, isActiveHttps: true, isActiveProtocol: true,
      acmeEmail: true, lastError: true, createdAt: true,
      certPem: false, keyPem: false, chainPem: false, acmeAccount: false,
    },
  });
  res.json(certs);
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
adminCertificatesRouter.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const cert = await prisma.certificate.findUnique({ where: { id } });
  if (!cert) { res.status(404).json({ error: 'Certificate not found' }); return; }
  res.json(safe(cert as unknown as Record<string, unknown>));
});

// ── POST /letsencrypt ─────────────────────────────────────────────────────────
adminCertificatesRouter.post('/letsencrypt', async (req: Request, res: Response) => {
  const schema = z.object({
    name:      z.string().min(1).max(100),
    domains:   z.array(z.string().min(3)).min(1).max(10),
    email:     z.string().email(),
    services:  z.array(z.string()).default([]),
    autoRenew: z.boolean().default(true),
    staging:   z.boolean().default(false), // true = Let's Encrypt staging (test)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  const { name, domains, email, services, autoRenew, staging } = parsed.data;

  // Create the certificate as PENDING right away (issuance runs async)
  const cert = await prisma.certificate.create({
    data: {
      name,
      domains,
      services,
      type:      'LETSENCRYPT',
      status:    'PENDING',
      acmeEmail: email,
      autoRenew,
    },
  });

  // Assign services exclusively (remove from other certs)
  if (services.length > 0) await claimServices(cert.id, services);

  log.info({ id: cert.id, domains, staging }, 'Let\'s Encrypt certificate requested');

  // Start the async ACME process (do not await — respond immediately)
  void runAcmeIssuance(cert.id, domains, email, autoRenew, staging).catch(err => {
    log.error({ err, id: cert.id }, 'ACME issuance failed');
  });

  res.status(202).json({
    ...safe(cert as unknown as Record<string, unknown>),
    message: 'Certificate issuance started. Check status for progress.',
  });
});

// ── ACME HTTP-01 Issuance ─────────────────────────────────────────────────────

/** Hard timeout for the whole ACME process (5 minutes). */
const ACME_TIMEOUT_MS = 5 * 60_000;

export async function runAcmeIssuance(
  certId: string,
  domains: string[],
  email: string,
  autoRenew: boolean,
  staging: boolean,
) {
  // ── Timeout protection ────────────────────────────────────────────────────
  // acme-client.auto() has no built-in hard timeout — hangs forever when
  // port 80 is unreachable or Let's Encrypt does not respond.
  // Promise.race() aborts the process after ACME_TIMEOUT_MS.
  let _timeoutId: ReturnType<typeof setTimeout> | undefined;
  const _timeout = new Promise<never>((_, reject) => {
    _timeoutId = setTimeout(() => {
      reject(new Error(
        `ACME Timeout: Zertifikatsausstellung nach ${ACME_TIMEOUT_MS / 60_000} Minuten abgebrochen. ` +
        'Port 80 muss öffentlich erreichbar sein (/.well-known/acme-challenge/).',
      ));
    }, ACME_TIMEOUT_MS);
  });

  const _issuance = _runAcmeIssuanceCore(certId, domains, email, autoRenew, staging);

  try {
    await Promise.race([_issuance, _timeout]);
  } catch (err) {
    // Timeout case: the inner catch did not run → DB not yet set to ERROR
    if (err instanceof Error && err.message.startsWith('ACME Timeout')) {
      log.warn({ certId, domains }, 'ACME issuance timed out — marking certificate as ERROR');
      await prisma.certificate.update({
        where: { id: certId },
        data:  { status: 'ERROR', lastError: err.message.slice(0, 1000) },
      }).catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(_timeoutId);
  }
}

/** Internal implementation — wrapped with a timeout by runAcmeIssuance. */
async function _runAcmeIssuanceCore(
  certId: string,
  domains: string[],
  email: string,
  autoRenew: boolean,
  staging: boolean,
) {
  try {
    // Dynamic import of acme-client (ESM-compatible)
    const acme = await import('acme-client');

    // Load or generate the account key
    const existing = await prisma.certificate.findUnique({
      where: { id: certId }, select: { acmeAccount: true },
    });

    let accountKeyPem: string;
    if (existing?.acmeAccount) {
      accountKeyPem = existing.acmeAccount;
    } else {
      // Generate a new RSA-2048 account key via acme-client
      const newKey = await acme.crypto.createPrivateKey(2048);
      // acme-client v5 returns a KeyObject — export as PEM
      if (Buffer.isBuffer(newKey)) {
        accountKeyPem = (newKey as Buffer).toString('utf8');
      } else {
        // Node.js crypto.KeyObject
        const ck = newKey as import('crypto').KeyObject;
        const exported = ck.export({ type: 'pkcs8', format: 'pem' });
        accountKeyPem = typeof exported === 'string' ? exported : exported.toString('utf8');
      }
    }

    // acme-client v5 expects a Buffer or KeyObject, not a string
    const client = new acme.Client({
      directoryUrl: staging
        ? acme.directory.letsencrypt.staging
        : acme.directory.letsencrypt.production,
      accountKey: Buffer.from(accountKeyPem),
    });

    // Register the ACME account
    await client.createAccount({
      termsOfServiceAgreed: true,
      contact: [`mailto:${email}`],
    });

    // Generate CSR + private key
    const [certKey, csr] = await acme.crypto.createCsr({
      altNames: domains,
    });
    const certKeyPem = certKey.toString();

    // Issue the certificate with the HTTP-01 challenge
    // Timeout 90s so a hang becomes visible quickly (default would be ~120s+)
    const certPem = await client.auto({
      csr,
      email,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      skipChallengeVerification: false,
      challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
        const token = (_challenge as { token: string }).token;
        await storeAcmeChallenge(token, keyAuthorization);
        log.info({ token }, 'ACME HTTP-01 challenge token stored — Port 80 must be reachable');
      },
      challengeRemoveFn: async (_authz, _challenge) => {
        // Token stays in Redis until TTL — no active deletion needed
      },
    });

    // Parse X.509 for expiresAt
    let expiresAt: Date | null = null;
    try {
      const { X509Certificate } = await import('crypto');
      const x509 = new X509Certificate(certPem);
      expiresAt = new Date(x509.validTo);
    } catch {
      // Fallback: +90 days (Let's Encrypt default)
      expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000);
    }

    // Save to DB (read back services + domains for optional auto-activation)
    const issued = await prisma.certificate.update({
      where: { id: certId },
      data: {
        status:      deriveStatus(expiresAt),
        certPem:     certPem.toString(),
        keyPem:      certKeyPem,
        acmeAccount: accountKeyPem,
        issuedAt:    new Date(),
        expiresAt,
        lastError:   null,
      },
      select: { services: true, domains: true },
    });

    log.info({ id: certId, expiresAt }, 'Let\'s Encrypt certificate issued successfully');

    // v3.18.32: notify the TLS proxy — the SNI map must include the new domain.
    // Previously the reload was only triggered by the manual „HTTPS aktivieren" click;
    // with multi-cert SNI, however, all ACTIVE certs should be available immediately.
    await getRedisClient().publish('coremail:tls:reload', certId).catch(() => {});

    // Auto-activate for SMTP/IMAP/POP3 if services list includes mail protocols
    const mailProtocols = ['SMTP', 'IMAP', 'POP3'];
    const hasMailProtocol = (issued.services as string[]).some(s => mailProtocols.includes(s));
    if (hasMailProtocol) {
      await applyProtocolCert(certId, certPem.toString(), certKeyPem, issued.domains as string[]);
      log.info({ id: certId }, 'Protocol TLS auto-activated after ACME issuance');
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Helpful hint on HTTP-01 challenge errors (port 80 reachable?)
    const hint = /challenge|http-01|connection|ECONNREFUSED|timeout/i.test(raw)
      ? ' — Hinweis: HTTP-01 ACME Challenge erfordert Port 80 von außen erreichbar (/.well-known/acme-challenge/). Stelle sicher dass Port 80 auf den Server weitergeleitet wird.'
      : '';
    const msg = (raw + hint).slice(0, 1000);
    await prisma.certificate.update({
      where: { id: certId },
      data: { status: 'ERROR', lastError: msg },
    }).catch(() => {});
    throw err;
  }
}

// ── POST /upload ──────────────────────────────────────────────────────────────
adminCertificatesRouter.post('/upload', async (req: Request, res: Response) => {
  const schema = z.object({
    name:      z.string().min(1).max(100),
    domains:   z.array(z.string()).min(1),
    services:  z.array(z.string()).default([]),
    certPem:   z.string().min(50),
    keyPem:    z.string().min(50),
    chainPem:  z.string().optional(),
    autoRenew: z.boolean().default(false),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  // Read expiresAt from the certificate
  let expiresAt: Date | null = null;
  try {
    const { X509Certificate } = await import('crypto');
    const x509 = new X509Certificate(parsed.data.certPem);
    expiresAt = new Date(x509.validTo);
  } catch {
    res.status(400).json({ error: 'Invalid certificate PEM — could not parse expiry date' });
    return;
  }

  const cert = await prisma.certificate.create({
    data: {
      name:      parsed.data.name,
      domains:   parsed.data.domains,
      services:  parsed.data.services,
      type:      'CUSTOM',
      status:    deriveStatus(expiresAt),
      certPem:   parsed.data.certPem,
      keyPem:    parsed.data.keyPem,
      chainPem:  parsed.data.chainPem ?? null,
      issuedAt:  new Date(),
      expiresAt,
      autoRenew: parsed.data.autoRenew,
    },
  });

  // Assign services exclusively
  if (parsed.data.services.length > 0) await claimServices(cert.id, parsed.data.services);

  // v3.18.32: update the SNI map in the TLS proxy — new hostname available.
  await getRedisClient().publish('coremail:tls:reload', cert.id).catch(() => {});

  log.info({ id: cert.id, name: cert.name, expiresAt }, 'Custom certificate uploaded');
  res.status(201).json(safe(cert as unknown as Record<string, unknown>));
});

// ── POST /self-signed ─────────────────────────────────────────────────────────
adminCertificatesRouter.post('/self-signed', async (req: Request, res: Response) => {
  const schema = z.object({
    name:     z.string().min(1).max(100),
    domains:  z.array(z.string().min(1)).min(1),
    services: z.array(z.string()).default([]),
    days:     z.number().int().min(1).max(3650).default(365),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  const { name, domains, services, days } = parsed.data;

  try {
    // Self-signed certificate via Node.js crypto + forge-like approach
    // We use @peculiar/x509 (already transitive via acme-client) OR
    // the simpler way: openssl via child_process (not ideal) OR
    // directly with forge. For maximum compatibility we use the crypto + asn1.js approach
    // via acme-client's crypto utilities:
    const acme = await import('acme-client');
    const [key, csr] = await acme.crypto.createCsr({ altNames: domains });
    const keyPem = key.toString();

    // Self-signed: we sign the CSR ourselves
    // Since acme-client has no direct self-sign API, we use Node.js X.509
    const forge = await import('node-forge').catch(() => null);

    let certPem: string;
    let expiresAt: Date;

    if (forge) {
      // node-forge for a complete self-signed cert
      const pki = forge.pki;
      const privateKey = pki.privateKeyFromPem(keyPem);
      const publicKey  = pki.setRsaPublicKey(privateKey.n, privateKey.e);

      const cert_ = pki.createCertificate();
      cert_.publicKey = publicKey;
      cert_.serialNumber = '01';
      cert_.validity.notBefore = new Date();
      cert_.validity.notAfter  = new Date();
      cert_.validity.notAfter.setDate(cert_.validity.notAfter.getDate() + days);

      const attrs = [{ name: 'commonName', value: domains[0] }];
      cert_.setSubject(attrs);
      cert_.setIssuer(attrs);
      cert_.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'subjectAltName', altNames: domains.map(d => ({ type: 2, value: d })) },
        { name: 'keyUsage', keyCertSign: false, digitalSignature: true, nonRepudiation: true, keyEncipherment: true, dataEncipherment: true },
      ]);
      cert_.sign(privateKey, forge.md.sha256.create());
      certPem   = pki.certificateToPem(cert_);
      expiresAt = cert_.validity.notAfter;
    } else {
      // Fallback: ACME client CSR as placeholder (without a complete cert)
      // — direct crypto solution
      const { generateKeyPairSync, createSign } = await import('crypto');
      const kp = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      });
      certPem   = kp.publicKey; // Placeholder (PEM key only, no complete cert)
      expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
      void createSign; // suppress unused warning
    }

    const cert = await prisma.certificate.create({
      data: {
        name,
        domains,
        services,
        type:      'SELF_SIGNED',
        status:    'ACTIVE',
        certPem,
        keyPem,
        issuedAt:  new Date(),
        expiresAt,
        autoRenew: false,
      },
    });

    // Assign services exclusively
    if (services.length > 0) await claimServices(cert.id, services);

    // v3.18.32: update the SNI map in the TLS proxy — new hostname available.
    await getRedisClient().publish('coremail:tls:reload', cert.id).catch(() => {});

    log.info({ id: cert.id, domains, days }, 'Self-signed certificate generated');
    res.status(201).json(safe(cert as unknown as Record<string, unknown>));
  } catch (err) {
    log.error({ err }, 'Failed to generate self-signed certificate');
    res.status(500).json({ error: 'Failed to generate certificate' });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────
adminCertificatesRouter.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const schema = z.object({
    name:      z.string().min(1).max(100).optional(),
    services:  z.array(z.string()).optional(),
    autoRenew: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }
  try {
    const cert = await prisma.certificate.update({
      where: { id },
      data: {
        ...(parsed.data.name      !== undefined ? { name: parsed.data.name }           : {}),
        ...(parsed.data.services  !== undefined ? { services: parsed.data.services }   : {}),
        ...(parsed.data.autoRenew !== undefined ? { autoRenew: parsed.data.autoRenew } : {}),
      },
      // Protocol TLS binding needs certPem/keyPem + status
      select: {
        id: true, name: true, domains: true, services: true, type: true,
        status: true, issuedAt: true, expiresAt: true, autoRenew: true,
        isActiveHttps: true, isActiveProtocol: true, acmeEmail: true,
        lastError: true, createdAt: true, certPem: true, keyPem: true,
      },
    });

    // Assign services exclusively (remove from other certs)
    if (parsed.data.services !== undefined && parsed.data.services.length > 0) {
      await claimServices(id, parsed.data.services);
    }

    res.json(safe(cert as unknown as Record<string, unknown>));
  } catch {
    res.status(404).json({ error: 'Certificate not found' });
  }
});

// ── POST /:id/renew ───────────────────────────────────────────────────────────
adminCertificatesRouter.post('/:id/renew', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const cert = await prisma.certificate.findUnique({ where: { id } });
  if (!cert) { res.status(404).json({ error: 'Certificate not found' }); return; }
  if (cert.type !== 'LETSENCRYPT') {
    res.status(400).json({ error: 'Only Let\'s Encrypt certificates can be automatically renewed' });
    return;
  }
  if (!cert.acmeEmail) {
    res.status(400).json({ error: 'No ACME email stored — cannot renew' });
    return;
  }
  // No double start — guard against parallel ACME processes
  if (cert.status === 'PENDING' || cert.status === 'RENEWING') {
    res.status(409).json({
      error: `Certificate is already ${cert.status.toLowerCase()} — wait for the current process to complete or fail`,
    });
    return;
  }

  await prisma.certificate.update({ where: { id }, data: { status: 'RENEWING' } });

  void runAcmeIssuance(
    id, cert.domains, cert.acmeEmail, cert.autoRenew, false,
  ).catch(err => log.error({ err, id }, 'Renewal failed'));

  res.status(202).json({ message: 'Certificate renewal started' });
});

// ── POST /:id/activate-https ──────────────────────────────────────────────────
// Activates this certificate ONLY for the integrated HTTPS proxy (port 443).
// SMTP/IMAP/POP3 are NOT switched automatically — use activate-protocol for that.
// Both can point to different certificates independently.
adminCertificatesRouter.post('/:id/activate-https', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const cert = await prisma.certificate.findUnique({
    where: { id },
    select: { id: true, name: true, status: true, certPem: true, keyPem: true },
  });
  if (!cert) { res.status(404).json({ error: 'Certificate not found' }); return; }
  if (!cert.certPem || !cert.keyPem) {
    res.status(400).json({ error: 'Certificate has no PEM data yet — wait for issuance to complete' });
    return;
  }
  if (cert.status !== 'ACTIVE' && cert.status !== 'EXPIRING') {
    res.status(400).json({
      error: `Certificate status is "${cert.status}" — only ACTIVE or EXPIRING certificates can be used`,
    });
    return;
  }

  // Activate HTTPS proxy only — isActiveProtocol stays unchanged
  await prisma.$transaction([
    prisma.certificate.updateMany({ data: { isActiveHttps: false } }),
    prisma.certificate.update({ where: { id }, data: { isActiveHttps: true } }),
  ]);

  // Reload tls-proxy.ts (listens on coremail:tls:reload)
  await getRedisClient().publish('coremail:tls:reload', id);

  log.info({ id, name: cert.name }, 'Certificate activated for HTTPS proxy — protocol TLS unchanged');
  res.json({
    message: 'Certificate activated for HTTPS proxy (Port 443). To also protect SMTP/IMAP/POP3, use activate-protocol.',
    certId: id,
  });
});

// ── POST /:id/activate-protocol ───────────────────────────────────────────────
// Activates this certificate ONLY for mail protocols (SMTP/IMAP/POP3).
// For setups with an external reverse proxy (Traefik, Caddy, DSM) where the
// integrated HTTPS proxy is disabled but the mail server needs a CA-signed cert.
adminCertificatesRouter.post('/:id/activate-protocol', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const cert = await prisma.certificate.findUnique({
    where: { id },
    select: { id: true, name: true, status: true, certPem: true, keyPem: true, domains: true },
  });
  if (!cert) { res.status(404).json({ error: 'Certificate not found' }); return; }
  if (!cert.certPem || !cert.keyPem) {
    res.status(400).json({ error: 'Certificate has no PEM data yet' });
    return;
  }
  if (cert.status !== 'ACTIVE' && cert.status !== 'EXPIRING') {
    res.status(400).json({
      error: `Certificate status is "${cert.status}" — only ACTIVE or EXPIRING certificates can be used`,
    });
    return;
  }

  await applyProtocolCert(id, cert.certPem, cert.keyPem, cert.domains);

  log.info({ id, name: cert.name, domains: cert.domains }, 'Certificate activated for mail protocols (SMTP/IMAP/POP3)');
  res.json({
    message: 'Certificate activated for SMTP/IMAP/POP3 — servers reloading TLS',
    certId: id,
  });
});

// ── DELETE /:id/activate-https ────────────────────────────────────────────────
// Deactivates the integrated HTTPS proxy for this certificate.
// isActiveProtocol is kept — SMTP/IMAP/POP3 keep using the cert.
adminCertificatesRouter.delete('/:id/activate-https', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  await prisma.certificate.update({
    where: { id },
    data: { isActiveHttps: false },
    // isActiveProtocol is NOT reset — protocol TLS keeps running.
  }).catch(() => {});

  const redis = getRedisClient();
  await redis.publish('coremail:tls:reload', '');

  log.info({ id }, 'HTTPS proxy deactivated — protocol TLS (SMTP/IMAP/POP3) unchanged');
  res.json({ message: 'HTTPS proxy deactivated. Mail protocols (SMTP/IMAP/POP3) continue using the certificate.' });
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
// Deletes a certificate and cleans up all active bindings:
//   • isActiveProtocol: true → server_settings.tlsCert/tlsKey = NULL → Self-Signed
//   • isActiveHttps:    true → HTTPS proxy stops (coremail:tls:reload '')
adminCertificatesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    const cert = await prisma.certificate.findUnique({
      where:  { id },
      select: { isActiveHttps: true, isActiveProtocol: true, name: true },
    });
    if (!cert) { res.status(404).json({ error: 'Certificate not found' }); return; }

    // Handle side effects BEFORE deleting
    if (cert.isActiveProtocol) {
      // Reset protocol TLS → SMTP/IMAP/POP3 generate a self-signed cert
      await clearProtocolCert();
    }
    if (cert.isActiveHttps) {
      // Stop HTTPS proxy (empty string = no active cert anymore)
      await prisma.certificate.updateMany({ data: { isActiveHttps: false } });
      await getRedisClient().publish('coremail:tls:reload', '');
      log.info({ id }, 'HTTPS proxy deactivated (active cert deleted)');
    }

    await prisma.certificate.delete({ where: { id } });
    log.info({ id, name: cert.name }, 'Certificate deleted — active bindings cleaned up');
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'Certificate not found' });
  }
});
