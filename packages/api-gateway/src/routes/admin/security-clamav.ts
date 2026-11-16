/**
 * BCP → Protection → Antivirus (ClamAV policy, 9.2). Mounted under
 * /api/v1/admin/security/clamav by security.ts (inherits requireArea('hygiene'):
 * read for GET, write for PUT/POST).
 *
 *   GET  /            CoreMail-side ClamAV policy + clamd endpoint (env, read-only)
 *   PUT  /            update the policy (zod, strict) → audit diff + settings reload
 *   GET  /status      clamd status (security-filter /clamav/status)
 *   POST /eicar-test  EICAR self-test through the inbound scan path (security-filter)
 *
 * clamd engine limits (MaxFileSize, StreamMaxLength, AlertEncrypted, …) live in
 * the clamav container's clamd.conf and are not settable here — docs/antivirus.md.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { audit, auditContext } from '../../lib/audit.js';

export const adminClamavRouter: RouterType = Router();

/** The CoreMail-side policy fields (SecuritySettings). */
export const CLAMAV_POLICY_FIELDS = [
  'clamavEnabled', 'clamavAction', 'clamavBlockOnFailure', 'clamavTimeoutSec', 'clamavScanLimitMb',
  'clamavOversizeAction', 'clamavHeuristicsAsVirus', 'clamavPuaAsVirus', 'clamavEncryptedAsVirus',
] as const;
type PolicyField = typeof CLAMAV_POLICY_FIELDS[number];

export const ClamavPolicySchema = z.object({
  clamavEnabled:           z.boolean().optional(),
  clamavAction:            z.enum(['quarantine', 'reject', 'pass']).optional(),
  clamavBlockOnFailure:    z.boolean().optional(),
  // below the smtp-server → security-filter request timeout (30 s)
  clamavTimeoutSec:        z.number().int().min(5).max(25).optional(),
  // the content filter accepts at most 52 MB bodies
  clamavScanLimitMb:       z.number().int().min(1).max(50).optional(),
  clamavOversizeAction:    z.enum(['accept', 'reject']).optional(),
  clamavHeuristicsAsVirus: z.boolean().optional(),
  clamavPuaAsVirus:        z.boolean().optional(),
  clamavEncryptedAsVirus:  z.boolean().optional(),
}).strict();

const SECURITY_FILTER_URL = () => process.env['SECURITY_FILTER_URL'] ?? 'http://localhost:3002';

function endpoint() {
  return {
    host: process.env['CLAMAV_HOST'] ?? 'clamav',
    port: parseInt(process.env['CLAMAV_PORT'] ?? '3310', 10),
    // CLAMAV_ENABLED=false (minimal compose) overrides the BCP switch
    forcedOff: /^(false|0|no|off)$/i.test((process.env['CLAMAV_ENABLED'] ?? '').trim()),
  };
}

function pickPolicy(row: Record<string, unknown>): Record<PolicyField, unknown> {
  const out = {} as Record<PolicyField, unknown>;
  for (const k of CLAMAV_POLICY_FIELDS) out[k] = row[k];
  return out;
}

/** Pure: { field: { from, to } } for the fields that changed. */
export function policyDiff(before: Record<string, unknown> | null, after: Record<string, unknown>): Record<string, { from: string; to: string }> {
  const diff: Record<string, { from: string; to: string }> = {};
  for (const k of CLAMAV_POLICY_FIELDS) {
    if (!(k in after)) continue;
    const from = before ? before[k] : undefined;
    if (from !== after[k]) diff[k] = { from: String(from), to: String(after[k]) };
  }
  return diff;
}

adminClamavRouter.get('/', async (_req: Request, res: Response) => {
  const row = await prisma.securitySettings.upsert({ where: { id: 'singleton' }, update: {}, create: { id: 'singleton' } });
  res.json({ ...pickPolicy(row as unknown as Record<string, unknown>), endpoint: endpoint() });
});

adminClamavRouter.put('/', async (req: Request, res: Response) => {
  const parsed = ClamavPolicySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const data = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));

  const before = await prisma.securitySettings.findUnique({ where: { id: 'singleton' } });
  const row = await prisma.securitySettings.upsert({
    where:  { id: 'singleton' },
    update: data,
    create: { id: 'singleton', ...data },
  });

  const changes = policyDiff(before as unknown as Record<string, unknown> | null, data);
  if (Object.keys(changes).length > 0) {
    audit({
      ...(req.apiUser?.userId !== undefined ? { actorId: req.apiUser.userId } : {}),
      ...(req.apiUser?.email !== undefined ? { actorEmail: req.apiUser.email } : {}),
      action: 'settings.clamav.update',
      targetType: 'settings',
      targetId: 'clamav',
      changes,
      ...auditContext(req),
    });
  }

  // security-filter rebuilds its pipeline config from the DB (hot reload)
  void getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, 'security').catch(() => {});

  res.json({ ...pickPolicy(row as unknown as Record<string, unknown>), endpoint: endpoint() });
});

async function proxy(res: Response, method: 'GET' | 'POST', path: string, timeoutMs: number): Promise<void> {
  try {
    const r = await fetch(`${SECURITY_FILTER_URL()}${path}`, { method, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) { res.status(502).json({ error: `security-filter HTTP ${r.status}` }); return; }
    res.json(await r.json());
  } catch (err) {
    res.status(503).json({ error: 'security-filter unavailable', detail: (err as Error).message });
  }
}

adminClamavRouter.get('/status', async (_req: Request, res: Response) => {
  await proxy(res, 'GET', '/clamav/status', 10_000);
});

adminClamavRouter.post('/eicar-test', async (_req: Request, res: Response) => {
  // scan timeout is at most 25 s
  await proxy(res, 'POST', '/clamav/eicar-test', 30_000);
});
