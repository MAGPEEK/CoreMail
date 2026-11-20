/**
 * Admin API: server settings / virtual directories
 *
 * GET  /api/v1/admin/servers/settings  — read current settings
 * PUT  /api/v1/admin/servers/settings  — save settings
 * POST /api/v1/admin/servers/settings/derive — derive URLs automatically from hostname
 * GET  /api/v1/admin/servers/health  — reachability of the services + PostgreSQL/Redis/storage
 * GET  /api/v1/admin/servers/restart — can this gateway restart the container? (10.4.2)
 * POST /api/v1/admin/servers/restart — restart the coremail container (10.4.2, lib/server-restart.ts)
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, peekStorageHealth, withProtocolAccessChange } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { deriveServerUrls } from '../../lib/server-urls.js';
import { publicServerSettings } from '../../lib/secrets.js';
import { collectHealth, tcpProbe } from '../../lib/service-health.js';
import { requireUnscoped } from '../../middleware/admin-scope.js';
import { auditNow, auditContext, type AuditEntry } from '../../lib/audit.js';
import {
  createRestartCooldown, restartAvailability, writeRestartRequest,
  EXPECTED_DOWNTIME_SECONDS, RESTART_COOLDOWN_SECONDS, RESTART_DELAY_MS,
  type CooldownClaim, type RestartAvailability,
} from '../../lib/server-restart.js';

const log = createLogger('admin:servers');
export const adminServersRouter: RouterType = Router();
adminServersRouter.use(requireArea('servers'));

// 9.2: host names end up in the SMTP greeting/EHLO, the client setup data and
// the derived URLs — a value like "bad host!" used to be stored as is.
// RFC 1123 labels; a single label (localhost) and IPv4 literals pass.
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const hostnameSchema = z.string().trim().regex(HOSTNAME_RE, 'Invalid host name');

const SettingsSchema = z.object({
  publicHostname:   hostnameSchema,
  useHttps:         z.boolean(),
  httpPort:         z.number().int().min(1).max(65535),
  owaUrl:           z.string().url(),
  easUrl:           z.string().url(),
  autodiscoverBase: z.string().url(),
  imapHost:         hostnameSchema,
  imapPort:         z.number().int().min(1).max(65535),
  imapSsl:          z.boolean(),
  pop3Host:         hostnameSchema,
  pop3Port:         z.number().int().min(1).max(65535),
  pop3Ssl:          z.boolean(),
  smtpHost:         hostnameSchema,
  smtpPort:         z.number().int().min(1).max(65535),
  smtpTls:          z.boolean(),
  orgName:          z.string().min(1),
  // v7.0.0: ewsUrl + the EWS on/off switch were removed with EWS. zod strips
  // unknown keys, so older BCP builds that still send them can save.
  // v5.7.1: JMAP (RFC 8620/8621) on/off — default on
  // 9.4: = the server level of the JMAP protocol switch (/admin/protocol-access)
  jmapEnabled:      z.boolean().optional(),
});

// GET /api/v1/admin/servers/settings
adminServersRouter.get('/settings', async (_req: Request, res: Response) => {
  try {
    const settings = await prisma.serverSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });
    res.json(publicServerSettings(settings));
  } catch (err) {
    log.error({ err }, 'Failed to read server settings');
    res.status(500).json({ error: 'Internal server error' });
  }
});

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// PUT /api/v1/admin/servers/settings
adminServersRouter.put('/settings', async (req: Request, res: Response) => {
  // v6: partial updates — fields that are omitted keep their stored value
  // (the CLI sends only the changed field; secrets are never part of this API).
  const partial = SettingsSchema.partial().safeParse(req.body);
  if (!partial.success) {
    res.status(400).json({ error: 'Invalid request', details: partial.error.issues });
    return;
  }
  const current = await prisma.serverSettings.upsert({
    where:  { id: 'singleton' }, create: { id: 'singleton' }, update: {},
  });
  const parsed = SettingsSchema.safeParse({ ...current, ...stripUndefined(partial.data) });
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  try {
    // v3.18.35+36: if the admin only changes publicHostname/useHttps/httpPort
    // without adjusting the derived URLs, they would be stale and
    // Autodiscover would return wrong addresses. We check: does the request
    // contain old mail.local URLs OR do URLs still point to port 8080 although
    // httpPort != 8080? Then auto-derive from publicHostname.
    const requestUrls = [parsed.data.owaUrl, parsed.data.easUrl, parsed.data.autodiscoverBase];
    const hasStaleUrls = requestUrls.some((u) => /mail\.local/i.test(u)) ||
                         (parsed.data.httpPort !== 8080 && requestUrls.some((u) => /:8080/.test(u)));
    if (hasStaleUrls) {
      const derived = deriveServerUrls(parsed.data.publicHostname, parsed.data.useHttps, parsed.data.httpPort);
      parsed.data.owaUrl           = derived.owaUrl;
      parsed.data.easUrl           = derived.easUrl;
      parsed.data.autodiscoverBase = derived.autodiscoverBase;
      log.info({ publicHostname: parsed.data.publicHostname }, 'Auto-derived URLs from publicHostname (stale mail.local detected)');
    }

    // exactOptionalPropertyTypes: undefined must not be passed through to Prisma
    const { jmapEnabled, ...rest } = parsed.data;
    const data = {
      ...rest,
      ...(jmapEnabled !== undefined ? { jmapEnabled } : {}),
    };
    const save = () => prisma.serverSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', ...data },
      update: data,
    });
    // 9.4: jmapEnabled is the server level of the JMAP protocol switch — a change
    // notifies the affected users (their JMAP push connections end).
    const settings = jmapEnabled !== undefined && jmapEnabled !== current.jmapEnabled
      ? (await withProtocolAccessChange({ level: 'global' }, save)).result
      : await save();
    log.info({ hostname: parsed.data.publicHostname, jmapEnabled: settings.jmapEnabled }, 'Server settings updated');

    // Notify SMTP / IMAP / POP3 + autodiscover services to pick up new hostname
    try {
      await getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'hostname' }));
    } catch (pubErr) {
      log.warn({ pubErr }, 'Failed to publish settings reload signal');
    }

    res.json(publicServerSettings(settings));
  } catch (err) {
    log.error({ err }, 'Failed to update server settings');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/admin/servers/settings/derive
// Derive URLs automatically from hostname + port (convenience endpoint for the BCP)
adminServersRouter.post('/settings/derive', async (req: Request, res: Response) => {
  const schema = z.object({
    publicHostname: hostnameSchema,
    useHttps:       z.boolean().default(false),
    httpPort:       z.number().int().min(1).max(65535).default(8080),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const { publicHostname, useHttps, httpPort } = parsed.data;
  // Same derivation as PUT / setup / domain changes (lib/server-urls.ts):
  // mail.example.com → autodiscover.example.com, standard ports omitted.
  const derived = deriveServerUrls(publicHostname, useHttps, httpPort);
  // The BCP merges only the URL fields into its form. The other keys are kept
  // for compatibility; they are suggestions and never stored by this route.
  res.json({
    publicHostname,
    useHttps,
    httpPort,
    ...derived,
    imapPort:         993,
    imapSsl:          true,
    pop3Port:         995,
    pop3Ssl:          true,
    smtpPort:         587,
    smtpTls:          true,
    orgName:          'CoreMail',
  });
});

// GET /api/v1/admin/servers/health — BCP "Health & Status" tab (read access suffices)
adminServersRouter.get('/health', async (_req: Request, res: Response) => {
  const report = await collectHealth({
    listenerPorts: async () => {
      const rows = await prisma.serviceListener.findMany({
        where: { active: true, service: { in: ['SMTP_RECEIVE', 'IMAP', 'POP3'] } },
        select: { service: true, port: true, address: true },
      });
      const out: Record<'SMTP_RECEIVE' | 'IMAP' | 'POP3', Array<{ port: number; address: string }>> = { SMTP_RECEIVE: [], IMAP: [], POP3: [] };
      for (const r of rows) if (r.service in out) out[r.service as keyof typeof out].push({ port: r.port, address: r.address });
      return out;
    },
    probe: (host, port) => tcpProbe(host, port),
    db: async () => { await prisma.$queryRaw`SELECT 1`; },
    redis: async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const pong = await Promise.race([
          getRedisClient().ping(),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 1500); }),
        ]);
        if (pong !== 'PONG') throw new Error('unexpected reply');
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    storage: () => {
      const s = peekStorageHealth();
      return s ? { driver: s.driver, status: s.status, blocking: s.blocking } : null;
    },
  });
  res.set('Cache-Control', 'no-store').json(report);
});

// ── Container restart (10.4.2) ───────────────────────────────────────────────
// Area servers (write: ORGANIZATION_MANAGEMENT, SERVER_MANAGEMENT; the router
// guard also enforces admin MFA) + requireUnscoped: a domain-scoped admin never
// restarts the server. Mechanism and order: lib/server-restart.ts.

export interface ServerRestartDeps {
  availability: () => RestartAvailability;
  claim: () => Promise<CooldownClaim>;
  release: () => Promise<void>;
  writeAudit: (entry: AuditEntry) => Promise<void>;
  trigger: () => void;
  delayMs: number;
  schedule: (fn: () => void, ms: number) => void;
}

const restartCooldown = createRestartCooldown();
const defaultRestartDeps: ServerRestartDeps = {
  availability: () => restartAvailability(),
  claim: () => restartCooldown.claim(),
  release: () => restartCooldown.release(),
  writeAudit: auditNow,
  trigger: () => {
    log.warn('Container restart: handing the restart request to restart-watch');
    try {
      writeRestartRequest();
    } catch (err) {
      log.error({ err }, 'Container restart: the restart request could not be written — nothing restarts');
      return;
    }
    // Still alive long after the request → the listener did not act (logged for the operator).
    setTimeout(() => log.error('Container restart was requested 60 s ago but this process is still running — is the supervisord event listener "restart-watch" running?'), 60_000).unref();
  },
  delayMs: RESTART_DELAY_MS,
  schedule: (fn, ms) => { setTimeout(fn, ms); },
};
let restartDeps: ServerRestartDeps = defaultRestartDeps;

/** Test seam: replaces parts of the restart dependencies (no argument = defaults). */
export function setServerRestartDeps(deps?: Partial<ServerRestartDeps>): void {
  restartDeps = deps ? { ...defaultRestartDeps, ...deps } : defaultRestartDeps;
}

