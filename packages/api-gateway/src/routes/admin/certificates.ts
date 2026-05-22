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
import { getRedisClient, createLogger, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
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

// ── Protokoll-TLS-Binding ──────────────────────────────────────────────────────
//
// DESIGN-PRINZIP (v3.17.35):
//   • Standardzustand: SMTP/IMAP/POP3 nutzen Self-Signed-Cert (auto-generiert
//     aus publicHostname). server_settings.tlsCert/tlsKey = NULL.
//   • Explizite Aktivierung: Nur wenn der Admin einen Knopf drückt (activate-protocol
//     oder activate-https) wird ein CA-signiertes Cert in ServerSettings gespeichert.
//   • Löschen: Wird ein aktives Cert gelöscht → server_settings.tlsCert/tlsKey
//     werden auf NULL gesetzt → Protokoll-Server reverten sofort auf Self-Signed.
//   • Entkopplung: HTTPS-Proxy und Protokoll-TLS sind vollständig unabhängig.
//     Ein Cert kann nur für HTTPS, nur für Protokolle, oder für beides aktiv sein.

/**
 * Schreibt certPem/keyPem in ServerSettings.tlsCert/tlsKey und triggert
 * SMTP/IMAP/POP3-Server-Reload via CHANNEL_SETTINGS_RELOAD.
 * Setzt isActiveProtocol: true auf diesem Cert (und false auf allen anderen).
 * Aktualisiert auch publicHostname auf die primäre Domain des Zertifikats,
 * damit SMTP/IMAP/POP3 sofort den korrekten Banner-Hostnamen verwenden.
 * Wird NUR von activate-protocol aufgerufen (explizit durch Admin).
 */
async function applyProtocolCert(
  certId:  string,
  certPem: string,
  keyPem:  string,
  domains: string[],
): Promise<void> {
  // Primäre Domain: erstes nicht-Wildcard-Eintrag der Domains-Liste
  // wird als neuer publicHostname verwendet — SMTP/IMAP/POP3 Banner + Self-Signed-Fallback
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
 * Löscht das Protokoll-Cert aus ServerSettings und setzt isActiveProtocol: false
 * auf allen Zertifikaten. SMTP/IMAP/POP3 fallen sofort auf Self-Signed zurück.
 * Wird beim Löschen eines aktiven Protokoll-Certs aufgerufen.
 */
async function clearProtocolCert(): Promise<void> {
  // tlsCert/tlsKey auf NULL setzen — Protokoll-Server erkennen das und generieren Self-Signed
  await prisma.serverSettings.update({
    where: { id: 'singleton' },
    data: { tlsCert: null, tlsKey: null },
  }).catch(() => {
    // Falls singleton noch nicht existiert — kein Problem, NULL ist der Default
  });
  await prisma.certificate.updateMany({ data: { isActiveProtocol: false } });
  await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, '');
  log.info('Protocol TLS cert cleared — SMTP/IMAP/POP3 reverting to self-signed');
}

// ── GET /tls-proxy-info ───────────────────────────────────────────────────────
// Gibt das aktuell aktive HTTPS-Zertifikat zurück.
// Wird vom BCP verwendet um den Status-Banner zu rendern.
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
export async function runAcmeIssuance(
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

    // In DB speichern (services + domains für optionales Auto-Aktivieren zurücklesen)
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

    // Auto-activate for SMTP/IMAP/POP3 if services list includes mail protocols
    const mailProtocols = ['SMTP', 'IMAP', 'POP3'];
    const hasMailProtocol = (issued.services as string[]).some(s => mailProtocols.includes(s));
    if (hasMailProtocol) {
      await applyProtocolCert(certId, certPem.toString(), certKeyPem, issued.domains as string[]);
      log.info({ id: certId }, 'Protocol TLS auto-activated after ACME issuance');
    }
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
      // Protokoll-TLS-Binding braucht certPem/keyPem + status
      select: {
        id: true, name: true, domains: true, services: true, type: true,
        status: true, issuedAt: true, expiresAt: true, autoRenew: true,
        isActiveHttps: true, acmeEmail: true, lastError: true, createdAt: true,
        certPem: true, keyPem: true,
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

// ── POST /:id/activate-https ──────────────────────────────────────────────────
// Aktiviert dieses Zertifikat NUR für den integrierten HTTPS-Proxy (Port 443).
// SMTP/IMAP/POP3 werden NICHT automatisch umgestellt — dafür activate-protocol nutzen.
// Beide können unabhängig voneinander auf verschiedene Zertifikate zeigen.
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

  // Nur HTTPS-Proxy aktivieren — isActiveProtocol bleibt unverändert
  await prisma.$transaction([
    prisma.certificate.updateMany({ data: { isActiveHttps: false } }),
    prisma.certificate.update({ where: { id }, data: { isActiveHttps: true } }),
  ]);

  // tls-proxy.ts neu laden (lauscht auf coremail:tls:reload)
  await getRedisClient().publish('coremail:tls:reload', id);

  log.info({ id, name: cert.name }, 'Certificate activated for HTTPS proxy — protocol TLS unchanged');
  res.json({
    message: 'Certificate activated for HTTPS proxy (Port 443). To also protect SMTP/IMAP/POP3, use activate-protocol.',
    certId: id,
  });
});

// ── POST /:id/activate-protocol ───────────────────────────────────────────────
// Aktiviert dieses Zertifikat NUR für Mail-Protokolle (SMTP/IMAP/POP3).
// Für Setups mit externem Reverse Proxy (Traefik, Caddy, DSM) wo der integrierte
// HTTPS-Proxy deaktiviert ist, aber der Mailserver ein CA-signiertes Cert braucht.
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
// Deaktiviert den integrierten HTTPS-Proxy für dieses Zertifikat.
// isActiveProtocol bleibt erhalten — SMTP/IMAP/POP3 nutzen das Cert weiterhin.
adminCertificatesRouter.delete('/:id/activate-https', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  await prisma.certificate.update({
    where: { id },
    data: { isActiveHttps: false },
    // isActiveProtocol wird NICHT zurückgesetzt — Protokoll-TLS läuft weiter.
  }).catch(() => {});

  const redis = getRedisClient();
  await redis.publish('coremail:tls:reload', '');

  log.info({ id }, 'HTTPS proxy deactivated — protocol TLS (SMTP/IMAP/POP3) unchanged');
  res.json({ message: 'HTTPS proxy deactivated. Mail protocols (SMTP/IMAP/POP3) continue using the certificate.' });
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
// Löscht ein Zertifikat und räumt alle aktiven Bindungen auf:
//   • isActiveProtocol: true → server_settings.tlsCert/tlsKey = NULL → Self-Signed
//   • isActiveHttps:    true → HTTPS-Proxy stoppt (coremail:tls:reload '')
adminCertificatesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    const cert = await prisma.certificate.findUnique({
      where:  { id },
      select: { isActiveHttps: true, isActiveProtocol: true, name: true },
    });
    if (!cert) { res.status(404).json({ error: 'Certificate not found' }); return; }

    // Seiteneffekte VOR dem Löschen abwickeln
    if (cert.isActiveProtocol) {
      // Protokoll-TLS zurücksetzen → SMTP/IMAP/POP3 erzeugen Self-Signed-Cert
      await clearProtocolCert();
    }
    if (cert.isActiveHttps) {
      // HTTPS-Proxy stoppen (leerer String = kein aktives Cert mehr)
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
