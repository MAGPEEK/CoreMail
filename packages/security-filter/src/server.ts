/**
 * Security Filter HTTP Service
 * Exposes the pipeline as a REST API consumed by smtp-server and other modules.
 */
import express from 'express';
import { createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { connectDatabase, prisma } from '@coremail/storage';
import {
  runConnectionChecks,
  runContentChecks,
  type PipelineConfig,
  type ConnectionContext,
} from './pipeline/index.js';

const log = createLogger('security-filter:server');
const app = express();
app.use(express.json({ limit: '52mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '52mb' }));

// Shared pipeline config (loaded from DB on startup, reloaded via Redis)
let pipelineConfig: PipelineConfig = {
  greylistingEnabled: true,
  rspamdEnabled:      true,
  clamavEnabled:      true,
  spamScoreJunk:      3.0,
  spamScoreReject:    6.0,
};

/**
 * Loads SecuritySettings from DB and merges them into pipelineConfig.
 * Called on startup and on Redis settings:reload event.
 */
async function loadSecuritySettings(): Promise<void> {
  try {
    const s = await prisma.securitySettings.findUnique({ where: { id: 'singleton' } });
    if (!s) return;
    pipelineConfig = {
      ...pipelineConfig,
      greylistingEnabled: s.greylistEnabled,
      rspamdEnabled:      s.rspamdEnabled,
      clamavEnabled:      s.clamavEnabled,
      spamScoreJunk:      s.rspamdSpamScore,
      spamScoreReject:    s.rspamdRejectScore,
    };
    log.info(
      { rspamdEnabled: s.rspamdEnabled, clamavEnabled: s.clamavEnabled },
      'Security settings loaded from DB',
    );
  } catch (err) {
    log.warn({ err }, 'Failed to load security settings from DB — using defaults');
  }
}

/**
 * POST /check/connection
 * Called before MAIL FROM is accepted. Checks DNSBL, Greylisting, GeoIP.
 */
app.post('/check/connection', async (req, res) => {
  const ctx = req.body as ConnectionContext;
  if (!ctx?.senderIp || !ctx?.mailFrom || !ctx?.rcptTo) {
    res.status(400).json({ error: 'Missing senderIp, mailFrom, or rcptTo' });
    return;
  }

  try {
    const result = await runConnectionChecks(ctx, pipelineConfig);
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
// Führt DNS-Poisoning-Integritätscheck durch (für Admin-Panel).
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

  // DNS-Hardening initialisieren (trusted resolvers + Integrity-Check)
  try {
    const { initDnsHardening } = await import('./dns-hardened.js');
    await initDnsHardening();
  } catch (err) {
    log.warn({ err }, 'DNS hardening init failed (non-fatal) — using system resolver');
  }

  // DNSBL-Zonen seeden falls Tabelle noch leer
  try {
    const { seedDnsblZonesIfEmpty } = await import('./dnsbl/index.js');
    await seedDnsblZonesIfEmpty();
  } catch (err) {
    log.warn({ err }, 'DNSBL zone seeding failed (non-fatal)');
  }
  app.listen(PORT, () => {
    log.info({ port: PORT }, 'Security filter service started');
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
