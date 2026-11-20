import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, encryptPrivateKey } from '@coremail/storage';
import {
  createLogger, hashPassword, getRedisClient, CHANNEL_SETTINGS_RELOAD, HttpError,
} from '@coremail/core';
import { createSelfSignedPem, selfSignedHostnameFor } from '../lib/protocol-cert-assign.js';
import { isSetupRequired, verifySetupToken } from '../lib/setup-token.js';
import { removeSetupTokenFile, secretsStatus } from '../lib/setup-secrets.js';
import { deriveServerUrls } from '../lib/server-urls.js';
import { generateDkimPrivateKey } from '../lib/dkim.js';

const log = createLogger('api:setup');
export const setupRouter: RouterType = Router();

// GET /api/v1/setup/status
// Public — setup is required only until it was completed once (persistent
// flag, v6) — deleting all users does not reopen it.
// 10.4: secretsFile = host-relative hint of the secrets file the container
// loaded (null without one), secretsGenerated = CoreMail generated it. Never a
// secret value.
// 10.4.2: secureConnection = this request arrived over HTTPS (TLS socket, or
// X-Forwarded-Proto from a TRUST_PROXY-trusted proxy — req.secure); the wizard
// warns next to the secrets download when it is false.
setupRouter.get('/status', async (req: Request, res: Response) => {
  try {
    const setupRequired = await isSetupRequired();
    // v6: the wizard must ask for the one-time setup token (api-gateway log / SETUP_TOKEN)
    res.json({ setupRequired, setupTokenRequired: setupRequired, ...secretsStatus(), secureConnection: req.secure });
  } catch (err) {
    log.error({ err }, 'setup status check failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** The token a request presents: body `setupToken`, else header `X-Setup-Token`. */
function presentedToken(req: Request): string | undefined {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return typeof body['setupToken'] === 'string' ? body['setupToken'] : req.get('X-Setup-Token');
}

// POST /api/v1/setup/verify-token
// 10.4: lets the wizard check the one-time token on its first page instead of
// after all forms are filled in. Public, same rate limit as /complete (every
// POST under /api/v1/setup counts); answers only valid / invalid, changes
// nothing and never returns the token. Closed once setup is complete (409).
setupRouter.post('/verify-token', async (req: Request, res: Response) => {
  if (!(await isSetupRequired())) {
    res.status(409).json({ error: 'Setup already completed' });
    return;
  }
  if (!(await verifySetupToken(presentedToken(req)))) {
    log.warn({ ip: req.ip }, 'Setup token check with missing/invalid token');
    res.status(403).json({ error: 'Invalid or missing setup token', code: 'SETUP_TOKEN_INVALID' });
    return;
  }
  res.json({ valid: true });
});

// Host-name labels (letters, digits, hyphen; no leading/trailing hyphen), at least one dot.
const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// POST /api/v1/setup/complete
// Public, but requires the one-time setup token (body `setupToken` or header
// `X-Setup-Token`) and succeeds at most once (atomic claim).
// 10.4: optional `hostname` (public host name, default mail.<domain>),
// `organizationName` (ServerSettings.orgName) and `displayName` (admin).
const SetupSchema = z.object({
  domain:    z.string().trim().toLowerCase().pipe(
    z.string().min(3).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Ungültige Domain (z.B. firma.de)')),
  email:     z.string().trim().toLowerCase().pipe(z.string().email()),
  password:  z.string().min(8, 'Passwort muss mindestens 8 Zeichen haben'),
  hostname:  z.string().trim().toLowerCase().transform((h) => h.replace(/\.$/, '')).pipe(
    z.string().regex(HOSTNAME_RE, 'Ungültiger Hostname (z.B. mail.firma.de)')).optional(),
  organizationName: z.string().trim().max(200).optional(),
  displayName:      z.string().trim().max(200).optional(),
  setupToken: z.string().optional(),
});

setupRouter.post('/complete', async (req: Request, res: Response) => {
  // Only allowed while setup was never completed and no user exists
  if (!(await isSetupRequired())) {
    res.status(409).json({ error: 'Setup already completed' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const presented = presentedToken(req);
  if (!(await verifySetupToken(presented))) {
    log.warn({ ip: req.ip }, 'Setup attempt with missing/invalid setup token');
    res.status(403).json({ error: 'Invalid or missing setup token', code: 'SETUP_TOKEN_INVALID' });
    return;
  }

  const parsed = SetupSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }

  const { domain, email, password } = parsed.data;
  const hostname = parsed.data.hostname ?? `mail.${domain}`;
  const orgName = parsed.data.organizationName || undefined;
  const displayName = parsed.data.displayName || 'Administrator';

  // Email must match the domain
  const emailDomain = email.split('@')[1];
  if (emailDomain !== domain) {
    res.status(400).json({ error: `E-Mail muss zur Domain @${domain} gehören` });
    return;
  }

  // hashPassword uses sha256(password + PEPPER) → bcrypt
  const passwordHash = await hashPassword(password);

  {
    // Create domain + admin user in one SERIALIZABLE transaction. The first
    // statement claims the persistent setup flag: of two concurrent requests
    // only one sees setupCompletedAt = null (the other blocks on the row lock
    // and then matches 0 rows, or fails serialization → P2034 → 409).
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.serverSettings.updateMany({
        where: { id: 'singleton', setupCompletedAt: null },
        data:  { setupCompletedAt: new Date(), setupTokenHash: null },
      });
      if (claimed.count !== 1) throw new HttpError(409, 'Setup already completed');
      if ((await tx.user.count()) > 0) throw new HttpError(409, 'Setup already completed');

      // Create domain
      const newDomain = await tx.domain.create({
        data: {
          name: domain,
          dkimPrivateKey: generateDkimPrivateKey(), // sign from the first mail on
          dkimSelector:   'default',
          active:          true,
          primary:         true, // v3.18.36: the setup domain is always primary
        },
      });

      // v3.18.36: derive publicHostname + all derived server URLs from the
      // setup domain immediately — otherwise the system stays stuck on the
      // unusable schema defaults `mail.local:8080` and Autodiscover
      // hands clients wrong URLs.
      // 10.4: the wizard may choose another host name (default mail.<domain>).
      // 10.5: a fresh installation starts with MFA mandatory for admins
      // (requireMfaForAdmins). Only here: existing installations never pass
      // through /setup/complete and keep their stored value (schema default
      // false — no silent lock-out on upgrade). The first admin enrols a second
      // factor in the webmail after the wizard; the BCP shows the MFA page until then.
      const newHostname = hostname;
      const derivedUrls = deriveServerUrls(newHostname, true, 443);
      await tx.serverSettings.upsert({
        where: { id: 'singleton' },
        create: {
          id: 'singleton',
          publicHostname: newHostname,
          useHttps: true,
          httpPort: 443,
          ...derivedUrls,
          ...(orgName ? { orgName } : {}),
          requireMfaForAdmins: true, // 10.5: fresh installations only (see comment above)
        },
        update: {
          publicHostname: newHostname,
          useHttps: true,
          httpPort: 443,
          ...derivedUrls,
          ...(orgName ? { orgName } : {}),
          requireMfaForAdmins: true, // 10.5: fresh installations only (see comment above)
        },
      });

      // Create admin user
      const user = await tx.user.create({
        data: {
          email,
          displayName,
          passwordHash,
          role:         'ORGANIZATION_MANAGEMENT',
          domainId:     newDomain.id,
        },
      });

      // Provision mailbox + default folders
      const mailbox = await tx.mailbox.create({
        data: { userId: user.id },
      });

      const standardFolders = [
        { name: 'INBOX',   displayName: 'Posteingang' },
        { name: 'Drafts',  displayName: 'Entwürfe'    },
        { name: 'Sent',    displayName: 'Gesendet'    },
        { name: 'Trash',   displayName: 'Gelöscht'    },
        { name: 'Junk',    displayName: 'Junk-E-Mail' },
        { name: 'Archive', displayName: 'Archiv'      },
        { name: 'Notes',   displayName: 'Notizen'     },
        { name: 'Tasks',   displayName: 'Aufgaben'    },
      ];

      for (const folder of standardFolders) {
        await tx.folder.create({
          data: {
            mailboxId:   mailbox.id,
            name:        folder.name,
            displayName: folder.displayName,
          },
        });
      }
    }, { isolationLevel: 'Serializable' });

    // 10.4: the one-time token is used up — remove <secrets>/setup-token.
    await removeSetupTokenFile();

    // ── Auto self-signed cert ────────────────────────────────────────────────
    // Baseline self-signed cert for the public host name (9.3: mail.<domain>
    // instead of mail.localhost — clients at least see the right name). The
    // admin assigns a real (LE/uploaded) cert later in BCP → SSL/TLS; a Let's
    // Encrypt certificate for the public host name takes over automatically.
    try {
      const SELF_SIGNED_HOSTNAME = selfSignedHostnameFor(hostname);

      const { certPem, keyPem: plainKeyPem, expiresAt: tenYears } = await createSelfSignedPem([SELF_SIGNED_HOSTNAME], 3650);
      const keyPem = encryptPrivateKey(plainKeyPem); // stored encrypted at rest

      // Remove any existing self-signed cert that may be left over
      await prisma.certificate.deleteMany({ where: { type: 'SELF_SIGNED' } });

      // Create visible cert entry in the certificates table
      await prisma.certificate.create({
        data: {
          name:             SELF_SIGNED_HOSTNAME,
          domains:          [SELF_SIGNED_HOSTNAME],
          services:         ['SMTP', 'IMAP', 'POP3'],
          type:             'SELF_SIGNED',
          status:           'ACTIVE',
          certPem,
          keyPem,
          isActiveProtocol: true,
          isActiveHttps:    false,
          autoRenew:        false,
          issuedAt:         new Date(),
          expiresAt:        tenYears,
        },
      });

      // Also persist to server_settings so SMTP/IMAP/POP3 pick it up immediately
      await prisma.serverSettings.upsert({
        where:  { id: 'singleton' },
        update: { tlsCert: certPem, tlsKey: keyPem },
        create: { id: 'singleton', tlsCert: certPem, tlsKey: keyPem },
      });

      // Notify protocol servers to reload TLS
      void getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, '').catch(() => {});

      log.info({ hostname: SELF_SIGNED_HOSTNAME }, 'Self-signed certificate created and activated for SMTP/IMAP/POP3');
    } catch (certErr) {
      // Non-fatal — user can still log in and configure certs manually in BCP
      log.warn({ err: certErr }, 'Auto self-signed cert creation failed (non-fatal)');
    }

    log.info({ email, domain, hostname }, 'Initial setup completed — admin user created');
    res.json({ success: true, email, domain, hostname, message: 'Setup abgeschlossen. Du kannst dich jetzt anmelden.' });
  }
  // Errors (409 claim conflict, Prisma P2034 serialization failure → 409,
  // anything else → 500) are handled by the shared error middleware.
});
