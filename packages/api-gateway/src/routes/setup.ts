import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { hashPassword } from '@coremail/core';

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

    log.info({ email, domain }, 'Initial setup completed — admin user created');
    res.json({ success: true, email, message: 'Setup abgeschlossen. Du kannst dich jetzt anmelden.' });
  } catch (err) {
    log.error({ err }, 'setup failed');
    res.status(500).json({ error: 'Setup fehlgeschlagen' });
  }
});
