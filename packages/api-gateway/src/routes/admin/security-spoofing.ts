/**
 * BCP → Protection → Spoofing (9.4): local-domain anti-spoofing, before 9.4 only set by
 * the environment. Mounted under /api/v1/admin/security/spoofing by security.ts
 * (inherits requireArea('hygiene')).
 *
 *   GET  /   stored values, effective values and the fields an environment variable
 *            overrides (LOCAL_SPOOF_ACTION / LOCAL_SPOOF_ALLOW / ARC_TRUSTED_SEALERS)
 *   PUT  /   update (zod, strict; allow entries IP/CIDR/domain, sealers domains) →
 *            audit diff + settings reload (security filter rebuilds its config)
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  prisma, resolveSpoofSettings, normalizeSpoofList, parseSpoofAllowEntry, isSpoofDomain,
  LOCAL_SPOOF_ACTIONS, SPOOF_ENV_VARS,
} from '@coremail/storage';
import { getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { audit, auditContext } from '../../lib/audit.js';

export const adminSpoofingRouter: RouterType = Router();

const MAX_ENTRIES = 200;

export const SpoofingSchema = z.object({
  localSpoofAction: z.enum(LOCAL_SPOOF_ACTIONS as [string, ...string[]]).optional(),
  localSpoofAllow: z.array(z.string().max(253)).max(MAX_ENTRIES).optional(),
  arcTrustedSealers: z.array(z.string().max(253)).max(MAX_ENTRIES).optional(),
}).strict();

type SpoofRow = { localSpoofAction: string; localSpoofAllow: unknown; arcTrustedSealers: unknown };

/** Pure: the invalid entries of both lists (shown by the BCP), empty when all are valid. */
export function invalidSpoofEntries(data: z.infer<typeof SpoofingSchema>): string[] {
  return [
    ...(data.localSpoofAllow ?? []).filter((e) => parseSpoofAllowEntry(e) === null),
    ...(data.arcTrustedSealers ?? []).filter((e) => !isSpoofDomain(e)),
  ];
}

function view(row: SpoofRow) {
  const effective = resolveSpoofSettings(row);
  return {
    localSpoofAction: row.localSpoofAction,
    localSpoofAllow: normalizeSpoofList(row.localSpoofAllow),
    arcTrustedSealers: normalizeSpoofList(row.arcTrustedSealers),
    effective: { action: effective.action, allow: effective.allow, arcTrustedSealers: effective.arcTrustedSealers },
    envOverrides: effective.envOverrides.map((field) => ({ field, variable: SPOOF_ENV_VARS[field] })),
  };
}

const SELECT = { localSpoofAction: true, localSpoofAllow: true, arcTrustedSealers: true } as const;

adminSpoofingRouter.get('/', async (_req: Request, res: Response) => {
  const row = await prisma.securitySettings.upsert({ where: { id: 'singleton' }, update: {}, create: { id: 'singleton' }, select: SELECT });
  res.json(view(row));
});

adminSpoofingRouter.put('/', async (req: Request, res: Response) => {
  const parsed = SpoofingSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const invalid = invalidSpoofEntries(parsed.data);
  if (invalid.length) { res.status(400).json({ error: 'invalid entries (IP, CIDR or domain expected)', invalid: invalid.slice(0, 20) }); return; }

  const data = {
    ...(parsed.data.localSpoofAction !== undefined ? { localSpoofAction: parsed.data.localSpoofAction } : {}),
    ...(parsed.data.localSpoofAllow !== undefined ? { localSpoofAllow: normalizeSpoofList(parsed.data.localSpoofAllow) } : {}),
    ...(parsed.data.arcTrustedSealers !== undefined ? { arcTrustedSealers: normalizeSpoofList(parsed.data.arcTrustedSealers) } : {}),
  };
  const before = await prisma.securitySettings.findUnique({ where: { id: 'singleton' }, select: SELECT });
  const row = await prisma.securitySettings.upsert({
    where: { id: 'singleton' }, update: data, create: { id: 'singleton', ...data }, select: SELECT,
  });

  const changes: Record<string, { from: string; to: string }> = {};
  for (const [k, v] of Object.entries(data)) {
    const from = JSON.stringify(before ? (before as Record<string, unknown>)[k] : null);
    const to = JSON.stringify(v);
    if (from !== to) changes[k] = { from, to };
  }
  if (Object.keys(changes).length) {
    audit({
      ...(req.apiUser?.userId !== undefined ? { actorId: req.apiUser.userId } : {}),
      ...(req.apiUser?.email !== undefined ? { actorEmail: req.apiUser.email } : {}),
      action: 'settings.spoofing.update',
      targetType: 'settings',
      targetId: 'spoofing',
      changes,
      ...auditContext(req),
    });
  }
  // security-filter rebuilds its pipeline config from the DB (hot reload)
  void getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, 'security').catch(() => {});
  res.json(view(row));
});
