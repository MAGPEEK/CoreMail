/**
 * 10.6: BCP → Authentifizierung → Selbstregistrierung (docs/self-registration.md).
 * Area `recipients` (self-registration creates mailboxes). Route decisions
 * (docs/rbac.md):
 *
 *   GET  /settings                    recipients read  → org (switch, domains, mode, invite requirement)
 *   PUT  /settings                    recipients write → org; audit `settings.self-registration.update`
 *   GET  /invites                     recipients read  → org (codes are never returned, only their hint)
 *   POST /invites                     recipients write → org; the code is answered ONCE; audit `settings.self-registration.invite.create`
 *   DELETE /invites/:inviteId         recipients write → org; revokes; audit `settings.self-registration.invite.revoke`
 *   GET  /pending                     recipients read  → filter (domain of the account)
 *   POST /pending/:id/approve         recipients write → 404 outside the scope; audit `auth.register.approve`
 *   POST /pending/:id/reject          recipients write → 404 outside the scope; deletes the account; audit `auth.register.reject`
 *
 * `:id` is the user id of the registered account.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { requireUnscoped, scopeOf, scopeParam } from '../../middleware/admin-scope.js';
import { domainIdWhere } from '../../lib/admin-scope.js';
import { audit, auditContext } from '../../lib/audit.js';
import {
  SELF_REGISTRATION_MODES, generateInviteCode, hashInviteCode, inviteStatus, settingsFromRow,
  type SelfRegistrationSettings,
} from '../../lib/self-registration.js';

export const adminSelfRegistrationRouter: RouterType = Router();
adminSelfRegistrationRouter.use(requireArea('recipients'));
adminSelfRegistrationRouter.param('id', scopeParam('user'));

/** Limits of the invite code form. */
export const INVITE_LIMITS = Object.freeze({ maxDays: 365, maxUses: 1000, maxActive: 500 });

const SETTINGS_SELECT = {
  allowSelfRegistration: true, selfRegistrationDomainIds: true, selfRegistrationMode: true, selfRegistrationInviteOnly: true,
} as const;

async function currentSettings(): Promise<SelfRegistrationSettings> {
  return settingsFromRow(await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: SETTINGS_SELECT }));
}

async function settingsView(s: SelfRegistrationSettings): Promise<Record<string, unknown>> {
  const domains = await prisma.domain.findMany({ select: { id: true, name: true, active: true }, orderBy: { name: 'asc' } });
  return {
    enabled: s.enabled,
    domainIds: s.domainIds.filter((id) => domains.some((d) => d.id === id)),
    mode: s.mode,
    inviteOnly: s.inviteOnly,
    domains: domains.map((d) => ({ id: d.id, name: d.name, active: d.active })),
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────
adminSelfRegistrationRouter.get('/settings', requireUnscoped, async (_req: Request, res: Response) => {
  res.json(await settingsView(await currentSettings()));
});

const SettingsSchema = z.object({
  enabled: z.boolean().optional(),
  domainIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  mode: z.enum(SELF_REGISTRATION_MODES).optional(),
  inviteOnly: z.boolean().optional(),
}).strict();

adminSelfRegistrationRouter.put('/settings', requireUnscoped, async (req: Request, res: Response) => {
  const parsed = SettingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const p = parsed.data;
  const before = await currentSettings();
  let domainIds = before.domainIds;
  if (p.domainIds !== undefined) {
    domainIds = [...new Set(p.domainIds)];
    const known = await prisma.domain.count({ where: { id: { in: domainIds } } });
    if (known !== domainIds.length) { res.status(400).json({ error: 'Unknown domain', code: 'UNKNOWN_DOMAIN' }); return; }
  }
  const after: SelfRegistrationSettings = {
    enabled: p.enabled ?? before.enabled,
    domainIds,
    mode: p.mode ?? before.mode,
    inviteOnly: p.inviteOnly ?? before.inviteOnly,
  };
  const data = {
    allowSelfRegistration: after.enabled,
    selfRegistrationDomainIds: after.domainIds,
    selfRegistrationMode: after.mode,
    selfRegistrationInviteOnly: after.inviteOnly,
  };
  await prisma.serverSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...data }, update: data });

  const changes: Record<string, { from: string; to: string }> = {};
  for (const k of ['enabled', 'mode', 'inviteOnly'] as const) {
    if (before[k] !== after[k]) changes[k] = { from: String(before[k]), to: String(after[k]) };
  }
  if ([...before.domainIds].sort().join(',') !== [...after.domainIds].sort().join(',')) {
    changes['domainIds'] = { from: before.domainIds.join(','), to: after.domainIds.join(',') };
  }
  if (Object.keys(changes).length > 0) {
    audit({
      actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
      action: 'settings.self-registration.update', targetType: 'settings', targetId: 'self_registration',
      changes, ...auditContext(req),
    });
  }
  res.json(await settingsView(after));
});

// ── Invite codes ─────────────────────────────────────────────────────────────
interface InviteDbRow {
  id: string; label: string; codeHint: string; expiresAt: Date | null; maxUses: number; uses: number;
  revokedAt: Date | null; createdBy: string; createdAt: Date;
}

function inviteView(r: InviteDbRow): Record<string, unknown> {
  return {
    id: r.id, label: r.label, codeHint: r.codeHint, expiresAt: r.expiresAt, maxUses: r.maxUses, uses: r.uses,
    revokedAt: r.revokedAt, createdBy: r.createdBy, createdAt: r.createdAt, status: inviteStatus(r),
  };
}

