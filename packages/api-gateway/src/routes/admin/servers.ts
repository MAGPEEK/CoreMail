/**
 * Admin API: server settings / virtual directories
 *
 * GET  /api/v1/admin/servers/settings  — read current settings
 * PUT  /api/v1/admin/servers/settings  — save settings
 * POST /api/v1/admin/servers/settings/derive — derive URLs automatically from hostname
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';
import { createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { deriveServerUrls } from '../../lib/server-urls.js';

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
  // v5.7.0: MAPI over HTTP optional (default off). Optional in the request so
  // that older BCP builds without the field can still save.
  mapiHttpEnabled:  z.boolean().optional(),
  // v5.7.1: JMAP (RFC 8620/8621) on/off — default on
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
    // v3.18.35+36: if the admin only changes publicHostname/useHttps/httpPort
    // without adjusting the derived URLs, they would be stale and Outlook
    // Autodiscover would return wrong addresses. We check: does the request
    // contain old mail.local URLs OR do URLs still point to port 8080 although
    // httpPort != 8080? Then auto-derive from publicHostname.
    const requestUrls = [parsed.data.ewsUrl, parsed.data.owaUrl, parsed.data.easUrl, parsed.data.autodiscoverBase];
    const hasStaleUrls = requestUrls.some((u) => /mail\.local/i.test(u)) ||
                         (parsed.data.httpPort !== 8080 && requestUrls.some((u) => /:8080/.test(u)));
    if (hasStaleUrls) {
      const derived = deriveServerUrls(parsed.data.publicHostname, parsed.data.useHttps, parsed.data.httpPort);
      parsed.data.ewsUrl           = derived.ewsUrl;
      parsed.data.owaUrl           = derived.owaUrl;
      parsed.data.easUrl           = derived.easUrl;
      parsed.data.autodiscoverBase = derived.autodiscoverBase;
      log.info({ publicHostname: parsed.data.publicHostname }, 'Auto-derived URLs from publicHostname (stale mail.local detected)');
    }

    // exactOptionalPropertyTypes: undefined must not be passed through to Prisma
    const { mapiHttpEnabled, jmapEnabled, ...rest } = parsed.data;
    const data = {
      ...rest,
      ...(mapiHttpEnabled !== undefined ? { mapiHttpEnabled } : {}),
      ...(jmapEnabled !== undefined ? { jmapEnabled } : {}),
    };
    const settings = await prisma.serverSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', ...data },
      update: data,
    });
    log.info({ hostname: parsed.data.publicHostname, mapiHttpEnabled: settings.mapiHttpEnabled, jmapEnabled: settings.jmapEnabled }, 'Server settings updated');

    // Notify SMTP / IMAP / POP3 + autodiscover services to pick up new hostname
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
// Derive URLs automatically from hostname + port (convenience endpoint for ECP)
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
  // Omit the standard port (443 for https, 80 for http)
  const portSuffix = (useHttps && httpPort === 443) || (!useHttps && httpPort === 80)
    ? ''
    : `:${httpPort}`;
  const base = `${proto}://${publicHostname}${portSuffix}`;

  // Autodiscover MUST run on its own CNAME (Microsoft Exchange spec):
  // Outlook ALWAYS checks `autodiscover.{primary-domain}` first.
  // Hostname `mail.stefanwuestner.de` → autodiscover host `autodiscover.stefanwuestner.de`
  // Hostname `stefanwuestner.de` (no subdomain) → `autodiscover.stefanwuestner.de`
  // If the hostname already starts with `autodiscover.` → unchanged
  const autodiscoverHost = (() => {
    if (publicHostname.startsWith('autodiscover.')) return publicHostname;
    const labels = publicHostname.split('.');
    // ≥ 3 labels → strip the first subdomain (mail.stefanwuestner.de → stefanwuestner.de)
    // ≤ 2 labels → use the root domain directly
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
