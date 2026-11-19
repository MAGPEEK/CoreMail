/**
 * Admin API — email aliases
 *
 * Aliases are additional receiving addresses that belong to a primary mailbox
 * (user or shared mailbox). Incoming mails to the alias address are delivered
 * by the SMTP server into the target's mailbox.
 *
 * Routes:
 *   GET    /api/v1/admin/aliases                         — list all aliases
 *   GET    /api/v1/admin/mailboxes/:id/aliases           — user aliases
 *   POST   /api/v1/admin/mailboxes/:id/aliases           — create user alias
 *   GET    /api/v1/admin/shared-mailboxes/:id/aliases    — SharedMailbox aliases
 *   POST   /api/v1/admin/shared-mailboxes/:id/aliases    — create SharedMailbox alias
 *   PATCH  /api/v1/admin/aliases/:aliasId                — edit alias (active, description)
 *   DELETE /api/v1/admin/aliases/:aliasId                — delete alias
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireArea } from '../../middleware/auth.js';
import { addressCollision } from '../../lib/address-collision.js';
import { allowDomain, requireInScope, scopeOf, scopeParam } from '../../middleware/admin-scope.js';
import { aliasWhere } from '../../lib/admin-scope.js';
import { canManageAccount } from '../../lib/rbac.js';

const log = createLogger('admin:aliases');
export const adminAliasesRouter: RouterType = Router();
// v6: this router is mounted on /api/v1/admin itself — guard ONLY its own
// paths. A router-wide guard here would run for every later admin router
// (e.g. /security) and apply the wrong area to them.
export const ALIAS_PATHS = ['/aliases', '/mailboxes/:id/aliases', '/shared-mailboxes/:id/aliases'];
adminAliasesRouter.use(ALIAS_PATHS, requireArea('recipients'));
// 9.5: management scope — the owner mailbox (`:id`, per route: user or shared
// mailbox) and the alias (`:aliasId`: its domain and its target) must be inside it.
adminAliasesRouter.param('aliasId', scopeParam('alias'));
const userInScope = requireInScope('user');
const sharedInScope = requireInScope('shared');

/**
 * An alias routes mail into its target mailbox: adding, changing or removing
 * one on an admin account is a change of that account — ORGANIZATION_MANAGEMENT
 * only (lib/rbac.ts canManageAccount; 9.5: also keeps domain-scoped admins away
 * from organisation-wide admin accounts of their domains). True = go on.
 */
function allowAccountChange(req: Request, res: Response, targetRole: string | null | undefined): boolean {
  if (canManageAccount(req.apiUser!.role, targetRole ?? undefined)) return true;
  res.status(403).json({ error: 'Only Organization Management may modify admin accounts', code: 'FORBIDDEN_ROLE' });
  return false;
}

const LOCAL_PART_RE = /^[a-z0-9._+-]+$/;

const CreateBody = z.object({
  // Either a full email address OR localPart + domainId
  address:   z.string().email().optional(),
  localPart: z.string().min(1).max(64).optional(),
  domainId:  z.string().optional(),
  description: z.string().max(200).default(''),
  active:    z.boolean().default(true),
});

/**
 * Helper — builds the final alias address from input.
 * If `address` is set: the domain is extracted from the email and validated against the DB.
 * Otherwise `localPart + domainId` must be set and the domain must exist in the DB.
 */
async function resolveAliasInput(input: z.infer<typeof CreateBody>): Promise<
  { ok: true; address: string; localPart: string; domainId: string }
  | { ok: false; error: string }
> {
  if (input.address) {
    const at = input.address.lastIndexOf('@');
    if (at < 1) return { ok: false, error: 'Invalid email address' };
    const localPart = input.address.slice(0, at).toLowerCase();
    const domainName = input.address.slice(at + 1).toLowerCase();
    if (!LOCAL_PART_RE.test(localPart) || localPart.startsWith('.') || localPart.endsWith('.')) {
      return { ok: false, error: 'Invalid local part — allowed: a-z 0-9 . _ + -' };
    }
    const domain = await prisma.domain.findUnique({ where: { name: domainName }, select: { id: true } });
    if (!domain) return { ok: false, error: `Domain "${domainName}" is not configured on this server` };
    return { ok: true, address: `${localPart}@${domainName}`, localPart, domainId: domain.id };
  }
  if (!input.localPart || !input.domainId) {
    return { ok: false, error: 'Either address or localPart + domainId is required' };
  }
  const localPart = input.localPart.toLowerCase();
  if (!LOCAL_PART_RE.test(localPart) || localPart.startsWith('.') || localPart.endsWith('.')) {
    return { ok: false, error: 'Invalid local part — allowed: a-z 0-9 . _ + -' };
  }
  const domain = await prisma.domain.findUnique({ where: { id: input.domainId }, select: { id: true, name: true } });
  if (!domain) return { ok: false, error: 'Unknown domain' };
  return { ok: true, address: `${localPart}@${domain.name}`, localPart, domainId: domain.id };
}

const ALIAS_SELECT = {
  id: true, address: true, localPart: true, description: true, active: true,
  domainId: true, targetUserId: true, targetSharedId: true,
  createdAt: true, updatedAt: true,
  domain:       { select: { id: true, name: true } },
  targetUser:   { select: { id: true, email: true, displayName: true } },
  targetShared: { select: { id: true, email: true, displayName: true } },
} as const;

