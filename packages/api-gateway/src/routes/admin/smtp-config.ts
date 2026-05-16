import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
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
  res.json(await getOrCreate());
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
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settings = await prisma.smtpSettings.upsert({
    where:  { id: 'singleton' },
    update: parsed.data as any,
    create: { id: 'singleton', ...parsed.data } as any,
  });

  res.json(settings);
});