// GET /api/v1/admin/servers/restart — read access suffices (the card is shown read-only)
adminServersRouter.get('/restart', (_req: Request, res: Response) => {
  const a = restartDeps.availability();
  res.set('Cache-Control', 'no-store').json({
    ...a,
    expectedDowntimeSeconds: EXPECTED_DOWNTIME_SECONDS,
    cooldownSeconds: RESTART_COOLDOWN_SECONDS,
  });
});

// POST /api/v1/admin/servers/restart
adminServersRouter.post('/restart', requireUnscoped, async (req: Request, res: Response) => {
  const deps = restartDeps;
  const a = deps.availability();
  if (!a.available) {
    res.status(409).json({
      error: a.reason === 'no-listener'
        ? 'The restart listener (restart-watch) is not running in this container — nothing was restarted'
        : 'This gateway does not run inside the CoreMail container — restart it with your container tooling',
      code: 'RESTART_UNAVAILABLE',
      reason: a.reason,
    });
    return;
  }
  const slot = await deps.claim();
  if (!slot.ok) {
    res.setHeader('Retry-After', String(slot.retryAfterSec));
    res.status(429).json({ error: 'A restart was requested recently — please wait', code: 'RATE_LIMITED', retryAfter: slot.retryAfterSec });
    return;
  }
  const user = req.apiUser!;
  try {
    // Written BEFORE anything stops — no audit row, no restart.
    await deps.writeAudit({
      actorId: user.userId,
      actorEmail: user.email,
      action: 'server.restart',
      targetType: 'server',
      targetName: 'coremail container',
      changes: { expectedDowntimeSeconds: EXPECTED_DOWNTIME_SECONDS },
      ...auditContext(req),
    });
  } catch (err) {
    log.error({ err }, 'Container restart refused: the audit entry could not be written');
    await deps.release();
    res.status(503).json({ error: 'The restart could not be recorded in the audit log — nothing was restarted', code: 'AUDIT_UNAVAILABLE' });
    return;
  }
  log.warn({ actor: user.email }, 'Container restart requested');

  // Trigger only after the 202 has left (finish), or when the client went away.
  let scheduled = false;
  const go = () => {
    if (scheduled) return;
    scheduled = true;
    deps.schedule(() => deps.trigger(), deps.delayMs);
  };
  res.once('finish', go);
  res.once('close', go);
  res.status(202).json({ restarting: true, expectedDowntimeSeconds: EXPECTED_DOWNTIME_SECONDS });
});