// ── GET /admin/aliases — all ─────────────────────────────────────────────────

adminAliasesRouter.get('/aliases', async (req: Request, res: Response) => {
  const aliases = await prisma.emailAlias.findMany({
    where: aliasWhere(scopeOf(req)),
    select: ALIAS_SELECT,
    orderBy: { address: 'asc' },
  });
  res.json(aliases);
});

// ── User aliases ─────────────────────────────────────────────────────────────

adminAliasesRouter.get('/mailboxes/:id/aliases', userInScope, async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const aliases = await prisma.emailAlias.findMany({
    where: { targetUserId: id, ...aliasWhere(scopeOf(req)) },
    select: ALIAS_SELECT,
    orderBy: { address: 'asc' },
  });
  res.json(aliases);
});

adminAliasesRouter.post('/mailboxes/:id/aliases', userInScope, async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const p = CreateBody.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }

  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, domainId: true, role: true } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (!allowAccountChange(req, res, user.role)) return;

  // Default domain = the user's (for localPart-only mode)
  const input = { ...p.data, domainId: p.data.domainId ?? user.domainId };
  const resolved = await resolveAliasInput(input);
  if (!resolved.ok) { res.status(400).json({ error: resolved.error }); return; }
  if (!allowDomain(req, res, resolved.domainId)) return; // 9.5: alias address in the admin's own domains

  const collision = await addressCollision(resolved.address);
  if (collision) { res.status(409).json({ error: collision }); return; }

  const alias = await prisma.emailAlias.create({
    data: {
      address:      resolved.address,
      localPart:    resolved.localPart,
      domainId:     resolved.domainId,
      targetUserId: user.id,
      description:  p.data.description,
      active:       p.data.active,
    },
    select: ALIAS_SELECT,
  });
  log.info({ aliasId: alias.id, address: alias.address, target: 'user:' + user.id }, 'User alias created');
  res.status(201).json(alias);
});

// ── SharedMailbox aliases ────────────────────────────────────────────────────

adminAliasesRouter.get('/shared-mailboxes/:id/aliases', sharedInScope, async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const aliases = await prisma.emailAlias.findMany({
    where: { targetSharedId: id, ...aliasWhere(scopeOf(req)) },
    select: ALIAS_SELECT,
    orderBy: { address: 'asc' },
  });
  res.json(aliases);
});

adminAliasesRouter.post('/shared-mailboxes/:id/aliases', sharedInScope, async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const p = CreateBody.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }

  const sm = await prisma.sharedMailbox.findUnique({ where: { id }, select: { id: true, domainId: true } });
  if (!sm) { res.status(404).json({ error: 'Shared mailbox not found' }); return; }

  const input = { ...p.data, domainId: p.data.domainId ?? sm.domainId };
  const resolved = await resolveAliasInput(input);
  if (!resolved.ok) { res.status(400).json({ error: resolved.error }); return; }
  if (!allowDomain(req, res, resolved.domainId)) return; // 9.5: alias address in the admin's own domains

  const collision = await addressCollision(resolved.address);
  if (collision) { res.status(409).json({ error: collision }); return; }

  const alias = await prisma.emailAlias.create({
    data: {
      address:        resolved.address,
      localPart:      resolved.localPart,
      domainId:       resolved.domainId,
      targetSharedId: sm.id,
      description:    p.data.description,
      active:         p.data.active,
    },
    select: ALIAS_SELECT,
  });
  log.info({ aliasId: alias.id, address: alias.address, target: 'shared:' + sm.id }, 'SharedMailbox alias created');
  res.status(201).json(alias);
});

// ── PATCH /admin/aliases/:aliasId ────────────────────────────────────────────

const PatchBody = z.object({
  description: z.string().max(200).optional(),
  active:      z.boolean().optional(),
});

adminAliasesRouter.patch('/aliases/:aliasId', async (req: Request, res: Response) => {
  const { aliasId } = req.params as { aliasId: string };
  const p = PatchBody.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }

  const existing = await prisma.emailAlias.findUnique({ where: { id: aliasId }, include: { targetUser: { select: { role: true } } } });
  if (!existing) { res.status(404).json({ error: 'Alias not found' }); return; }
  if (!allowAccountChange(req, res, existing.targetUser?.role)) return;

  const updated = await prisma.emailAlias.update({
    where: { id: aliasId },
    data: {
      ...(p.data.description !== undefined ? { description: p.data.description } : {}),
      ...(p.data.active      !== undefined ? { active:      p.data.active      } : {}),
    },
    select: ALIAS_SELECT,
  });
  res.json(updated);
});

// ── DELETE /admin/aliases/:aliasId ───────────────────────────────────────────

adminAliasesRouter.delete('/aliases/:aliasId', async (req: Request, res: Response) => {
  const { aliasId } = req.params as { aliasId: string };
  const existing = await prisma.emailAlias.findUnique({ where: { id: aliasId }, include: { targetUser: { select: { role: true } } } });
  if (!existing) { res.status(404).json({ error: 'Alias not found' }); return; }
  if (!allowAccountChange(req, res, existing.targetUser?.role)) return;
  await prisma.emailAlias.delete({ where: { id: aliasId } });
  log.info({ aliasId, address: existing.address }, 'Alias deleted');
  res.status(204).end();
});
