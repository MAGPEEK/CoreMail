import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../../middleware/auth.js';

export const adminSmtpConfigRouter: RouterType = Router();
adminSmtpConfigRouter.use(requireAuth);

async function getOrCreate() {
  return prisma.smtpSettings.upsert({
    where:  { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });
}

// GET /admin/smtp-config/settings
adminSmtpConfigRouter.get('/settings', async (_req: Request, res: Response) => {
  const s = await getOrCreate();
  // Passwort für die Antwort maskieren (Sicherheit)
  res.json({ ...s, smarthostPassword: s.smarthostPassword ? '••••••••' : '' });
});

// PUT /admin/smtp-config/settings
adminSmtpConfigRouter.put('/settings', async (req: Request, res: Response) => {
  const schema = z.object({
    // ESMTP Extensions
    extStarttls:          z.boolean().optional(),
    extAuthPlain:         z.boolean().optional(),
    extAuthLogin:         z.boolean().optional(),
    extAuthCramMd5:       z.boolean().optional(),
    extPipelining:        z.boolean().optional(),
    extSize:              z.boolean().optional(),
    ext8bitmime:          z.boolean().optional(),
    extEnhancedStatus:    z.boolean().optional(),
    extSmtputf8:          z.boolean().optional(),
    extDsn:               z.boolean().optional(),
    extChunking:          z.boolean().optional(),
    // Local delivery
    localDeliveryEnabled: z.boolean().optional(),
    // Banner
    bannerOverride:       z.boolean().optional(),
    bannerText:           z.string().max(255).optional(),
    // Relaying
    relayingEnabled:      z.boolean().optional(),
    relayDomains:         z.array(z.string().min(1)).optional(),
    relayRequireAuth:     z.boolean().optional(),
    relayTrustedIps:      z.array(z.string()).optional(),
    // Greylisting
    greylistingEnabled:   z.boolean().optional(),
    greylistWaitSec:      z.number().int().min(60).max(3600).optional(),
    greylistTtlHours:     z.number().int().min(1).max(168).optional(),
    greylistWhitelist:    z.array(z.string()).optional(),
    // Connection
    maxConnections:       z.number().int().min(1).max(10000).optional(),
    maxConnectionsPerIp:  z.number().int().min(1).max(1000).optional(),
    maxMessageSizeMb:     z.number().int().min(1).max(500).optional(),
    maxRecipients:        z.number().int().min(1).max(10000).optional(),
    connectionTimeoutSec: z.number().int().min(30).max(3600).optional(),
    greetingDelaySec:     z.number().int().min(0).max(30).optional(),
    maxAuthFailures:      z.number().int().min(1).max(100).optional(),
    // Outgoing Delivery
    outboundMode:         z.enum(['mx', 'smarthost']).optional(),
    smarthostHost:        z.string().max(253).optional(),
    smarthostPort:        z.number().int().min(1).max(65535).optional(),
    smarthostTls:         z.boolean().optional(),
    smarthostImplicitTls: z.boolean().optional(),
    smarthostUsername:    z.string().max(255).optional(),
    smarthostPassword:    z.string().max(255).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const data = { ...parsed.data } as Record<string, unknown>;

  // Maskiertes Passwort nicht in die DB schreiben
  if (data['smarthostPassword'] === '••••••••') {
    delete data['smarthostPassword'];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settings = await prisma.smtpSettings.upsert({
    where:  { id: 'singleton' },
    update: data as any,
    create: { id: 'singleton', ...data } as any,
  });

  // Cache im smtp-server invalidieren (via Redis-Pub/Sub nicht nötig — TTL 60s reicht)
  res.json({ ...settings, smarthostPassword: settings.smarthostPassword ? '••••••••' : '' });
});

// POST /admin/smtp-config/test-smarthost
// Testet die Verbindung zu einem Smarthost ohne zu speichern
adminSmtpConfigRouter.post('/test-smarthost', async (req: Request, res: Response) => {
  const schema = z.object({
    host:        z.string().min(1),
    port:        z.number().int().min(1).max(65535),
    tls:         z.boolean().default(true),
    implicitTls: z.boolean().default(false),
    username:    z.string().optional(),
    password:    z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: 'Ungültige Parameter' });
    return;
  }

  const { host, port, tls, implicitTls, username, password } = parsed.data;

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure:           implicitTls,
      requireTLS:       tls && !implicitTls,
      opportunisticTLS: tls && !implicitTls,
      ...(username ? { auth: { user: username, pass: password ?? '' } } : {}),
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10_000,
      greetingTimeout:   10_000,
      socketTimeout:     10_000,
    });

    await transporter.verify();
    res.json({ ok: true, message: `Verbindung zu ${host}:${port} erfolgreich` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ ok: false, message: msg });
  }
});
