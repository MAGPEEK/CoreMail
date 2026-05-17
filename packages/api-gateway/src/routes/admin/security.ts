import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createConnection } from 'node:net';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../../middleware/auth.js';

export const adminSecurityRouter: RouterType = Router();
adminSecurityRouter.use(requireAuth);

const RSPAMD_URL  = process.env['RSPAMD_URL']  ?? 'http://rspamd:11334';
const CLAMAV_HOST = process.env['CLAMAV_HOST'] ?? 'clamav';
const CLAMAV_PORT = parseInt(process.env['CLAMAV_PORT'] ?? '3310', 10);

// ── helpers ──────────────────────────────────────────────────────────────────

async function rspamdFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(`${RSPAMD_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`rspamd HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function checkClamAV(): Promise<{ version: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(CLAMAV_PORT, CLAMAV_HOST);
    let buf = '';
    const t = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 4000);
    socket.on('connect', () => socket.write('VERSION\n'));
    socket.on('data',    (c) => { buf += c.toString(); });
    socket.on('end',     () => { clearTimeout(t); resolve({ version: buf.trim() }); });
    socket.on('error',   (e) => { clearTimeout(t); reject(e); });
  });
}

async function getOrCreateSettings() {
  return prisma.securitySettings.upsert({
    where:  { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });
}

// ── GET /admin/security/settings ─────────────────────────────────────────────
adminSecurityRouter.get('/settings', async (_req: Request, res: Response) => {
  const settings = await getOrCreateSettings();
  res.json(settings);
});

// ── PUT /admin/security/settings ─────────────────────────────────────────────
adminSecurityRouter.put('/settings', async (req: Request, res: Response) => {
  const schema = z.object({
    greylistEnabled:      z.boolean().optional(),
    greylistWaitSec:      z.number().int().min(60).max(3600).optional(),
    greylistTtlHours:     z.number().int().min(1).max(168).optional(),
    dnsblEnabled:         z.boolean().optional(),
    dnsblZones:           z.array(z.string().min(3)).optional(),
    geoipMode:            z.enum(['DISABLED', 'WHITELIST', 'BLACKLIST']).optional(),
    geoipCountries:       z.array(z.string().length(2)).optional(),
    attachmentEnabled:    z.boolean().optional(),
    attachmentMaxSizeMb:  z.number().int().min(1).max(500).optional(),
    attachmentBlockedExt: z.array(z.string()).optional(),
    rspamdEnabled:        z.boolean().optional(),
    rspamdGreylistScore:  z.number().min(0).max(100).optional(),
    rspamdSpamScore:      z.number().min(0).max(100).optional(),
    rspamdRejectScore:    z.number().min(0).max(100).optional(),
    clamavEnabled:        z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settings = await prisma.securitySettings.upsert({
    where:  { id: 'singleton' },
    update: parsed.data as any,
    create: { id: 'singleton', ...parsed.data } as any,
  });

  // Sync thresholds to rspamd controller if score values changed
  if (
    parsed.data.rspamdGreylistScore !== undefined ||
    parsed.data.rspamdSpamScore     !== undefined ||
    parsed.data.rspamdRejectScore   !== undefined
  ) {
    try {
      await rspamdFetch('/saveactions', {
        method: 'POST',
        body: JSON.stringify([
          { reject:       settings.rspamdRejectScore },
          { 'add header': settings.rspamdSpamScore   },
          { greylist:     settings.rspamdGreylistScore },
        ]),
      });
    } catch {
      // non-fatal — rspamd may not be running yet
    }
  }

  res.json(settings);
});

// ── GET /admin/security/status ────────────────────────────────────────────────
adminSecurityRouter.get('/status', async (_req: Request, res: Response) => {
  // /ping benötigt keine Auth und liefert immer "pong" zurück
  async function pingRspamd(): Promise<void> {
    const r = await fetch(`${RSPAMD_URL}/ping`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`rspamd HTTP ${r.status}`);
    const text = await r.text();
    if (!text.includes('pong')) throw new Error('unexpected response');
  }

  const [rspamdResult, clamavResult] = await Promise.allSettled([
    pingRspamd(),
    checkClamAV(),
  ]);

  res.json({
    rspamd: rspamdResult.status === 'fulfilled'
      ? { online: true }
      : { online: false, error: String((rspamdResult.reason as Error).message) },
    clamav: clamavResult.status === 'fulfilled'
      ? { online: true,  ...clamavResult.value }
      : { online: false, error: String((clamavResult.reason as Error).message) },
  });
});

// ── GET /admin/security/rspamd/stat ──────────────────────────────────────────
adminSecurityRouter.get('/rspamd/stat', async (_req: Request, res: Response) => {
  try {
    const data = await rspamdFetch<Record<string, unknown>>('/stat');
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: String((e as Error).message) });
  }
});

// ── GET /admin/security/rspamd/symbols ───────────────────────────────────────
adminSecurityRouter.get('/rspamd/symbols', async (_req: Request, res: Response) => {
  try {
    const data = await rspamdFetch<Record<string, unknown>>('/symbols');
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: String((e as Error).message) });
  }
});

// ── GET /admin/security/rspamd/history ───────────────────────────────────────
adminSecurityRouter.get('/rspamd/history', async (_req: Request, res: Response) => {
  try {
    const data = await rspamdFetch<Record<string, unknown>>('/history');
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: String((e as Error).message) });
  }
});

// ── POST /admin/security/rspamd/learn/:type ───────────────────────────────────
adminSecurityRouter.post('/rspamd/learn/:type', async (req: Request, res: Response) => {
  const { type } = req.params as { type: string };
  if (type !== 'spam' && type !== 'ham') { res.status(400).json({ error: 'type must be spam or ham' }); return; }
  try {
    const endpoint = type === 'spam' ? '/learnspam' : '/learnham';
    const data = await rspamdFetch<Record<string, unknown>>(endpoint, {
      method: 'POST',
      body:   JSON.stringify(req.body),
    });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: String((e as Error).message) });
  }
});
