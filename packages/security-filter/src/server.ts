/**
 * Security Filter HTTP Service
 * Exposes the pipeline as a REST API consumed by smtp-server and other modules.
 */
import express from 'express';
import { createLogger } from '@coremail/core';
import { connectDatabase } from '@coremail/storage';
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

// Shared pipeline config (loaded from DB on startup, reloaded periodically)
let pipelineConfig: PipelineConfig = {
  greylistingEnabled: true,
  spamScoreJunk: 3.0,
  spamScoreReject: 6.0,
};

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

const PORT = parseInt(process.env['PORT'] ?? '3002', 10);

async function main() {
  await connectDatabase();
  app.listen(PORT, () => {
    log.info({ port: PORT }, 'Security filter service started');
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
