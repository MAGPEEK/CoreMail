/**
 * Admin-API: Server-Einstellungen / Virtuelle Verzeichnisse
 *
 * GET  /api/v1/admin/servers/settings  — aktuelle Einstellungen lesen
 * PUT  /api/v1/admin/servers/settings  — Einstellungen speichern
 * POST /api/v1/admin/servers/settings/derive — URLs automatisch aus Hostname ableiten
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';
import { createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';

const log = createLogger('admin:servers');
export const adminServersRouter: RouterType = Router();
adminServersRouter.use(requireAdmin);

const SettingsSchema = z.object({
  publicHostname:   z.string().min(1),
  useHttps:         z.boolean(),
  httpPort:         z.number().int().min(1).max(65535),
  ewsUrl:           z.string().url(),
  owaUrl:           z.string().url(),
  easUrl:           z.string().url(),
  autodiscoverBase: z.string().url(),
  imapHost:         z.string().min(1),
  imapPort:         z.number().int().min(1).max(65535),
  imapSsl:          z.boolean(),
  pop3Host:         z.string().min(1),
  pop3Port:         z.number().int().min(1).max(65535),
  pop3Ssl:          z.boolean(),
  smtpHost:         z.string().min(1),
  smtpPort:         z.number().int().min(1).max(65535),
  smtpTls:          z.boolean(),
  orgName:          z.string().min(1),
});

// GET /api/v1/admin/servers/settings
adminServersRouter.get('/settings', async (_req: Request, res: Response) => {
  try {
    const settings = await prisma.serverSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });
    res.json(settings);
  } catch (err) {
    log.error({ err }, 'Failed to read server settings');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/v1/admin/servers/settings
adminServersRouter.put('/settings', async (req: Request, res: Response) => {
  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  try {
    const settings = await prisma.serverSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', ...parsed.data },
      update: parsed.data,
    });
    log.info({ hostname: parsed.data.publicHostname }, 'Server settings updated');

    // Notify SMTP / IMAP / POP3 servers to pick up new hostname
    try {
      await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'hostname' }));
    } catch (pubErr) {
      log.warn({ pubErr }, 'Failed to publish settings reload signal');
    }

    res.json(settings);
  } catch (err) {
    log.error({ err }, 'Failed to update server settings');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/admin/servers/settings/derive
// URLs automatisch aus Hostname + Port ableiten (Komfort-Endpunkt für ECP)
adminServersRouter.post('/settings/derive', async (req: Request, res: Response) => {
  const schema = z.object({
    publicHostname: z.string().min(1),
    useHttps:       z.boolean().default(false),
    httpPort:       z.number().int().min(1).max(65535).default(8080),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const { publicHostname, useHttps, httpPort } = parsed.data;
  const proto = useHttps ? 'https' : 'http';
  // Standard-Port weglassen (443 für https, 80 für http)
  const portSuffix = (useHttps && httpPort === 443) || (!useHttps && httpPort === 80)
    ? ''
    : `:${httpPort}`;
  const base = `${proto}://${publicHostname}${portSuffix}`;

  // Autodiscover MUSS auf eigener CNAME laufen (Microsoft Exchange Spec):
  // Outlook sucht IMMER zuerst `autodiscover.{primary-domain}` ab.
  // Hostname `mail.stefanwuestner.de` → autodiscover-Host `autodiscover.stefanwuestner.de`
  // Hostname `stefanwuestner.de` (kein Subdomain) → `autodiscover.stefanwuestner.de`
  // Falls Hostname schon mit `autodiscover.` beginnt → unverändert
  const autodiscoverHost = (() => {
    if (publicHostname.startsWith('autodiscover.')) return publicHostname;
    const labels = publicHostname.split('.');
    // ≥ 3 Labels → erste Subdomain abschneiden (mail.stefanwuestner.de → stefanwuestner.de)
    // ≤ 2 Labels → Root-Domain direkt verwenden
    const rootDomain = labels.length >= 3 ? labels.slice(1).join('.') : publicHostname;
    return `autodiscover.${rootDomain}`;
  })();
  const autodiscoverBase = `${proto}://${autodiscoverHost}${portSuffix}`;

  res.json({
    publicHostname,
    useHttps,
    httpPort,
    ewsUrl:           `${base}/EWS/Exchange.asmx`,
    owaUrl:           `${base}/owa/`,
    easUrl:           `${base}/Microsoft-Server-ActiveSync`,
    autodiscoverBase,
    imapHost:         publicHostname,
    imapPort:         useHttps ? 993 : 993,
    imapSsl:          true,
    pop3Host:         publicHostname,
    pop3Port:         995,
    pop3Ssl:          true,
    smtpHost:         publicHostname,
    smtpPort:         587,
    smtpTls:          true,
    orgName:          'CoreMail',
  });
});
