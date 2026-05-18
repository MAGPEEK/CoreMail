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
    rspamdEnabled:             z.boolean().optional(),
    rspamdGreylistScore:       z.number().min(0).max(100).optional(),
    rspamdSpamScore:           z.number().min(0).max(100).optional(),
    rspamdRejectScore:         z.number().min(0).max(100).optional(),
    rspamdAutolearn:           z.boolean().optional(),
    rspamdAutolearnSpam:       z.number().min(0).max(100).optional(),
    rspamdAutolearnHam:        z.number().min(-10).max(0).optional(),
    rspamdAddSpamHeader:       z.boolean().optional(),
    rspamdExtendedHeaders:     z.boolean().optional(),
    rspamdRewriteSubject:      z.boolean().optional(),
    rspamdSubjectTag:          z.string().max(32).optional(),
    rspamdPhishingEnabled:     z.boolean().optional(),
    rspamdFuzzyEnabled:        z.boolean().optional(),
    rspamdUrlEnabled:          z.boolean().optional(),
    rspamdMxCheckEnabled:      z.boolean().optional(),
    clamavEnabled:             z.boolean().optional(),
    clamavAction:              z.enum(['quarantine', 'reject', 'pass']).optional(),
    clamavBlockOnFailure:      z.boolean().optional(),
    clamavScanArchives:        z.boolean().optional(),
    clamavScanHtml:            z.boolean().optional(),
    clamavBlockEncryptedArch:  z.boolean().optional(),
    clamavMaxFileSizeMb:       z.number().int().min(1).max(500).optional(),
    clamavMaxScanSizeMb:       z.number().int().min(1).max(2048).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settings = await prisma.securitySettings.upsert({
    where:  { id: 'singleton' },
    update: parsed.data as any,
    create: { id: 'singleton', ...parsed.data } as any,
  });

  // Sync action thresholds to rspamd controller if score values changed
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

  // Sync autolearn thresholds to rspamd if changed
  if (
    parsed.data.rspamdAutolearn    !== undefined ||
    parsed.data.rspamdAutolearnSpam !== undefined ||
    parsed.data.rspamdAutolearnHam  !== undefined
  ) {
    try {
      await rspamdFetch('/config/set', {
        method: 'POST',
        body: JSON.stringify({
          'classifier-bayes': {
            autolearn:                settings.rspamdAutolearn,
            autolearn_spam_threshold: settings.rspamdAutolearnSpam,
            autolearn_ham_threshold:  settings.rspamdAutolearnHam,
          },
        }),
      });
    } catch {
      // non-fatal — rspamd config/set may not be available in all deployments
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

// ═════════════════════════════════════════════════════════════════════════════
// DNSBL Zone Management
// ═════════════════════════════════════════════════════════════════════════════
import { promises as dns } from 'node:dns';

const HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const DnsblActionEnum = z.enum(['REJECT', 'TAG', 'SCORE_ONLY']);

const CreateDnsblZoneSchema = z.object({
  host:        z.string().min(3).max(253).regex(HOST_RE, 'Ungültiger Hostname'),
  name:        z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  enabled:     z.boolean().optional(),
  action:      DnsblActionEnum.optional(),
  weight:      z.number().int().min(0).max(100).optional(),
  isWhitelist: z.boolean().optional(),
  sortOrder:   z.number().int().optional(),
});

const PatchDnsblZoneSchema = CreateDnsblZoneSchema.partial();

// ── GET /admin/security/dnsbl ─────────────────────────────────────────────────
adminSecurityRouter.get('/dnsbl', async (_req: Request, res: Response) => {
  const zones = await prisma.dnsblZone.findMany({
    orderBy: { sortOrder: 'asc' },
  });
  res.json(zones);
});

// ── POST /admin/security/dnsbl ────────────────────────────────────────────────
adminSecurityRouter.post('/dnsbl', async (req: Request, res: Response) => {
  const parsed = CreateDnsblZoneSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }); return; }
  const exists = await prisma.dnsblZone.findUnique({ where: { host: parsed.data.host.toLowerCase() } });
  if (exists) { res.status(409).json({ error: 'Zone existiert bereits' }); return; }
  const data: Record<string, unknown> = {
    host: parsed.data.host.toLowerCase(),
    name: parsed.data.name,
    isBuiltin: false,
  };
  if (parsed.data.description !== undefined) data['description'] = parsed.data.description;
  if (parsed.data.enabled !== undefined)     data['enabled']     = parsed.data.enabled;
  if (parsed.data.action !== undefined)      data['action']      = parsed.data.action;
  if (parsed.data.weight !== undefined)      data['weight']      = parsed.data.weight;
  if (parsed.data.isWhitelist !== undefined) data['isWhitelist'] = parsed.data.isWhitelist;
  if (parsed.data.sortOrder !== undefined)   data['sortOrder']   = parsed.data.sortOrder;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zone = await prisma.dnsblZone.create({ data: data as any });
  res.status(201).json(zone);
});

