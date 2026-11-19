/**
 * Admin API: organisation (sharing policies + address lists)
 *
 * GET/POST/PUT/DELETE /api/v1/admin/organisation/sharing-policies
 * GET/POST/PUT/DELETE /api/v1/admin/organisation/address-lists
 * GET                 /api/v1/admin/organisation/gal            — global address list (live query)
 * GET                 /api/v1/admin/organisation/role-assignments — users + roles + scopes (RBAC page)
 * PUT                 /api/v1/admin/organisation/role-assignments/:id/scope — 9.5 management scope
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { patchSchema } from '../../lib/zod-compat.js';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireArea } from '../../middleware/auth.js';
import { revokeAllSessions } from '@coremail/storage/auth';
import { scopeAssignmentError } from '../../lib/rbac.js';
import { scopeFromRows, scopeView } from '../../lib/admin-scope.js';
import { audit, auditContext } from '../../lib/audit.js';

const log = createLogger('admin:organisation');
export const adminOrganisationRouter: RouterType = Router();
adminOrganisationRouter.use(requireArea('organisation'));

// ─── Role assignments (RBAC page) ─────────────────────────────────────────────
// GET /api/v1/admin/organisation/role-assignments — who holds which role. The BCP
// RBAC page is in the organisation area; it used to load GET /mailboxes (area
// recipients), so SERVER_MANAGEMENT could open the page but never load it. Only the
// fields the page needs (no quota/usage/login data). Role changes still go through
// PUT /mailboxes/:id (ORGANIZATION_MANAGEMENT only, audited as user.role).
// 9.5: every row carries the account's management scope (`scope`, lib/admin-scope.ts).
adminOrganisationRouter.get('/role-assignments', async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    select: {
      id: true, email: true, displayName: true, role: true, active: true, domainId: true,
      adminScopes: { select: { domain: { select: { id: true, name: true } } } },
    },
    orderBy: { email: 'asc' },
  });
  res.json(users.map(({ adminScopes, ...u }) => ({
    ...u,
    scope: scopeView(scopeFromRows(String(u.role), (adminScopes ?? []).map((s) => s.domain))),
  })));
});

// ─── Management scopes (9.5) ──────────────────────────────────────────────────
// PUT /api/v1/admin/organisation/role-assignments/:id/scope  { domainIds: string[] }
// Limits the admin role of the account to these domains; [] = organisation-wide.
// ORGANIZATION_MANAGEMENT only (organisation write + scopeAssignmentError) — it is
// organisation-wide itself, so no admin can hand out more than it holds. A scope
// change is audited (`user.role.scope`, always logged) and revokes the account's
// web/API sessions like a role change (publishUserAuthChange).
const ScopeSchema = z.object({ domainIds: z.array(z.string().min(1).max(64)).max(500) }).strict();

adminOrganisationRouter.put('/role-assignments/:id/scope', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const parsed = ScopeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.issues }); return; }
  const domainIds = [...new Set(parsed.data.domainIds)];
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  const actor = req.apiUser!;
  const refusal = scopeAssignmentError(actor.role, String(user.role), domainIds);
  if (refusal === 'FORBIDDEN_ROLE') {
    res.status(403).json({ error: 'Only Organization Management may assign management scopes', code: refusal }); return;
  }
  if (refusal === 'ROLE_NOT_SCOPABLE') {
    res.status(400).json({ error: 'This role cannot be limited to domains', code: refusal }); return;
  }
  const domains = await prisma.domain.findMany({ where: { id: { in: domainIds } }, select: { id: true, name: true } });
  if (domains.length !== domainIds.length) { res.status(400).json({ error: 'Unknown domain', code: 'UNKNOWN_DOMAIN' }); return; }

  const before = await prisma.adminScope.findMany({ where: { userId: id }, select: { domain: { select: { id: true, name: true } } } });
  const beforeNames = before.map((s) => s.domain.name).sort();
  const afterNames = domains.map((d) => d.name).sort();
  const changed = beforeNames.join() !== afterNames.join();
  if (changed) {
    await prisma.$transaction([
      prisma.adminScope.deleteMany({ where: { userId: id } }),
      prisma.adminScope.createMany({ data: domainIds.map((domainId) => ({ userId: id, domainId, grantedBy: actor.userId })) }),
    ]);
    audit({
      actorId: actor.userId, actorEmail: actor.email,
      action: 'user.role.scope', targetType: 'user', targetId: id, targetName: user.email,
      changes: { role: user.role, before: { domains: beforeNames }, after: { domains: afterNames } },
      ...auditContext(req),
    });
    // the scope travels with every admin check (cached per user): end the sessions
    // and drop the caches like a role change does
    await revokeAllSessions(id, { reason: 'scope-change' });
    log.info({ userId: id, before: beforeNames, after: afterNames }, 'Admin management scope changed');
  }
  res.json({ id, role: user.role, scope: scopeView(scopeFromRows(String(user.role), domains)), changed });
});

// ─── Sharing Policies ─────────────────────────────────────────────────────────

const SharingSchema = z.object({
  name:           z.string().min(1).max(200),
  description:    z.string().max(500).default(''),
  enabled:        z.boolean().default(true),
  allowedDomains: z.array(z.string()).default([]),
  allowCalendar:  z.boolean().default(true),
  allowContacts:  z.boolean().default(false),
  calendarDetail: z.enum(['FREEBUSY', 'LIMITED', 'FULL']).default('FREEBUSY'),
  isDefault:      z.boolean().default(false),
});

adminOrganisationRouter.get('/sharing-policies', async (_req: Request, res: Response) => {
  const policies = await prisma.sharingPolicy.findMany({ orderBy: { name: 'asc' } });
  res.json(policies);
});

adminOrganisationRouter.post('/sharing-policies', async (req: Request, res: Response) => {
  const p = SharingSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }
  if (p.data.isDefault) {
    await prisma.sharingPolicy.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }
  const policy = await prisma.sharingPolicy.create({ data: p.data });
  log.info({ id: policy.id }, 'Sharing policy created');
  res.status(201).json(policy);
});

adminOrganisationRouter.put('/sharing-policies/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const p = patchSchema(SharingSchema).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    if (p.data.isDefault) {
      await prisma.sharingPolicy.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    const d = p.data;
    const updateData: Record<string, unknown> = {};
    if (d.name           !== undefined) updateData['name']           = d.name;
    if (d.description    !== undefined) updateData['description']    = d.description;
    if (d.enabled        !== undefined) updateData['enabled']        = d.enabled;
    if (d.allowedDomains !== undefined) updateData['allowedDomains'] = d.allowedDomains;
    if (d.allowCalendar  !== undefined) updateData['allowCalendar']  = d.allowCalendar;
    if (d.allowContacts  !== undefined) updateData['allowContacts']  = d.allowContacts;
    if (d.calendarDetail !== undefined) updateData['calendarDetail'] = d.calendarDetail;
    if (d.isDefault      !== undefined) updateData['isDefault']      = d.isDefault;
    const policy = await prisma.sharingPolicy.update({ where: { id }, data: updateData });
    res.json(policy);
  } catch { res.status(404).json({ error: 'Not found' }); }
});

adminOrganisationRouter.delete('/sharing-policies/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.sharingPolicy.delete({ where: { id } });
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ─── Address Lists ────────────────────────────────────────────────────────────

const AddressListSchema = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(500).default(''),
  filter:      z.record(z.string(), z.unknown()).default({}),
  isGal:       z.boolean().default(false),
});

adminOrganisationRouter.get('/address-lists', async (_req: Request, res: Response) => {
  const lists = await prisma.addressList.findMany({ orderBy: [{ isGal: 'desc' }, { name: 'asc' }] });
  res.json(lists);
});

adminOrganisationRouter.post('/address-lists', async (req: Request, res: Response) => {
  const p = AddressListSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }
  const list = await prisma.addressList.create({
    data: { name: p.data.name, description: p.data.description, isGal: p.data.isGal, filter: p.data.filter as object },
  });
  res.status(201).json(list);
});

adminOrganisationRouter.put('/address-lists/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const p = patchSchema(AddressListSchema).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    const d = p.data;
    const updateData: Record<string, unknown> = {};
    if (d.name        !== undefined) updateData['name']        = d.name;
    if (d.description !== undefined) updateData['description'] = d.description;
    if (d.isGal       !== undefined) updateData['isGal']       = d.isGal;
    if (d.filter      !== undefined) updateData['filter']      = d.filter as object;
    const list = await prisma.addressList.update({ where: { id }, data: updateData });
    res.json(list);
  } catch { res.status(404).json({ error: 'Not found' }); }
});

adminOrganisationRouter.delete('/address-lists/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.addressList.delete({ where: { id } });
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ─── GAL (live query of all mailboxes) ──────────────────────────────────────
adminOrganisationRouter.get('/gal', async (req: Request, res: Response) => {
  const { search = '', limit = '200' } = req.query as Record<string, string>;
  const where = search
    ? { OR: [
        { email: { contains: search, mode: 'insensitive' as const } },
        { displayName: { contains: search, mode: 'insensitive' as const } },
      ]}
    : {};

  const [users, sharedBoxes, groups] = await Promise.all([
    prisma.user.findMany({
      where: { active: true, ...where },
      take: parseInt(limit), orderBy: { displayName: 'asc' },
      select: { id: true, email: true, displayName: true, domainId: true },
    }),
    prisma.sharedMailbox.findMany({
      where: { active: true, ...where },
      take: parseInt(limit), orderBy: { displayName: 'asc' },
      select: { id: true, email: true, displayName: true },
    }),
    // v5.6.1: distributionGroup search removed
    Promise.resolve([] as Array<{ id: string; email: string; displayName: string }>),
  ]);

  res.json({
    users:     users.map(u => ({ ...u, type: 'USER' })),
    shared:    sharedBoxes.map(s => ({ ...s, type: 'SHARED' })),
    groups:    groups.map(g => ({ ...g, type: 'GROUP' })),
    total: users.length + sharedBoxes.length + groups.length,
  });
});
