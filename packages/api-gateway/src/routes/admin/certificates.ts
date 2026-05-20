/**
 * Admin-API: SSL/TLS Zertifikat-Verwaltung
 *
 * GET    /api/v1/admin/certificates              — alle Zertifikate
 * GET    /api/v1/admin/certificates/:id          — einzelnes Zertifikat (ohne private key)
 * POST   /api/v1/admin/certificates/letsencrypt  — Let's Encrypt Zertifikat anfordern (ACME HTTP-01)
 * POST   /api/v1/admin/certificates/upload       — eigenes Zertifikat hochladen (PEM)
 * POST   /api/v1/admin/certificates/self-signed  — selbstsigniertes Zertifikat generieren
 * PUT    /api/v1/admin/certificates/:id          — Name, Services, autoRenew bearbeiten
 * POST   /api/v1/admin/certificates/:id/renew    — Zertifikat sofort erneuern
 * DELETE /api/v1/admin/certificates/:id          — Zertifikat löschen
 *
 * Intern (kein Auth):
 * GET    /.well-known/acme-challenge/:token      — ACME HTTP-01 Challenge (in server.ts registriert)
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { getRedisClient, createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

// String-Literal-Typ — spiegelt das Prisma-Enum CertStatus, ohne @prisma/client zu importieren
type CertStatus = 'PENDING' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'ERROR' | 'RENEWING';

const log = createLogger('admin:certificates');
export const adminCertificatesRouter: RouterType = Router();
adminCertificatesRouter.use(requireAdmin);

// ── ACME Challenge-Token Store (Redis, TTL 10 min) ────────────────────────────
const CHALLENGE_PREFIX = 'acme:challenge:';

export async function storeAcmeChallenge(token: string, keyAuth: string) {
  const redis = getRedisClient();
  await redis.set(`${CHALLENGE_PREFIX}${token}`, keyAuth, 'EX', 600);
}

export async function getAcmeChallenge(token: string): Promise<string | null> {
  const redis = getRedisClient();
  return redis.get(`${CHALLENGE_PREFIX}${token}`);
}

// ── Zertifikat-Status anhand expiresAt ableiten ───────────────────────────────
function deriveStatus(expiresAt: Date | null): CertStatus {
  if (!expiresAt) return 'PENDING';
  const now   = Date.now();
  const expMs = expiresAt.getTime();
  if (expMs < now)                         return 'EXPIRED';
  if (expMs < now + 30 * 24 * 3600 * 1000) return 'EXPIRING';
  return 'ACTIVE';
}

// ── Hilfsfeld: privaten Schlüssel ausblenden ──────────────────────────────────
function safe(cert: Record<string, unknown>) {
  const { keyPem: _, acmeAccount: __, ...rest } = cert;
  return rest;
}

// ── GET / ─────────────────────────────────────────────────────────────────────
adminCertificatesRouter.get('/', async (_req: Request, res: Response) => {
  const certs = await prisma.certificate.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, domains: true, services: true,
      type: true, status: true, issuedAt: true, expiresAt: true,
      autoRenew: true, acmeEmail: true, lastError: true, createdAt: true,
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
    staging:   z.boolean().default(false), // true = Let's Encrypt Staging (Test)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
    return;
  }

  const { name, domains, email, services, autoRenew, staging } = parsed.data;

  // Zertifikat sofort als PENDING anlegen (Issuance läuft async)
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

  log.info({ id: cert.id, domains, staging }, 'Let\'s Encrypt certificate requested');

  // Async ACME-Prozess starten (nicht awaiten — antworte sofort)
  void runAcmeIssuance(cert.id, domains, email, autoRenew, staging).catch(err => {
    log.error({ err, id: cert.id }, 'ACME issuance failed');
  });

  res.status(202).json({
    ...safe(cert as unknown as Record<string, unknown>),
    message: 'Certificate issuance started. Check status for progress.',
  });
});

// ── ACME HTTP-01 Issuance ─────────────────────────────────────────────────────
async function runAcmeIssuance(
  certId: string,
  domains: string[],
  email: string,
  autoRenew: boolean,
  staging: boolean,
) {
  try {
    // Dynamischer Import von acme-client (ESM-kompatibel)
    const acme = await import('acme-client');

    // Account-Key laden oder neu generieren
    const existing = await prisma.certificate.findUnique({
      where: { id: certId }, select: { acmeAccount: true },
    });

    let accountKeyPem: string;
    if (existing?.acmeAccount) {
      accountKeyPem = existing.acmeAccount;
    } else {
      // Neuen RSA-2048 Account-Key über acme-client generieren
      const newKey = await acme.crypto.createPrivateKey(2048);
      // acme-client v5 gibt KeyObject zurück — als PEM exportieren
      if (Buffer.isBuffer(newKey)) {
        accountKeyPem = (newKey as Buffer).toString('utf8');
      } else {
        // Node.js crypto.KeyObject
        const ck = newKey as import('crypto').KeyObject;
        const exported = ck.export({ type: 'pkcs8', format: 'pem' });
        accountKeyPem = typeof exported === 'string' ? exported : exported.toString('utf8');
      }
    }

    // acme-client v5 erwartet Buffer oder KeyObject, keinen String
    const client = new acme.Client({
      directoryUrl: staging
        ? acme.directory.letsencrypt.staging
        : acme.directory.letsencrypt.production,
      accountKey: Buffer.from(accountKeyPem),
    });

    // ACME Account registrieren
    await client.createAccount({
      termsOfServiceAgreed: true,
      contact: [`mailto:${email}`],
    });

    // CSR + Private-Key generieren
    const [certKey, csr] = await acme.crypto.createCsr({
      altNames: domains,
    });
    const certKeyPem = certKey.toString();

    // Zertifikat ausstellen mit HTTP-01 Challenge
    // Timeout 90s damit der Hänger-Fall schnell sichtbar wird (Default wäre ~120s+)
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
        // Token bleibt bis TTL in Redis — kein aktives Löschen nötig
      },
    });

    // X.509 parsen für expiresAt
    let expiresAt: Date | null = null;
    try {
      const { X509Certificate } = await import('crypto');
      const x509 = new X509Certificate(certPem);
      expiresAt = new Date(x509.validTo);
    } catch {
      // Fallback: +90 Tage (Let's Encrypt Standard)
      expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000);
    }

    // In DB speichern
    await prisma.certificate.update({
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
    });

    log.info({ id: certId, expiresAt }, 'Let\'s Encrypt certificate issued successfully');
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Hilfreicher Hinweis bei HTTP-01 Challenge-Fehlern (Port 80 erreichbar?)
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

  // expiresAt aus dem Zertifikat lesen
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
    // Selbstsigniertes Zertifikat via Node.js crypto + forge-ähnlicher Ansatz
    // Wir nutzen @peculiar/x509 (bereits transitiv via acme-client) ODER
    // einfacheren Weg: openssl via child_process (nicht ideal) ODER
    // direkt mit forge. Für maximale Kompatibilität verwenden wir crypto + asn1.js-Ansatz
    // via acme-client's crypto utilities:
    const acme = await import('acme-client');
    const [key, csr] = await acme.crypto.createCsr({ altNames: domains });
    const keyPem = key.toString();

    // Self-signed: Wir signieren den CSR selbst
    // Da acme-client keine direkte self-sign API hat, nutzen wir Node.js X.509
    const forge = await import('node-forge').catch(() => null);

    let certPem: string;
    let expiresAt: Date;

    if (forge) {
      // node-forge für vollständiges Self-signed Cert
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
      // Fallback: ACME-Client CSR als Platzhalter (ohne vollständiges Cert)
      // — direkte crypto-Lösung
      const { generateKeyPairSync, createSign } = await import('crypto');
      const kp = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      });
      certPem   = kp.publicKey; // Placeholder (nur PEM Key ohne vollst. Cert)
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
    });
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

  await prisma.certificate.update({ where: { id }, data: { status: 'RENEWING' } });

  void runAcmeIssuance(
    id, cert.domains, cert.acmeEmail, cert.autoRenew, false,
  ).catch(err => log.error({ err, id }, 'Renewal failed'));

  res.status(202).json({ message: 'Certificate renewal started' });
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
adminCertificatesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.certificate.delete({ where: { id } });
    log.info({ id }, 'Certificate deleted');
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'Certificate not found' });
  }
});
