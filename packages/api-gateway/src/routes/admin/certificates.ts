/**
 * Admin API: SSL/TLS certificate management
 *
 * GET    /api/v1/admin/certificates              — all certificates
 * GET    /api/v1/admin/certificates/:id          — single certificate (without private key)
 * POST   /api/v1/admin/certificates/letsencrypt  — request Let's Encrypt certificate (ACME HTTP-01)
 * POST   /api/v1/admin/certificates/upload       — upload own certificate (PEM)
 * POST   /api/v1/admin/certificates/self-signed  — generate self-signed certificate
 * PUT    /api/v1/admin/certificates/:id          — edit name, services (SMTP/IMAP/POP3 = applied immediately), autoRenew
 * GET    /api/v1/admin/certificates/served       — certificate each mail port really serves (9.3)
 * GET    /api/v1/admin/certificates/acme-suggestions — defaults for an order for the public host name (9.3)
 * POST   /api/v1/admin/certificates/:id/renew    — renew certificate immediately
 * DELETE /api/v1/admin/certificates/:id          — delete certificate
 *
 * Internal (no auth):
 * GET    /.well-known/acme-challenge/:token      — ACME HTTP-01 challenge (registered in server.ts)
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { z } from 'zod';
import { prisma, encryptPrivateKey, unreadableInUseCertKeys } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireArea } from '../../middleware/auth.js';

import {
  deriveCertStatus, isDefaultHostname, isPemCurrentlyValid, parseCertValidity,
  recomputeStatus, uncoveredDomains,
} from '../../lib/cert-lifecycle.js';
import {
  publishTlsReload, runAcmeIssuance,
  storeAcmeChallenge, getAcmeChallenge, getChallengeServing, runAcmeValidationTest,
} from '../../lib/cert-acme.js';
import { lockedUntilText, startRenewal } from '../../lib/cert-renewal.js';
import { lookupAddresses, runPreflight, suggestAdditionalSans } from '../../lib/acme-preflight.js';
import {
  assignProtocolCert, claimServices, createSelfSignedPem, fallbackToSelfSigned, hasMailService, holdsTrustedPem,
  isStagingCert, MAIL_SERVICES, protocolBlocker, withMailServices, type AssignResult, type ProtocolActor,
} from '../../lib/protocol-cert-assign.js';
import { DEFAULT_PROBE_TARGETS, probeServedCert, servedCertProblem, type ProbeTarget } from '../../lib/served-cert.js';
import { auditContext } from '../../lib/audit.js';

// Re-exported for server.ts (ACME HTTP-01 challenge endpoint) and older imports.
export { storeAcmeChallenge, getAcmeChallenge, runAcmeIssuance };
// Moved to lib/protocol-cert-assign.ts in 9.3; re-exported for older imports / tests.
export { claimServices, holdsTrustedPem };

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
 * Let's Encrypt (HTTP validation): at most 10 public DNS names — no wildcard,
 * no single-label name (localhost, intranet hosts), no IPv4 literal. 9.2.x:
 * refused here instead of failing at the CA (and the pre-flight never fetches
 * internal hosts).
 */
const AcmeDomainsSchema = DomainsSchema.max(10)
  .refine((d) => d.every((x) => !x.startsWith('*.')), 'Wildcards need DNS-01 — HTTP-01 cannot issue them')
  .refine((d) => d.every((x) => x.includes('.') && !/^\d+(\.\d+){3}$/.test(x)),
    'Let\'s Encrypt needs public domain names (no single-label names or IP addresses)');

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

// ── Protocol TLS assignment helpers (9.3) ─────────────────────────────────────
// Assigning SMTP/IMAP/POP3 IS the switch: the certificate is applied to the mail
// servers right away (lib/protocol-cert-assign.ts).

function actorOf(req: Request): ProtocolActor {
  return {
    ...(req.apiUser ? { actorId: req.apiUser.userId, actorEmail: req.apiUser.email } : {}),
    ...auditContext(req),
  };
}

const STAGING_NO_MAIL = {
  error:   'Let\'s Encrypt staging certificates are untrusted and cannot be used for SMTP/IMAP/POP3',
  code:    'STAGING_NO_MAIL_SERVICES',
  message: 'Staging-Zertifikate (Test) sind nicht vertrauenswürdig und können nicht für SMTP/IMAP/POP3 verwendet werden. Bitte ein produktives Let\'s Encrypt-Zertifikat verwenden.',
} as const;