// ── PATCH /admin/security/dnsbl/:id ───────────────────────────────────────────
adminSecurityRouter.patch('/dnsbl/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = PatchDnsblZoneSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const zone = await prisma.dnsblZone.findUnique({ where: { id } });
  if (!zone) { res.status(404).json({ error: 'Zone nicht gefunden' }); return; }
  // Built-in: nur enabled/action/weight/sortOrder darf geändert werden
  if (zone.isBuiltin) {
    const allowed = ['enabled', 'action', 'weight', 'sortOrder'] as const;
    for (const k of Object.keys(parsed.data)) {
      if (!allowed.includes(k as typeof allowed[number])) {
        res.status(400).json({ error: `Built-in Zonen: nur ${allowed.join(', ')} änderbar` }); return;
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await prisma.dnsblZone.update({ where: { id }, data: parsed.data as any });
  res.json(updated);
});

// ── DELETE /admin/security/dnsbl/:id ──────────────────────────────────────────
adminSecurityRouter.delete('/dnsbl/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const zone = await prisma.dnsblZone.findUnique({ where: { id } });
  if (!zone) { res.status(404).json({ error: 'Zone nicht gefunden' }); return; }
  if (zone.isBuiltin) { res.status(400).json({ error: 'Built-in Zonen können nur deaktiviert, nicht gelöscht werden' }); return; }
  await prisma.dnsblZone.delete({ where: { id } });
  res.json({ ok: true });
});

// ── POST /admin/security/dnsbl/test ───────────────────────────────────────────
// Body: { ip: "1.2.3.4" } → testet die IP gegen ALLE Zonen (auch deaktivierte)
const TestSchema = z.object({ ip: z.string().min(7).max(45) });
adminSecurityRouter.post('/dnsbl/test', async (req: Request, res: Response) => {
  const parsed = TestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'IP erforderlich' }); return; }
  const ip = parsed.data.ip.trim();

  // IPv4-Reverse für DNSBL-Lookup
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
  const isIpv6 = ip.includes(':');
  if (!isIpv4 && !isIpv6) { res.status(400).json({ error: 'Keine gültige IPv4/IPv6' }); return; }

  let reversed = '';
  if (isIpv4) {
    reversed = ip.split('.').reverse().join('.');
  } else {
    // Vereinfachte IPv6-Expansion
    const expand = (s: string): string => {
      if (!s.includes('::')) return s.split(':').map((p) => p.padStart(4, '0')).join('');
      const [l, r] = s.split('::');
      const lp = l ? l.split(':') : [];
      const rp = r ? r.split(':') : [];
      const m  = 8 - lp.length - rp.length;
      return [...lp, ...Array.from({ length: m }, () => '0'), ...rp].map((p) => p.padStart(4, '0')).join('');
    };
    reversed = expand(ip).split('').reverse().join('.');
  }

  const zones = await prisma.dnsblZone.findMany({ orderBy: { sortOrder: 'asc' } });

  const results = await Promise.all(zones.map(async (z) => {
    const fqdn = `${reversed}.${z.host}`;
    try {
      const addresses = await Promise.race([
        dns.resolve4(fqdn),
        new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      return { zoneId: z.id, host: z.host, name: z.name, enabled: z.enabled, isWhitelist: z.isWhitelist, listed: true, response: addresses[0] ?? null };
    } catch {
      return { zoneId: z.id, host: z.host, name: z.name, enabled: z.enabled, isWhitelist: z.isWhitelist, listed: false, response: null };
    }
  }));

  res.json({ ip, results });
});

// ── GET /admin/security/dnsbl/stats?days=7 ────────────────────────────────────
// Aggregiert Hits pro Zone in den letzten N Tagen
adminSecurityRouter.get('/dnsbl/stats', async (req: Request, res: Response) => {
  const days = Math.min(Math.max(parseInt(String(req.query['days'] ?? '7'), 10), 1), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.dnsblHit.groupBy({
    by: ['zoneId'],
    where: { hitAt: { gte: since } },
    _count: { _all: true },
  });

  const zones = await prisma.dnsblZone.findMany({
    where: { id: { in: rows.map((r) => r.zoneId) } },
    select: { id: true, host: true, name: true },
  });

  const total = rows.reduce((s, r) => s + r._count._all, 0);
  const perZone = rows
    .map((r) => {
      const z = zones.find((x) => x.id === r.zoneId);
      return { zoneId: r.zoneId, host: z?.host ?? '?', name: z?.name ?? '?', hits: r._count._all };
    })
    .sort((a, b) => b.hits - a.hits);

  const recent = await prisma.dnsblHit.findMany({
    where: { hitAt: { gte: since } },
    orderBy: { hitAt: 'desc' },
    take: 50,
    include: { zone: { select: { host: true, name: true } } },
  });

  res.json({
    days,
    total,
    perZone,
    recent: recent.map((h) => ({
      id: h.id,
      ip: h.ip,
      hitAt: h.hitAt,
      response: h.response,
      zoneHost: h.zone.host,
      zoneName: h.zone.name,
    })),
  });
});
