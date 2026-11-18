import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import { prisma, clearMessageSizeLimitCache } from '@coremail/storage';
import { getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { requireArea } from '../../middleware/auth.js';
import { smarthostTestOptions } from '../../lib/smarthost-test.js';
import { containerNatWarnings, validateDeviceRelay, type DeviceRelayInput } from '../../lib/device-relay.js';
import { audit, auditContext } from '../../lib/audit.js';

export const adminSmtpConfigRouter: RouterType = Router();
adminSmtpConfigRouter.use(requireArea('servers'));

// ── Device relay (Geräte-Relay) ──────────────────────────────────────────────

const DEVICE_RELAY_DEFAULTS: DeviceRelayInput = {
  enabled: false, allowedNetworks: [], senderDomains: [], port: 25, maxMessagesPerMinute: 30,
};

/**
 * Stored configuration (defaults without a row) + whether an inbound listener
 * serves its port + warnings (allowed networks inside container/cluster NAT ranges).
 */
async function deviceRelayView(): Promise<DeviceRelayInput & { listenerActive: boolean; warnings: string[] }> {
  const row = await prisma.deviceRelaySettings.findUnique({ where: { id: 'singleton' } });
  const cfg: DeviceRelayInput = row
    ? { enabled: row.enabled, allowedNetworks: row.allowedNetworks, senderDomains: row.senderDomains, port: row.port, maxMessagesPerMinute: row.maxMessagesPerMinute }
    : DEVICE_RELAY_DEFAULTS;
  const listener = await prisma.serviceListener.findFirst({
    where: { service: 'SMTP_RECEIVE', port: cfg.port, active: true }, select: { id: true },
  });
  return { ...cfg, listenerActive: listener !== null, warnings: containerNatWarnings(cfg.allowedNetworks) };
}

// GET /admin/smtp-config/device-relay
adminSmtpConfigRouter.get('/device-relay', async (_req: Request, res: Response) => {
  res.json(await deviceRelayView());
});

const DeviceRelaySchema = z.object({
  enabled:              z.boolean(),
  allowedNetworks:      z.array(z.string().max(64)).max(256),
  senderDomains:        z.array(z.string().max(253)).max(256),
  port:                 z.number().int().min(1).max(65535),
  maxMessagesPerMinute: z.number().int().min(1).max(1000),
});

// PUT /admin/smtp-config/device-relay
adminSmtpConfigRouter.put('/device-relay', async (req: Request, res: Response) => {
  const parsed = DeviceRelaySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Ungültige Eingabe', details: parsed.error.issues });
    return;
  }
  const hosted = await prisma.domain.findMany({ where: { active: true }, select: { name: true } });
  const checked = validateDeviceRelay(parsed.data, hosted.map((d) => d.name));
  if (!checked.ok) { res.status(400).json({ error: checked.error }); return; }

  const before = await deviceRelayView();
  const value = checked.value;
  await prisma.deviceRelaySettings.upsert({
    where:  { id: 'singleton' },
    update: value,
    create: { id: 'singleton', ...value },
  });
  audit({
    ...(req.apiUser ? { actorId: req.apiUser.userId, actorEmail: req.apiUser.email } : {}),
    action: 'settings.device-relay.updated',
    targetType: 'DeviceRelaySettings',
    targetId: 'singleton',
    targetName: 'Geräte-Relay',
    changes: {
      before: { enabled: before.enabled, allowedNetworks: before.allowedNetworks, senderDomains: before.senderDomains, port: before.port, maxMessagesPerMinute: before.maxMessagesPerMinute },
      after: value,
    },
    ...auditContext(req),
  });
  // The SMTP server drops its cached policy on this signal.
  await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ kind: 'device-relay' })).catch(() => undefined);
  res.json(await deviceRelayView());
});

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
  // Mask the password for the response (security)
  res.json({ ...s, smarthostPassword: s.smarthostPassword ? '••••••••' : '' });
});

// PUT /admin/smtp-config/settings
adminSmtpConfigRouter.put('/settings', async (req: Request, res: Response) => {
  const schema = z.object({
    // ESMTP Extensions
    extStarttls:          z.boolean().optional(),
    extAuthPlain:         z.boolean().optional(),
    extAuthLogin:         z.boolean().optional(),
    extPipelining:        z.boolean().optional(),
    extSize:              z.boolean().optional(),
    ext8bitmime:          z.boolean().optional(),
    extEnhancedStatus:    z.boolean().optional(),
    // Not accepted (ignored by the SMTP server): extAuthCramMd5 (not implemented),
    // extSmtputf8 / extDsn / extChunking (SMTP_EXT_* environment variables).
    // Local delivery
    localDeliveryEnabled: z.boolean().optional(),
    // Banner
    bannerOverride:       z.boolean().optional(),
    bannerText:           z.string().max(255).optional(),
    // Relaying — accepted for backwards compatibility only: the SMTP server
    // implements no open/IP-based relaying (port 25 accepts local recipients,
    // relaying needs SMTP AUTH on 465/587). Not shown in the BCP.
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
    smarthostUsername:        z.string().max(255).optional(),
    smarthostPassword:        z.string().max(255).optional(),
    // Accepted for backwards compatibility only: outbound mail is not scanned
    // (no outbound filter stage exists). Not shown in the BCP.
    outboundFilterEnabled:    z.boolean().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const data = { ...parsed.data } as Record<string, unknown>;

  // Do not write the masked password to the DB
  // v6 write-only semantics: masked or empty = keep the stored password
  if (data['smarthostPassword'] === '••••••••' || data['smarthostPassword'] === '') {
    delete data['smarthostPassword'];
  }
  if (typeof data['smarthostHost'] === 'string') data['smarthostHost'] = (data['smarthostHost'] as string).trim();

  // Smarthost mode without a host would make every outbound delivery fail.
  if (parsed.data.outboundMode === 'smarthost' || parsed.data.smarthostHost !== undefined) {
    const current = await getOrCreate();
    const mode = parsed.data.outboundMode ?? current.outboundMode;
    const host = (data['smarthostHost'] as string | undefined) ?? current.smarthostHost;
    if (mode === 'smarthost' && !host) {
      res.status(400).json({ error: 'Smarthost-Modus benötigt einen Smarthost-Server' });
      return;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settings = await prisma.smtpSettings.upsert({
    where:  { id: 'singleton' },
    update: data as any,
    create: { id: 'singleton', ...data } as any,
  });

  // Invalidate the SMTP server cache (banner, ESMTP flags, maxSize, outbound
  // smarthost) immediately — takes effect without waiting for the TTL.
  await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ kind: 'smtp' })).catch(() => undefined);
  clearMessageSizeLimitCache(); // 9.4: REST /mail/send uses the new maximum message size at once

  res.json({ ...settings, smarthostPassword: settings.smarthostPassword ? '••••••••' : '' });
});

// POST /admin/smtp-config/test-smarthost
// Tests the connection to a smarthost without saving
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
    // Same TLS/auth rules as the real delivery; empty password = the stored one.
    const stored = await prisma.smtpSettings.findUnique({
      where:  { id: 'singleton' },
      select: { smarthostUsername: true, smarthostPassword: true },
    }).catch(() => null);
    const transporter = nodemailer.createTransport(
      smarthostTestOptions({ host, port, tls, implicitTls, username, password }, stored) as Parameters<typeof nodemailer.createTransport>[0],
    );

    await transporter.verify();
    res.json({ ok: true, message: `Verbindung zu ${host}:${port} erfolgreich` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ ok: false, message: msg });
  }
});
