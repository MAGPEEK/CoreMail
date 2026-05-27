import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger, hashPassword, generateSelfSignedCert, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { deriveServerUrls } from '../lib/server-urls.js';

const log = createLogger('api:setup');
export const setupRouter: RouterType = Router();

// ── Hilfsfunktion: Ist Setup erforderlich? ────────────────────────────────────
async function isSetupRequired(): Promise<boolean> {
  const count = await prisma.user.count();
  return count === 0;
}

// GET /api/v1/setup/status
// Öffentlich — prüft ob noch kein User existiert
setupRouter.get('/status', async (_req: Request, res: Response) => {
  try {
    const setupRequired = await isSetupRequired();
    res.json({ setupRequired });
  } catch (err) {
    log.error({ err }, 'setup status check failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/setup/complete
// Öffentlich — nur wenn noch kein User existiert
const SetupSchema = z.object({
  domain:    z.string().min(3).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Ungültige Domain (z.B. firma.de)'),
  email:     z.string().email(),
  password:  z.string().min(8, 'Passwort muss mindestens 8 Zeichen haben'),
});

setupRouter.post('/complete', async (req: Request, res: Response) => {
  try {
    // Nur erlaubt wenn noch kein User existiert
    if (!(await isSetupRequired())) {
      res.status(409).json({ error: 'Setup already completed' });
      return;
    }

    const parsed = SetupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Invalid input' });
      return;
    }

    const { domain, email, password } = parsed.data;

    // E-Mail muss zur Domain passen
    const emailDomain = email.split('@')[1];
    if (emailDomain !== domain) {
      res.status(400).json({ error: `E-Mail muss zur Domain @${domain} gehören` });
      return;
    }

    // hashPassword nutzt sha256(password + PEPPER) → bcrypt
    const passwordHash = await hashPassword(password);

    // Domain + Admin-User in einer Transaktion anlegen
    await prisma.$transaction(async (tx) => {
      // Domain anlegen
      const newDomain = await tx.domain.create({
        data: {
          name: domain,
          dkimPrivateKey: '',
          dkimSelector:   'default',
          active:          true,
          primary:         true, // v3.18.36: Setup-Domain ist immer primary
        },
      });

      // v3.18.36: publicHostname + alle abgeleiteten Server-URLs sofort
      // aus der Setup-Domain ableiten — sonst bleibt das System auf den
      // unbrauchbaren Schema-Defaults `mail.local:8080` hängen und
      // Outlook-Autodiscover liefert Outlook-Clients Falsche URLs.
      const newHostname = `mail.${domain}`;
      const derivedUrls = deriveServerUrls(newHostname, true, 443);
      await tx.serverSettings.upsert({
        where: { id: 'singleton' },
        create: {
          id: 'singleton',
          publicHostname: newHostname,
          useHttps: true,
          httpPort: 443,
          ...derivedUrls,
        },
        update: {
          publicHostname: newHostname,
          useHttps: true,
          httpPort: 443,
          ...derivedUrls,
        },
      });

      // Admin-User anlegen
      const user = await tx.user.create({
        data: {
          email,
          displayName:  'Administrator',
          passwordHash,
          role:         'ORGANIZATION_MANAGEMENT',
          domainId:     newDomain.id,
        },
      });

      // Mailbox + Standard-Ordner provisionieren
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
    });

    // ── Auto self-signed cert ────────────────────────────────────────────────
    // Generates a baseline self-signed cert with CN=mail.localhost.  Admin
    // activates a real (LE/uploaded) cert later in BCP → SSL/TLS.  Using a
    // predictable 'mail.localhost' CN avoids accidental re-issuance whenever
    // the admin renames their public hostname.
    try {
      const SELF_SIGNED_HOSTNAME = 'mail.localhost';

      const { certPem, keyPem } = generateSelfSignedCert(SELF_SIGNED_HOSTNAME);
      const tenYears = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);

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

    log.info({ email, domain }, 'Initial setup completed — admin user created');
    res.json({ success: true, email, message: 'Setup abgeschlossen. Du kannst dich jetzt anmelden.' });
  } catch (err) {
    log.error({ err }, 'setup failed');
    res.status(500).json({ error: 'Setup fehlgeschlagen' });
  }
});