const PROTOCOL_CERT_REQUIRED = {
  error:   'SMTP/IMAP/POP3 always need a certificate — assign the services to another certificate instead',
  code:    'PROTOCOL_CERT_REQUIRED',
  message: 'SMTP/IMAP/POP3 brauchen immer ein Zertifikat. Weise die Dienste einem anderen Zertifikat zu — das selbstsignierte wird dabei automatisch abgelöst.',
} as const;

/** Response fields describing what happened to SMTP/IMAP/POP3. */
function protocolOutcome(r: AssignResult | null): Record<string, unknown> {
  if (!r) return {};
  return r.applied
    ? { protocolApplied: true, isActiveProtocol: true }
    : { protocolApplied: false, protocolPending: r.blocker };
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

// ── GET /served ───────────────────────────────────────────────────────────────
// 9.3: the certificate every mail listener ACTUALLY serves (local connection,
// SNI = public host name, STARTTLS/STLS on the plain ports), matched against the
// certificates table, plus a suggestion which certificate to assign when a port
// serves a self-signed / name-mismatched / expired certificate.
// w1: `unreadableKeys` (additive) lists the certificates in use whose stored
// private key cannot be read — the mail servers then serve the self-signed
// replacement (and HTTPS skips the certificate) until it is re-issued or uploaded.
const MAX_PROBE_TARGETS = 16;
async function servedProbeTargets(): Promise<ProbeTarget[]> {
  const rows = await prisma.serviceListener.findMany({
    where:  { active: true, service: { in: ['SMTP_RECEIVE', 'IMAP', 'POP3'] } },
    select: { service: true, address: true, port: true, ssl: true },
  }).catch(() => []);
  if (!rows || rows.length === 0) return DEFAULT_PROBE_TARGETS;
  // probeServedCert only connects to wildcard/loopback/own interface addresses
  // (lib/served-cert.ts localProbeHost) — never to a foreign host of a stored row.
  return rows
    .filter((r) => Number.isInteger(r.port) && r.port > 0 && r.port < 65536)
    .map((r) => ({
      protocol: (r.service === 'SMTP_RECEIVE' ? 'smtp' : r.service === 'IMAP' ? 'imap' : 'pop3') as ProbeTarget['protocol'],
      port: r.port, implicitTls: r.ssl, host: r.address || '0.0.0.0',
    }))
    .sort((a, b) => Number(b.implicitTls) - Number(a.implicitTls) || a.port - b.port)
    .slice(0, MAX_PROBE_TARGETS);
}

adminCertificatesRouter.get('/served', async (_req: Request, res: Response) => {
  const settings = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { publicHostname: true },
  }).catch(() => null);
  const hostname = (settings?.publicHostname ?? '').trim().toLowerCase() || 'localhost';
  const targets = await servedProbeTargets();
  const timeoutMs = Math.min(Math.max(parseInt(process.env['SERVED_CERT_PROBE_TIMEOUT_MS'] ?? '4000', 10) || 4000, 500), 15_000);
  const results = await Promise.all(targets.map((t) => probeServedCert(t, hostname, { timeoutMs })));

  const certs = await prisma.certificate.findMany({
    select: {
      id: true, name: true, type: true, status: true, acmeStaging: true, certPem: true, keyPem: true,
      isActiveProtocol: true, expiresAt: true,
    },
  });
  const byFingerprint = new Map<string, { id: string; name: string }>();
  for (const c of certs) {
    if (!c.certPem) continue;
    try { byFingerprint.set(new X509Certificate(c.certPem).fingerprint256, { id: c.id, name: c.name }); } catch { /* unparsable */ }
  }
  const ports = results.map((r) => {
    const match = r.cert ? byFingerprint.get(r.cert.fingerprint256) : undefined;
    return { ...r, problem: servedCertProblem(r), certId: match?.id ?? null, certName: match?.name ?? null };
  });
  const problem = ports.some((p) => p.problem !== null);
  // The mail servers / HTTPS proxy log the unreadable key; this only reports it.
  const unreadableKeys = await unreadableInUseCertKeys();

  // Suggestion for "Jetzt zuweisen": a usable, trusted (not self-signed, not
  // staging) certificate that covers the public host name — latest expiry first.
  const suggestion = certs
    .filter((c) => c.type !== 'SELF_SIGNED' && !isStagingCert(c) && c.certPem && c.keyPem && c.status !== 'PENDING'
      && parseCertValidity(c.certPem) !== null && (parseCertValidity(c.certPem)!.validTo.getTime() > Date.now())
      && uncoveredDomains(c.certPem, [hostname]).length === 0)
    .sort((a, b) => (parseCertValidity(b.certPem)!.validTo.getTime() - parseCertValidity(a.certPem)!.validTo.getTime()))[0];

  if (problem) {
    log.warn({ hostname, problems: ports.filter((p) => p.problem).map((p) => ({ port: p.port, problem: p.problem, cn: p.cert?.commonName })) },
      'A mail port serves a self-signed, expired or name-mismatched certificate');
  }
  res.json({
    hostname,
    ports,
    problem,
    suggestedCert: suggestion ? { id: suggestion.id, name: suggestion.name } : null,
    unreadableKeys,
  });
});