const INVITE_SELECT = {
  id: true, label: true, codeHint: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true, createdBy: true, createdAt: true,
} as const;

adminSelfRegistrationRouter.get('/invites', requireUnscoped, async (_req: Request, res: Response) => {
  const rows = await prisma.selfRegistrationInvite.findMany({ select: INVITE_SELECT, orderBy: { createdAt: 'desc' }, take: 1000 });
  res.json({ invites: rows.map(inviteView) });
});

const InviteSchema = z.object({
  label: z.string().trim().max(100).optional(),
  expiresInDays: z.number().int().min(1).max(INVITE_LIMITS.maxDays).default(14),
  maxUses: z.number().int().min(1).max(INVITE_LIMITS.maxUses).default(1),
}).strict();

adminSelfRegistrationRouter.post('/invites', requireUnscoped, async (req: Request, res: Response) => {
  const parsed = InviteSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const now = new Date();
  const active = await prisma.selfRegistrationInvite.count({ where: { revokedAt: null, expiresAt: { gt: now } } });
  if (active >= INVITE_LIMITS.maxActive) {
    res.status(409).json({ error: `At most ${INVITE_LIMITS.maxActive} active invite codes`, code: 'TOO_MANY_INVITES' }); return;
  }
  const code = generateInviteCode();
  const row = await prisma.selfRegistrationInvite.create({
    data: {
      label: parsed.data.label ?? '',
      codeHash: hashInviteCode(code),
      codeHint: code.slice(-4),
      expiresAt: new Date(now.getTime() + parsed.data.expiresInDays * 86_400_000),
      maxUses: parsed.data.maxUses,
      createdById: req.apiUser!.userId,
      createdBy: req.apiUser!.email,
    },
    select: INVITE_SELECT,
  });
  audit({
    actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
    action: 'settings.self-registration.invite.create', targetType: 'settings', targetId: row.id, targetName: row.label || row.codeHint,
    changes: { expiresInDays: parsed.data.expiresInDays, maxUses: parsed.data.maxUses },
    ...auditContext(req),
  });
  // The code itself is answered exactly once and never stored.
  res.status(201).json({ code, invite: inviteView(row) });
});

adminSelfRegistrationRouter.delete('/invites/:inviteId', requireUnscoped, async (req: Request, res: Response) => {
  const inviteId = String(req.params['inviteId'] ?? '');
  const row = await prisma.selfRegistrationInvite.findUnique({ where: { id: inviteId }, select: INVITE_SELECT });
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  if (!row.revokedAt) {
    await prisma.selfRegistrationInvite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } });
    audit({
      actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
      action: 'settings.self-registration.invite.revoke', targetType: 'settings', targetId: row.id, targetName: row.label || row.codeHint,
      ...auditContext(req),
    });
  }
  res.json({ ok: true });
});

// ── Pending approvals ────────────────────────────────────────────────────────
adminSelfRegistrationRouter.get('/pending', async (req: Request, res: Response) => {
  const rows = await prisma.selfRegistration.findMany({
    where: { status: 'PENDING', ...domainIdWhere(scopeOf(req)) },
    select: { userId: true, domainId: true, createdAt: true, ipAddress: true, inviteId: true },
    orderBy: { createdAt: 'asc' },
    take: 1000,
  });
  const users = rows.length
    ? await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, email: true, displayName: true } })
    : [];
  const domains = rows.length
    ? await prisma.domain.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.domainId))] } }, select: { id: true, name: true } })
    : [];
  res.json({
    pending: rows.flatMap((r) => {
      const u = users.find((x) => x.id === r.userId);
      if (!u) return [];
      return [{
        id: r.userId, email: u.email, displayName: u.displayName,
        domain: domains.find((d) => d.id === r.domainId)?.name ?? '', createdAt: r.createdAt, ipAddress: r.ipAddress,
        viaInvite: r.inviteId !== null,
      }];
    }),
  });
});

/** The pending registration of `id`, or null (answered 404 by the caller). */
async function pendingOf(id: string) {
  const reg = await prisma.selfRegistration.findUnique({ where: { userId: id }, select: { id: true, status: true } });
  if (reg?.status !== 'PENDING') return null;
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true, active: true } });
  // only an inactive USER account is a registration waiting for approval
  if (!user || user.role !== 'USER') return null;
  return { reg, user };
}

adminSelfRegistrationRouter.post('/pending/:id/approve', async (req: Request, res: Response) => {
  const id = String(req.params['id']);
  const p = await pendingOf(id);
  if (!p) { res.status(404).json({ error: 'Not found' }); return; }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { active: true } });
    await tx.selfRegistration.update({
      where: { userId: id },
      data: { status: 'APPROVED', decidedAt: new Date(), decidedBy: req.apiUser!.email },
    });
  });
  audit({
    actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
    action: 'auth.register.approve', targetType: 'mailbox', targetId: id, targetName: p.user.email,
    ...auditContext(req),
  });
  res.json({ ok: true, status: 'approved' });
});

adminSelfRegistrationRouter.post('/pending/:id/reject', async (req: Request, res: Response) => {
  const id = String(req.params['id']);
  const p = await pendingOf(id);
  if (!p || p.user.active) {
    // an account an admin already activated elsewhere is a normal mailbox now — delete it there
    res.status(404).json({ error: 'Not found' }); return;
  }
  await prisma.user.delete({ where: { id } });
  audit({
    actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
    action: 'auth.register.reject', targetType: 'mailbox', targetId: id, targetName: p.user.email,
    ...auditContext(req),
  });
  res.json({ ok: true, status: 'rejected' });
});
