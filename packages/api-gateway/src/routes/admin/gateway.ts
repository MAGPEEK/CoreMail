/**
 * SMTP Gateway Admin API — Phase 10
 *
 * Manage the gateway (relay) mode settings.
 *
 *   GET  /api/v1/admin/gateway/settings  — get current gateway config
 *   PUT  /api/v1/admin/gateway/settings  — update gateway config
 *   POST /api/v1/admin/gateway/test      — test upstream connectivity
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage/prisma';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { audit, auditContext } from '../../lib/audit.js';
import nodemailer from 'nodemailer';

export const adminGatewayRouter: RouterType = Router();
adminGatewayRouter.use(requireAuth, requireAdmin);

/**
 * GET /api/v1/admin/gateway/settings
 * Returns the current gateway configuration (password masked).
 */
adminGatewayRouter.get('/settings', async (_req: Request, res: Response) => {
  const settings = await prisma.gatewaySettings.findUnique({ where: { id: 'singleton' } });

  if (!settings) {
    // Return defaults (all disabled)
    res.json({
      enabled: false,
      upstreamHost: '',
      upstreamPort: 25,
      upstreamTls: false,
      upstreamUsername: null,
      upstreamPassword: null,  // always masked
      relayDomains: [],
      filterBeforeRelay: true,
    });
    return;
  }

  res.json({
    enabled: settings.enabled,
    upstreamHost: settings.upstreamHost,
    upstreamPort: settings.upstreamPort,
    upstreamTls: settings.upstreamTls,
    upstreamUsername: settings.upstreamUsername ?? null,
    upstreamPassword: settings.upstreamPassword ? '••••••••' : null,
    relayDomains: settings.relayDomains,
    filterBeforeRelay: settings.filterBeforeRelay,
  });
});

/**
 * PUT /api/v1/admin/gateway/settings
 * Create or update gateway configuration.
 * Body: { enabled, upstreamHost, upstreamPort, upstreamTls, upstreamUsername?,
 *         upstreamPassword?, relayDomains, filterBeforeRelay }
 *
 * To keep existing password unchanged, omit upstreamPassword or pass null.
 */
adminGatewayRouter.put('/settings', async (req: Request, res: Response) => {
  const body = req.body as {
    enabled?: boolean;
    upstreamHost?: string;
    upstreamPort?: number;
    upstreamTls?: boolean;
    upstreamUsername?: string | null;
    upstreamPassword?: string | null;
    relayDomains?: string[];
    filterBeforeRelay?: boolean;
  };

  // Validate required fields when enabling
  if (body.enabled && !body.upstreamHost) {
    res.status(400).json({ error: 'upstreamHost is required when gateway mode is enabled' });
    return;
  }

  if (body.upstreamPort !== undefined && (body.upstreamPort < 1 || body.upstreamPort > 65535)) {
    res.status(400).json({ error: 'upstreamPort must be between 1 and 65535' });
    return;
  }

  // Build upsert data (keep existing password if not provided)
  const existing = await prisma.gatewaySettings.findUnique({ where: { id: 'singleton' } });

  const data = {
    enabled: body.enabled ?? existing?.enabled ?? false,
    upstreamHost: body.upstreamHost ?? existing?.upstreamHost ?? '',
    upstreamPort: body.upstreamPort ?? existing?.upstreamPort ?? 25,
    upstreamTls: body.upstreamTls ?? existing?.upstreamTls ?? false,
    relayDomains: body.relayDomains ?? existing?.relayDomains ?? [],
    filterBeforeRelay: body.filterBeforeRelay ?? existing?.filterBeforeRelay ?? true,
    // Only update credentials if explicitly provided
    ...(body.upstreamUsername !== undefined
      ? { upstreamUsername: body.upstreamUsername ?? null }
      : {}),
    ...(body.upstreamPassword !== undefined && body.upstreamPassword !== null && body.upstreamPassword !== '••••••••'
      ? { upstreamPassword: body.upstreamPassword }
      : {}),
  };

  const settings = await prisma.gatewaySettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...data },
    update: data,
  });

  audit({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email ?? '',
    action: 'UPDATE_GATEWAY_SETTINGS',
    targetType: 'GatewaySettings',
    targetId: 'singleton',
    targetName: 'SMTP Gateway',
    changes: { enabled: settings.enabled, upstreamHost: settings.upstreamHost },
    ...auditContext(req),
  });

  res.json({
    enabled: settings.enabled,
    upstreamHost: settings.upstreamHost,
    upstreamPort: settings.upstreamPort,
    upstreamTls: settings.upstreamTls,
    upstreamUsername: settings.upstreamUsername ?? null,
    upstreamPassword: settings.upstreamPassword ? '••••••••' : null,
    relayDomains: settings.relayDomains,
    filterBeforeRelay: settings.filterBeforeRelay,
  });
});

/**
 * POST /api/v1/admin/gateway/test
 * Test upstream SMTP connectivity.
 * Body: { host, port, tls, username?, password? }
 */
adminGatewayRouter.post('/test', async (req: Request, res: Response) => {
  const { host, port, tls, username, password } = req.body as {
    host?: string;
    port?: number;
    tls?: boolean;
    username?: string;
    password?: string;
  };

  if (!host) {
    res.status(400).json({ error: 'host is required' });
    return;
  }

  const transport = nodemailer.createTransport({
    host,
    port: port ?? 25,
    secure: (port ?? 25) === 465,
    ...(tls && (port ?? 25) !== 465 ? { requireTLS: true } : {}),
    tls: { rejectUnauthorized: false },
    ...(username && password ? { auth: { user: username, pass: password } } : {}),
    connectionTimeout: 10_000,
    socketTimeout: 10_000,
  });

  try {
    await transport.verify();
    res.json({ ok: true, message: `Successfully connected to ${host}:${port ?? 25}` });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ ok: false, error: message });
  } finally {
    transport.close();
  }
});