// ── GET /acme-suggestions ─────────────────────────────────────────────────────
// 9.3: defaults for a Let's Encrypt order for the public host name — the mail
// services are preselected, autodiscover.<domain> / autoconfig.<domain> are
// offered as additional names (checked by default when their DNS points here).
adminCertificatesRouter.get('/acme-suggestions', async (_req: Request, res: Response) => {
  const settings = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { publicHostname: true },
  }).catch(() => null);
  const hostname = (settings?.publicHostname ?? '').trim().toLowerCase();
  if (!hostname || isDefaultHostname(hostname) || !hostname.includes('.')) {
    res.json({ publicHostname: null, domain: null, sans: [], preselectServices: [] });
    return;
  }
  const primary = await prisma.domain.findFirst({
    where: { primary: true }, select: { name: true },
  }).catch(() => null);
  const domain = (primary?.name ?? hostname.split('.').slice(1).join('.')).toLowerCase();
  const sans = await suggestAdditionalSans(hostname, domain).catch(() => []);
  res.json({ publicHostname: hostname, domain, sans, preselectServices: [...MAIL_SERVICES] });
});

// ── GET / ─────────────────────────────────────────────────────────────────────
adminCertificatesRouter.get('/', async (_req: Request, res: Response) => {
  const certs = await prisma.certificate.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, domains: true, services: true,
      type: true, status: true, issuedAt: true, expiresAt: true,
      autoRenew: true, isActiveHttps: true, isActiveProtocol: true,
      acmeEmail: true, acmeStaging: true, lastError: true, lastErrorCode: true,
      createdAt: true, updatedAt: true,
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
    domains:   AcmeDomainsSchema,
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

  const { name, domains, email, autoRenew, staging } = parsed.data;
  // 9.3: staging certificates are untrusted and never serve SMTP/IMAP/POP3.
  if (staging && hasMailService(parsed.data.services)) { res.status(400).json(STAGING_NO_MAIL); return; }
  // One protocol certificate serves SMTP, IMAP and POP3 together.
  const services = withMailServices(parsed.data.services, hasMailService(parsed.data.services));

  // Create the certificate as PENDING right away (issuance runs async). The
  // mail services stay on the current certificate until this one is issued —
  // the issuance applies it (afterAcmeIssued), so nothing changes before a
  // usable certificate exists.
  const cert = await prisma.certificate.create({
    data: {
      name,
      domains,
      services,
      type:        'LETSENCRYPT',
      status:      'PENDING',
      acmeEmail:   email,
      acmeStaging: staging,
      autoRenew,
    },
  });

  log.info({ id: cert.id, domains, staging }, 'Let\'s Encrypt certificate requested');

  // 9.2.x: same code path as retry/renewal — per-certificate lock, stored
  // staging flag, ERROR with the CA's problem detail on failure.
  try {
    const started = await startRenewal(cert.id, 'issue');
    if (!started.started) throw new Error(`issuance not started (${started.reason})`);
  } catch (err) {
    const msg = `Could not start the issuance: ${err instanceof Error ? err.message : String(err)}`;
    log.error({ err, id: cert.id }, 'Failed to start ACME issuance');
    await prisma.certificate.update({
      where: { id: cert.id }, data: { status: 'ERROR', lastError: msg.slice(0, 1000), lastErrorCode: 'unknown' },
    }).catch(() => undefined);
    res.status(503).json({ error: msg, id: cert.id });
    return;
  }

  res.status(202).json({
    ...safe(cert as unknown as Record<string, unknown>),
    message: 'Certificate issuance started. Check status for progress.',
  });
});

