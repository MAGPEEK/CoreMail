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
  runGreylistCheck,
  runIpChecks,
  type PipelineConfig,
  type ConnectionContext,
} from './pipeline/index.js';
import { parseConnectionRequest, runConnectionStage } from './connection-request.js';
import { buildPipelineConfig } from './settings.js';
import { invalidateGreylistOptsCache } from './greylisting/index.js';

const log = createLogger('security-filter:server');
installProcessGuards(log);
installAsyncErrorHandling(express);
const app = express();
app.use(express.json({ limit: '52mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '52mb' }));

// Shared pipeline config (loaded from DB on startup, reloaded via Redis).
// Mapping + defaults: settings.ts (defaults = schema defaults).
let pipelineConfig: PipelineConfig = buildPipelineConfig(null, null);

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
 *  - rcpt    (RCPT TO, full triple known):        greylisting
 *  - full    (legacy, all fields):                greylisting + IP checks
 */
app.post('/check/connection', async (req, res) => {
  const parsed = parseConnectionRequest(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const result = await runConnectionStage(parsed.stage, parsed.ctx, pipelineConfig, {
      ipChecks: runIpChecks,
      greylist: runGreylistCheck,
    });
    res.json(result);
  } catch (err) {
    log.error({ err }, 'Connection check error');
    // Fail open — do not block mail on internal errors
    res.json({ action: 'accept', reason: 'Internal error — failing open' });
  }
});

/**
 * POST /check/content
 * Called after DATA. Checks SPF/DKIM/DMARC, blacklist, attachments, ClamAV, rspamd.
 * Body: multipart — JSON context + raw message binary
 */
app.post('/check/content', async (req, res) => {
  const ctxHeader = req.headers['x-filter-context'];
  if (!ctxHeader || typeof ctxHeader !== 'string') {
    res.status(400).json({ error: 'Missing X-Filter-Context header' });
    return;
  }

  let ctx: ConnectionContext;
  try {
    ctx = JSON.parse(ctxHeader) as ConnectionContext;
  } catch {
    res.status(400).json({ error: 'Invalid X-Filter-Context JSON' });
    return;
  }

  const rawMessage = req.body as Buffer;
  if (!Buffer.isBuffer(rawMessage) || rawMessage.length === 0) {
    res.status(400).json({ error: 'Missing raw message body' });
    return;
  }

  try {
    const result = await runContentChecks(rawMessage, ctx, pipelineConfig);
    res.json(result);
  } catch (err) {
    log.error({ err }, 'Content check error');
    res.json({ action: 'accept', reason: 'Internal error — failing open' });
  }
});

/**
 * POST /learn/spam — forward message to rspamd for Bayes training
 */
app.post('/learn/spam', async (req, res) => {
  const { learnSpam } = await import('./rspamd/index.js');
  await learnSpam(req.body as Buffer);
  res.json({ ok: true });
});

app.post('/learn/ham', async (req, res) => {
  const { learnHam } = await import('./rspamd/index.js');
  await learnHam(req.body as Buffer);
  res.json({ ok: true });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'security-filter' });
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
