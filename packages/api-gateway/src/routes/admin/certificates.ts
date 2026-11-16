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
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireArea } from '../../middleware/auth.js';

import { deriveCertStatus, isPemCurrentlyValid, parseCertValidity, recomputeStatus } from '../../lib/cert-lifecycle.js';
import {
  applyProtocolCert, clearProtocolCert, publishTlsReload, runAcmeIssuance,
  storeAcmeChallenge, getAcmeChallenge,
} from '../../lib/cert-acme.js';
import { startRenewal } from '../../lib/cert-renewal.js';

// Re-exported for server.ts (ACME HTTP-01 challenge endpoint) and older imports.
export { storeAcmeChallenge, getAcmeChallenge, runAcmeIssuance };

const log = createLogger('admin:certificates');
export const adminCertificatesRouter: RouterType = Router();
adminCertificatesRouter.use(requireArea('servers'));

// Mail protocols only (HTTPS is the lock icon, not a service); unknown strings used
// to be stored and shown as badges.
const ServicesSchema = z.array(z.enum(['SMTP', 'IMAP', 'POP3'])).transform((s) => [...new Set(s)]);
const DomainsSchema = z.array(
  // host names (single labels such as "localhost" allowed for self-signed), optional "*." wildcard
  z.string().trim().toLowerCase()
    .regex(/^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/, 'Invalid domain name'),
).min(1).max(100);

/**
 * null when the private key belongs to the certificate, otherwise a readable error.
 * A mismatched upload used to be accepted and broke TLS once activated.
 */
export function pemKeyMismatch(certPem: string, keyPem: string): string | null {
  try {
    const x509 = new X509Certificate(certPem);
    return x509.checkPrivateKey(createPrivateKey(keyPem)) ? null : 'The private key does not belong to this certificate';
  } catch {
    return 'Invalid certificate or private key PEM';
  }
}