// ── POST /preflight ───────────────────────────────────────────────────────────
// Let's Encrypt prerequisites before ordering: DNS (A/AAAA, same address as the
// server host name), CAA, local serving of /.well-known/acme-challenge/, fetch
// over the public name (informational — hairpin NAT), and — `external` — a real
// validation by the Let's Encrypt STAGING environment (no certificate, no
// production limits). Takes up to ~90 s with the external test.
adminCertificatesRouter.post('/preflight', async (req: Request, res: Response) => {
  const schema = z.object({
    domains:  AcmeDomainsSchema,
    external: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input', details: parsed.error.issues });
    return;
  }
  const { domains, external } = parsed.data;
  const settings = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { publicHostname: true },
  }).catch(() => null);
  let serverHost: { hostname: string; ipv4: string[] } | null = null;
  const hostname = settings?.publicHostname?.trim().toLowerCase() ?? '';
  if (hostname && !isDefaultHostname(hostname)) {
    const l = await lookupAddresses(hostname).catch(() => null);
    if (l) serverHost = { hostname, ipv4: l.ipv4 };
  }
  const report = await runPreflight(domains, {
    serving: getChallengeServing({ ttlSeconds: 120 }),
    serverHost,
    ...(external ? { external: (d: string[]) => runAcmeValidationTest(d) } : {}),
  });
  log.info({ domains, ok: report.ok, external: report.external.status }, 'Let\'s Encrypt pre-flight check');
  res.json(report);
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
  // 9.2.x: the HTTPS proxy serves the certificate for every listed domain —
  // a domain the certificate does not name produced name-mismatch errors.
  const uncovered = uncoveredDomains(parsed.data.certPem, parsed.data.domains);
  if (uncovered.length > 0) {
    res.status(400).json({ error: `The certificate does not cover: ${uncovered.join(', ')}` });
    return;
  }

  const wantsMail = hasMailService(parsed.data.services);
  const cert = await prisma.certificate.create({
    data: {
      name:      parsed.data.name,
      domains:   parsed.data.domains,
      services:  withMailServices(parsed.data.services, wantsMail),
      type:      'CUSTOM',
      status:    deriveCertStatus(expiresAt),
      certPem:   parsed.data.certPem,
      keyPem:    encryptPrivateKey(parsed.data.keyPem),
      chainPem:  parsed.data.chainPem ?? null,
      issuedAt:  new Date(),
      expiresAt,
      autoRenew: parsed.data.autoRenew,
    },
  });

  // v3.18.32: update the SNI map in the TLS proxy — new hostname available.
  await publishTlsReload(cert.id);

  // 9.3: assigning SMTP/IMAP/POP3 applies the certificate to the mail servers now.
  const assigned = wantsMail ? await assignProtocolCert(cert.id, { reason: 'upload', actor: actorOf(req) }) : null;

  log.info({ id: cert.id, name: cert.name, expiresAt, protocol: assigned?.applied ?? false }, 'Custom certificate uploaded');
  res.status(201).json({ ...safe(cert as unknown as Record<string, unknown>), ...protocolOutcome(assigned) });
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

  const { name, domains, days } = parsed.data;
  const wantsMail = hasMailService(parsed.data.services);
  const services = withMailServices(parsed.data.services, wantsMail);

  try {
    // RSA key + certificate signed with node-forge (lib/protocol-cert-assign.ts;
    // unique positive serial — browsers reject two certificates with the same
    // issuer + serial). The old "fallback" stored a bare public key as certPem.
    const { certPem, keyPem, expiresAt } = await createSelfSignedPem(domains, days);

    const cert = await prisma.certificate.create({
      data: {
        name,
        domains,
        services,
        type:      'SELF_SIGNED',
        status:    deriveCertStatus(expiresAt),
        certPem,
        keyPem:    encryptPrivateKey(keyPem),
        issuedAt:  new Date(),
        expiresAt,
        autoRenew: false,
      },
    });

    // v3.18.32: update the SNI map in the TLS proxy — new hostname available.
    await publishTlsReload(cert.id);

    // 9.3: assigning SMTP/IMAP/POP3 applies the certificate to the mail servers now.
    const assigned = wantsMail ? await assignProtocolCert(cert.id, { reason: 'self-signed', actor: actorOf(req) }) : null;

    log.info({ id: cert.id, domains, days, protocol: assigned?.applied ?? false }, 'Self-signed certificate generated');
    res.status(201).json({ ...safe(cert as unknown as Record<string, unknown>), ...protocolOutcome(assigned) });
  } catch (err) {
    log.error({ err }, 'Failed to generate self-signed certificate');
    res.status(500).json({ error: 'Failed to generate certificate' });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────
adminCertificatesRouter.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const schema = z.object({
    name:        z.string().min(1).max(100).optional(),
    services:    ServicesSchema.optional(),
    autoRenew:   z.boolean().optional(),
    // 9.2.x: Let's Encrypt only — switch staging ↔ production for the next run
    acmeStaging: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  type CurrentCert = {
    type: string; acmeStaging: boolean; certPem: string | null; keyPem: string | null; status: string;
    isActiveProtocol: boolean; services: string[];
  };
  let current: CurrentCert | null = null;
  if (parsed.data.acmeStaging !== undefined || parsed.data.services !== undefined) {
    current = await prisma.certificate.findUnique({
      where: { id },
      select: { type: true, acmeStaging: true, certPem: true, keyPem: true, status: true, isActiveProtocol: true, services: true },
    }) as CurrentCert | null;
    if (!current) { res.status(404).json({ error: 'Certificate not found' }); return; }
    if (parsed.data.acmeStaging !== undefined && current.type !== 'LETSENCRYPT') {
      res.status(400).json({ error: 'Only Let\'s Encrypt certificates have a staging setting' });
      return;
    }
    // 9.2.x review: switching to staging is only possible while no trusted
    // certificate has been issued (unissued / failed first issuance) — the next
    // run would otherwise replace the working PEM with an untrusted one.
    if (parsed.data.acmeStaging === true && holdsTrustedPem(current)) {
      res.status(409).json({
        error:   'This certificate already holds a trusted (production) certificate — staging can only be enabled for unissued or failed certificates',
        code:    'STAGING_NOT_ALLOWED',
        message: 'Dieses Zertifikat wurde bereits produktiv (vertrauenswürdig) ausgestellt. Staging lässt sich nur für noch nicht ausgestellte oder fehlgeschlagene Zertifikate einschalten — für einen Test bitte ein neues Staging-Zertifikat anlegen.',
      });
      return;
    }
    const stagingCert = current.type === 'LETSENCRYPT' && (parsed.data.acmeStaging ?? current.acmeStaging) === true;
    // 9.3: a staging certificate never serves SMTP/IMAP/POP3 — refuse instead
    // of storing a label the servers ignore.
    if (stagingCert && hasMailService(parsed.data.services ?? current.services)) {
      res.status(409).json(STAGING_NO_MAIL);
      return;
    }
    // Removing the services from the self-signed protocol certificate would
    // only produce another self-signed one — assign them elsewhere instead.
    if (parsed.data.services !== undefined && !hasMailService(parsed.data.services)
        && current.isActiveProtocol && current.type === 'SELF_SIGNED') {
      res.status(409).json(PROTOCOL_CERT_REQUIRED);
      return;
    }
    // An issued certificate whose PEM is expired / not yet valid can never be
    // applied — refuse instead of storing a mail-service label the servers do
    // not serve (two certificates would show SMTP/IMAP/POP3). A certificate
    // that is not issued yet keeps a pending assignment (applied on issuance).
    if (parsed.data.services !== undefined && hasMailService(parsed.data.services)
        && !hasMailService(current.services) && !current.isActiveProtocol && protocolBlocker(current) === 'not-valid') {
      res.status(400).json({
        error:   'Certificate is not currently valid — expired or not yet valid; it cannot serve SMTP/IMAP/POP3',
        code:    'CERT_NOT_VALID',
        message: 'Das Zertifikat ist abgelaufen oder noch nicht gültig und kann nicht für SMTP/IMAP/POP3 verwendet werden.',
      });
      return;
    }
  }
  const select = {
    id: true, name: true, domains: true, services: true, type: true,
    status: true, issuedAt: true, expiresAt: true, autoRenew: true,
    isActiveHttps: true, isActiveProtocol: true, acmeEmail: true, acmeStaging: true,
    lastError: true, lastErrorCode: true, createdAt: true, updatedAt: true,
  } as const;
  const wantsMail = parsed.data.services !== undefined ? hasMailService(parsed.data.services) : null;
  let cert;
  try {
    cert = await prisma.certificate.update({
      where: { id },
      data: {
        ...(parsed.data.name        !== undefined ? { name: parsed.data.name }               : {}),
        // one protocol certificate serves SMTP, IMAP and POP3 together
        ...(parsed.data.services    !== undefined ? { services: withMailServices(parsed.data.services, !!wantsMail) } : {}),
        ...(parsed.data.autoRenew   !== undefined ? { autoRenew: parsed.data.autoRenew }     : {}),
        ...(parsed.data.acmeStaging !== undefined ? { acmeStaging: parsed.data.acmeStaging } : {}),
      },
      select,
    });
  } catch {
    res.status(404).json({ error: 'Certificate not found' });
    return;
  }

  // 9.3: the services ARE the switch — assigning SMTP/IMAP/POP3 applies the
  // certificate to the mail servers immediately; removing them from the
  // protocol certificate falls back to the self-signed default. A certificate
  // that is not usable yet (Let's Encrypt still pending) keeps the assignment
  // and is applied by its issuance.
  let assigned: AssignResult | null = null;
  const alreadyProtocolCert = !!current?.isActiveProtocol && MAIL_SERVICES.every((s) => current!.services.includes(s));
  if (wantsMail === true && alreadyProtocolCert) {
    // unchanged assignment (e.g. only the name was edited) — no reload, no switch audit
    assigned = { applied: true, certId: id, previousCertIds: [] };
  } else if (wantsMail === true) {
    assigned = await assignProtocolCert(id, { reason: 'services-assigned', actor: actorOf(req) });
  } else if (wantsMail === false && current?.isActiveProtocol) {
    assigned = await fallbackToSelfSigned({ reason: 'services-removed', actor: actorOf(req), excludeId: id });
  }
  if (assigned) {
    cert = await prisma.certificate.findUnique({ where: { id }, select }) ?? cert;
  }
  res.json({
    ...safe(cert as unknown as Record<string, unknown>),
    ...(wantsMail === true ? protocolOutcome(assigned) : {}),
  });
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
      // 9.2.x review: the BCP shows until when the running process holds the lock.
      ...(started.lockedUntil ? {
        lockedUntil: started.lockedUntil.toISOString(),
        message: `Für dieses Zertifikat läuft bereits eine Ausstellung/Erneuerung — ${lockedUntilText(started.lockedUntil)}. Danach erneut versuchen.`,
      } : {}),
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
// Activates this certificate for the mail protocols (SMTP/IMAP/POP3). Kept for
// API compatibility (CLI, older BCP); since 9.3 it is the same switch as
// assigning the services via PUT — the certificate also gets SMTP/IMAP/POP3 as
// its services, so the BCP and the served certificate always agree.
adminCertificatesRouter.post('/:id/activate-protocol', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const r = await assignProtocolCert(id, { reason: 'activate-protocol', actor: actorOf(req) });
  if (!r.applied) {
    if (r.blocker === 'not-found') { res.status(404).json({ error: 'Certificate not found' }); return; }
    if (r.blocker === 'staging') { res.status(409).json(STAGING_NO_MAIL); return; }
    if (r.blocker === 'no-pem') { res.status(400).json({ error: 'Certificate has no PEM data yet' }); return; }
    // v6: usability is decided by the PEM validity, not by the DB status
    res.status(400).json({ error: 'Certificate is not currently valid — expired or not yet valid' });
    return;
  }
  log.info({ id }, 'Certificate activated for mail protocols (SMTP/IMAP/POP3)');
  res.json({
    message: 'Certificate activated for SMTP/IMAP/POP3 — servers reloading TLS',
    certId: id,
    services: [...MAIL_SERVICES],
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
      // 9.3: SMTP/IMAP/POP3 fall back to the self-signed default for the public
      // host name (a visible certificate row, not an anonymous mail.localhost one)
      await fallbackToSelfSigned({ reason: 'protocol-cert-deleted', actor: actorOf(req), excludeId: id });
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
