/**
 * Security Filter HTTP Service
 * Exposes the pipeline as a REST API consumed by smtp-server and other modules.
 */
import { initRuntimeLogLevel } from '@coremail/core';
import express from 'express';
import {
  createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD,
  installProcessGuards, installAsyncErrorHandling, errorMiddleware, resolveBindHost,
} from '@coremail/core';
import { connectDatabase, prisma } from '@coremail/storage';
import {
  runContentChecks,
  runMalwareChecks,
  runGreylistCheck,
  runIpChecks,
  runSenderListCheck,
  type PipelineConfig,
  type PipelineResult,
  type ConnectionContext,
} from './pipeline/index.js';
import { parseConnectionRequest, runConnectionStage } from './connection-request.js';
import { parseContentContext, contentErrorResult } from './content-request.js';
import { buildPipelineConfig } from './settings.js';
import { invalidateGreylistOptsCache } from './greylisting/index.js';
import { registerClamavRoutes } from './clamav/routes.js';
import { CapabilityMonitor, defaultDetector, applyScannerCapabilities, checkIntervalMs } from './capabilities.js';

const log = createLogger('security-filter:server');
installProcessGuards(log);
installAsyncErrorHandling(express);
const app = express();
app.use(express.json({ limit: '52mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '52mb' }));

// Shared pipeline config (loaded from DB on startup, reloaded via Redis).
// Mapping + defaults: settings.ts (defaults = schema defaults).
let pipelineConfig: PipelineConfig = buildPipelineConfig(null, null);

// 9.3: is rspamd / ClamAV deployed at all? (capabilities.ts) — absent scanners
// are skipped by the pipeline and hidden in the BCP.
const capabilities = new CapabilityMonitor(defaultDetector());

/** The pipeline config with absent scanners switched off. */
function effectiveConfig(): PipelineConfig {
  return applyScannerCapabilities(pipelineConfig, capabilities.get());
}

/**
 * Loads SecuritySettings + the greylisting switch from SmtpSettings and
 * rebuilds pipelineConfig. Called on startup and on every settings:reload.
 * On a DB error the previous config stays in effect.
 */
async function loadSecuritySettings(): Promise<void> {
  try {
    const [sec, smtp] = await Promise.all([
      prisma.securitySettings.findUnique({ where: { id: 'singleton' } }),
      prisma.smtpSettings.findUnique({ where: { id: 'singleton' }, select: { greylistingEnabled: true } }),
    ]);
    pipelineConfig = buildPipelineConfig(sec, smtp);
    invalidateGreylistOptsCache();
    log.info(
      {
        greylisting: pipelineConfig.greylistingEnabled, dnsbl: pipelineConfig.dnsblEnabled,
        geoip: pipelineConfig.countryFilter?.mode ?? 'disabled', attachments: pipelineConfig.attachmentEnabled,
        clamav: pipelineConfig.clamavEnabled, clamavAction: pipelineConfig.clamavAction, rspamd: pipelineConfig.rspamdEnabled,
        localSpoof: pipelineConfig.localSpoof?.action,
      },
      'Security settings loaded from DB',
    );
  } catch (err) {
    log.warn({ err }, 'Failed to load security settings from DB — keeping previous config');
  }
}

/**
 * POST /check/connection
 * Body: { senderIp, stage?: 'connect'|'rcpt'|'full', mailFrom?, rcptTo? }
 *  - connect (TCP connect, only the IP is known): DNSBL/DNSWL + GeoIP
 *  - rcpt    (RCPT TO, full triple known):        sender lists of the recipient, greylisting
 *  - full    (legacy, all fields):                greylisting + IP checks
 */
app.post('/check/connection', async (req, res) => {
  const parsed = parseConnectionRequest(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const result = await runConnectionStage(parsed.stage, parsed.ctx, effectiveConfig(), {
      ipChecks: runIpChecks,
      greylist: runGreylistCheck,
      senderList: (ctx) => runSenderListCheck(ctx),
    });
    res.json(result);
  } catch (err) {
    log.error({ err }, 'Connection check error');
    // Fail open — do not block mail on internal errors
    res.json({ action: 'accept', reason: 'Internal error — failing open' });
  }
});

/**
 * Handler for a content-stage endpoint: X-Filter-Context header (JSON) + raw
 * message body (application/octet-stream). An internal error answers the
 * failure policy of content-request.ts (default: defer).
 */
function contentStageHandler(
  label: string,
  run: (raw: Buffer, ctx: ConnectionContext, config: PipelineConfig) => Promise<PipelineResult>,
): express.RequestHandler {
  return async (req, res) => {
    const ctxHeader = req.headers['x-filter-context'];
    if (!ctxHeader || typeof ctxHeader !== 'string') {
      res.status(400).json({ error: 'Missing X-Filter-Context header' });
      return;
    }

    const ctx: ConnectionContext | null = parseContentContext(ctxHeader);
    if (!ctx) {
      res.status(400).json({ error: 'Invalid X-Filter-Context (JSON object with a valid senderIp required)' });
      return;
    }

    const rawMessage = req.body as Buffer;
    if (!Buffer.isBuffer(rawMessage) || rawMessage.length === 0) {
      res.status(400).json({ error: 'Missing raw message body' });
      return;
    }

    try {
      res.json(await run(rawMessage, ctx, effectiveConfig()));
    } catch (err) {
      const fallback = contentErrorResult();
      log.error({ err, action: fallback.action }, `${label} error`);
      res.json(fallback);
    }
  };
}

/**
 * POST /check/content
 * Called after DATA. Checks SPF/DKIM/DMARC, blacklist, attachments, ClamAV, rspamd.
 */
app.post('/check/content', contentStageHandler('Content check', (raw, ctx, cfg) => runContentChecks(raw, ctx, cfg)));

/**
 * POST /check/malware
 * Attachment filter + ClamAV only (same failure policy) — for mail the SMTP
 * server relays for trusted devices without SMTP AUTH (device relay).
 */
app.post('/check/malware', contentStageHandler('Malware check', (raw, ctx, cfg) => runMalwareChecks(raw, ctx, cfg)));

/**
 * POST /learn/spam — forward message to rspamd for Bayes training
 */
app.post('/learn/spam', async (req, res) => {
  if (capabilities.get().rspamd.state === 'absent') { res.json({ ok: true, skipped: 'rspamd not deployed' }); return; }
  const { learnSpam } = await import('./rspamd/index.js');
  await learnSpam(req.body as Buffer);
  res.json({ ok: true });
});

app.post('/learn/ham', async (req, res) => {
  if (capabilities.get().rspamd.state === 'absent') { res.json({ ok: true, skipped: 'rspamd not deployed' }); return; }
  const { learnHam } = await import('./rspamd/index.js');
  await learnHam(req.body as Buffer);
  res.json({ ok: true });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'security-filter' });
});

// ClamAV status + EICAR self-test for the BCP (clamav/routes.ts)
registerClamavRoutes(app, effectiveConfig);

/**
 * GET /capabilities — deployment state of rspamd and ClamAV (capabilities.ts),
 * proxied by the api-gateway as /api/v1/admin/security/capabilities. Re-checked
 * when the cached state is older than 30 s (the BCP shows a starting ClamAV
 * as soon as it answers). No host names, URLs or credentials in the reply.
 */
app.get('/capabilities', async (_req, res) => {
  res.json(await capabilities.ensureFresh(30_000));
});

// ── GET /dns-integrity ────────────────────────────────────────────────────────
// Runs the DNS-poisoning integrity check (for the admin panel).
app.get('/dns-integrity', async (_req, res) => {
  try {
    const { runDnsIntegrityCheck, getDnsHardeningStatus } = await import('./dns-hardened.js');
    const [results, status] = await Promise.all([
      runDnsIntegrityCheck(),
      getDnsHardeningStatus(),
    ]);
    const anyPoisoning = results.some((r) => r.poisoningSuspected);
    res.json({ status, results, anyPoisoning, checkedAt: new Date().toISOString() });
  } catch (err) {
    log.error({ err }, 'DNS integrity check failed');
    res.status(500).json({ error: String(err) });
  }
});

const PORT = parseInt(process.env['PORT'] ?? '3002', 10);

async function main() {
  await connectDatabase();
  void initRuntimeLogLevel('security-filter', { aliases: [] }); // BCP per-service log level

  // Load security settings from DB
  await loadSecuritySettings();

  // Scanner deployment detection (bounded: DNS + ping timeouts of 3 s each)
  await capabilities.refresh().catch((err: unknown) => log.warn({ err }, 'Scanner detection failed'));
  capabilities.start(checkIntervalMs());

  // Subscribe to settings:reload for hot-reload of rspamdEnabled / clamavEnabled
  try {
    const sub = getRedisClient().duplicate();
    await sub.subscribe(CHANNEL_SETTINGS_RELOAD);
    sub.on('message', (_ch, _msg) => {
      log.info('Security settings reload triggered via Redis');
      void loadSecuritySettings();
    });
  } catch (err) {
    log.warn({ err }, 'Redis subscription failed — security settings will not hot-reload');
  }

  // Initialize DNS hardening (trusted resolvers + integrity check)
  try {
    const { initDnsHardening } = await import('./dns-hardened.js');
    await initDnsHardening();
  } catch (err) {
    log.warn({ err }, 'DNS hardening init failed (non-fatal) — using system resolver');
  }

  // Seed DNSBL zones if the table is still empty
  try {
    const { seedDnsblZonesIfEmpty } = await import('./dnsbl/index.js');
    await seedDnsblZonesIfEmpty();
  } catch (err) {
    log.warn({ err }, 'DNSBL zone seeding failed (non-fatal)');
  }
  // v6: shared error middleware (registered last)
  app.use(errorMiddleware(log));

  // v6: internal service (smtp-server / api-gateway) — loopback by default
  const host = resolveBindHost();
  app.listen(PORT, host, () => {
    log.info({ port: PORT, host }, 'Security filter service started');
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