// ── Helper: hide private key ──────────────────────────────────────────────────
function safe(cert: Record<string, unknown>) {
  const { keyPem: _, acmeAccount: __, ...rest } = cert;
  return rest;
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
  // Live status between scheduler runs: ACTIVE/EXPIRING/EXPIRED follow expiresAt.
  const now = new Date();
  res.json(certs.map(c => ({ ...c, status: recomputeStatus(c.status, c.expiresAt, now) })));
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
    domains:   DomainsSchema.max(10).refine((d) => d.every((x) => !x.startsWith('*.')), 'Wildcards need DNS-01 — HTTP-01 cannot issue them'),
    email:     z.string().email(),
    services:  ServicesSchema.default([]),
    autoRenew: z.boolean().default(true),
    staging:   z.boolean().default(false), // true = Let's Encrypt staging (test)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', details: parsed.error.issues });
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

// ── POST /upload ──────────────────────────────────────────────────────────────
adminCertificatesRouter.post('/upload', async (req: Request, res: Response) => {
  const schema = z.object({
    name:      z.string().min(1).max(100),
    domains:   DomainsSchema,
    services:  ServicesSchema.default([]),
    certPem:   z.string().min(50),
    keyPem:    z.string().min(50),
    chainPem:  z.string().optional(),
    autoRenew: z.boolean().default(false),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', details: parsed.error.issues });
    return;
  }

  // Read expiresAt from the certificate
  const validity = parseCertValidity(parsed.data.certPem);
  if (!validity) {
    res.status(400).json({ error: 'Invalid certificate PEM — could not parse expiry date' });
    return;
  }
  const expiresAt = validity.validTo;
  const mismatch = pemKeyMismatch(parsed.data.certPem, parsed.data.keyPem);
  if (mismatch) { res.status(400).json({ error: mismatch }); return; }

  const cert = await prisma.certificate.create({
    data: {
      name:      parsed.data.name,
      domains:   parsed.data.domains,
      services:  parsed.data.services,
      type:      'CUSTOM',
      status:    deriveCertStatus(expiresAt),
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
  await publishTlsReload(cert.id);

  log.info({ id: cert.id, name: cert.name, expiresAt }, 'Custom certificate uploaded');
  res.status(201).json(safe(cert as unknown as Record<string, unknown>));
});

// ── POST /self-signed ─────────────────────────────────────────────────────────
adminCertificatesRouter.post('/self-signed', async (req: Request, res: Response) => {
  const schema = z.object({
    name:     z.string().min(1).max(100),
    domains:  DomainsSchema,
    services: ServicesSchema.default([]),
    days:     z.number().int().min(1).max(3650).default(365),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', details: parsed.error.issues });
    return;
  }

  const { name, domains, services, days } = parsed.data;

  try {
    // RSA key from acme-client, certificate signed with node-forge (a direct
    // dependency). The old "fallback" stored a bare public key as certPem.
    const acme = await import('acme-client');
    const forge = (await import('node-forge')).default;
    const keyPem = (await acme.crypto.createPrivateKey()).toString();

    const pki = forge.pki;
    const privateKey = pki.privateKeyFromPem(keyPem);
    const publicKey  = pki.setRsaPublicKey(privateKey.n, privateKey.e);

    const cert_ = pki.createCertificate();
    cert_.publicKey = publicKey;
    // Unique positive serial: browsers reject two certificates with the same
    // issuer + serial (every self-signed cert used to get serial 01).
    cert_.serialNumber = '00' + randomBytes(16).toString('hex');
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
      { name: 'extKeyUsage', serverAuth: true },
    ]);
    cert_.sign(privateKey, forge.md.sha256.create());
    const certPem   = pki.certificateToPem(cert_);
    const expiresAt = cert_.validity.notAfter;

    const cert = await prisma.certificate.create({
      data: {
        name,
        domains,
        services,
        type:      'SELF_SIGNED',
        status:    deriveCertStatus(expiresAt),
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
    await publishTlsReload(cert.id);

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
    services:  ServicesSchema.optional(),
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
  // Shared code path with the renewal scheduler: per-cert Redis lock (held
  // until the ACME work really ends) + conditional RENEWING transition —
  // never two concurrent renewals for one certificate.
  let started: Awaited<ReturnType<typeof startRenewal>>;
  try {
    started = await startRenewal(id, 'manual');
  } catch (err) {
    log.error({ err, id }, 'Failed to start certificate renewal');
    res.status(500).json({ error: 'Failed to start renewal' });
    return;
  }
  if (!started.started) {
    if (started.reason === 'not-found') { res.status(404).json({ error: 'Certificate not found' }); return; }
    res.status(409).json({
      error: started.reason === 'in-progress'
        ? `Certificate is already ${(started.status ?? 'renewing').toLowerCase()} — wait for the current process to complete or fail`
        : 'A renewal for this certificate is already running',
    });
    return;
  }

  // v6: respond with the certificate (status RENEWING) like the other
  // endpoints; `message` is kept for older clients.
  const updated = await prisma.certificate.findUnique({ where: { id } });
  res.status(202).json({
    ...(updated ? safe(updated as unknown as Record<string, unknown>) : { id, status: 'RENEWING' }),
    message: 'Certificate renewal started',
  });
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
  // v6: usability is decided by the PEM validity, not by the DB status — an
  // EXPIRING / ERROR (failed renewal) cert with a still-valid PEM can be used.
  if (!isPemCurrentlyValid(cert.certPem)) {
    res.status(400).json({
      error: `Certificate is not currently valid (status "${cert.status}") — expired or not yet valid`,
    });
    return;
  }

  // Activate HTTPS proxy only — isActiveProtocol stays unchanged
  await prisma.$transaction([
    prisma.certificate.updateMany({ data: { isActiveHttps: false } }),
    prisma.certificate.update({ where: { id }, data: { isActiveHttps: true } }),
  ]);

  // Reload tls-proxy.ts (listens on coremail:tls:reload)
  await publishTlsReload(id);

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
  // v6: usability is decided by the PEM validity, not by the DB status — an
  // EXPIRING / ERROR (failed renewal) cert with a still-valid PEM can be used.
  if (!isPemCurrentlyValid(cert.certPem)) {
    res.status(400).json({
      error: `Certificate is not currently valid (status "${cert.status}") — expired or not yet valid`,
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
  // isActiveProtocol is NOT reset — protocol TLS keeps running.
  const r = await prisma.certificate.updateMany({ where: { id }, data: { isActiveHttps: false } });
  if (r.count === 0) { res.status(404).json({ error: 'Certificate not found' }); return; }

  await publishTlsReload('');

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
      await prisma.certificate.updateMany({ data: { isActiveHttps: false } });
      log.info({ id }, 'HTTPS default certificate deleted — proxy falls back to the newest valid cert');
    }

    await prisma.certificate.delete({ where: { id } });
    // v6: ALWAYS rebuild the HTTPS proxy SNI map after the row is gone — every
    // cert with a valid PEM is served, so deleting a non-default cert must drop
    // it as well (previously only the default cert triggered a reload, and the
    // reload ran before the delete).
    await publishTlsReload('');
    log.info({ id, name: cert.name }, 'Certificate deleted — active bindings cleaned up');
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'Certificate not found' });
  }
});
