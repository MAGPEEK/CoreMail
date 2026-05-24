/**
 * Admin routes — Distribution Groups (Phase 7)
 * GET/POST/PUT/DELETE /api/v1/admin/groups
 * GET/POST/DELETE     /api/v1/admin/groups/:id/members
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';

export const adminGroupsRouter: RouterType = Router();
adminGroupsRouter.use(requireAdmin);

// ──────────────────────────────────────────────────────────
// Groups CRUD
// ──────────────────────────────────────────────────────────

// GET /api/v1/admin/groups
adminGroupsRouter.get('/', async (_req: Request, res: Response) => {
  const groups = await prisma.distributionGroup.findMany({
    include: { _count: { select: { members: true } } },
    orderBy: { displayName: 'asc' },
  });
  res.json(groups);
});

// GET /api/v1/admin/groups/:id
adminGroupsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const group = await prisma.distributionGroup.findUnique({
    where: { id },
    include: { members: true },
  });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  res.json(group);
});

const CreateGroupSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  description: z.string().default(''),
  domainId: z.string(),
  groupType: z.enum(['STATIC', 'DYNAMIC']).default('STATIC'),
  ldapFilter: z.string().optional(),
  requireSenderAuth: z.boolean().default(false),
  allowExternal: z.boolean().default(true),
  moderationEnabled: z.boolean().default(false),
  moderatorIds: z.array(z.string()).default([]),
  hiddenFromGal: z.boolean().default(false),
});

// POST /api/v1/admin/groups
adminGroupsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = CreateGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { email, displayName, description, domainId, groupType, ldapFilter,
    requireSenderAuth, allowExternal, moderationEnabled, moderatorIds, hiddenFromGal } = parsed.data;

  const existing = await prisma.distributionGroup.findUnique({ where: { email } });
  if (existing) { res.status(409).json({ error: 'Email already in use' }); return; }

  const domain = await prisma.domain.findUnique({ where: { id: domainId } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  const group = await prisma.distributionGroup.create({
    data: {
      email, displayName, description, domainId, groupType,
      requireSenderAuth, allowExternal, moderationEnabled, moderatorIds, hiddenFromGal,
      ...(ldapFilter !== undefined ? { ldapFilter } : {}),
    },
    include: { _count: { select: { members: true } } },
  });
  res.status(201).json(group);
});

const UpdateGroupSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
  requireSenderAuth: z.boolean().optional(),
  allowExternal: z.boolean().optional(),
  moderationEnabled: z.boolean().optional(),
  moderatorIds: z.array(z.string()).optional(),
  hiddenFromGal: z.boolean().optional(),
  active: z.boolean().optional(),
  ldapFilter: z.string().optional(),
});

// PUT /api/v1/admin/groups/:id
adminGroupsRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = UpdateGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const existing = await prisma.distributionGroup.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ error: 'Group not found' }); return; }

  const { ldapFilter, displayName, description, requireSenderAuth, allowExternal,
    moderationEnabled, moderatorIds, hiddenFromGal, active } = parsed.data;
  const group = await prisma.distributionGroup.update({
    where: { id },
    data: {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(requireSenderAuth !== undefined ? { requireSenderAuth } : {}),
      ...(allowExternal !== undefined ? { allowExternal } : {}),
      ...(moderationEnabled !== undefined ? { moderationEnabled } : {}),
      ...(moderatorIds !== undefined ? { moderatorIds } : {}),
      ...(hiddenFromGal !== undefined ? { hiddenFromGal } : {}),
      ...(active !== undefined ? { active } : {}),
      ...(ldapFilter !== undefined ? { ldapFilter } : {}),
    },
  });
  res.json(group);
});

// DELETE /api/v1/admin/groups/:id
adminGroupsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const existing = await prisma.distributionGroup.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ error: 'Group not found' }); return; }
  await prisma.distributionGroup.delete({ where: { id } });
  res.status(204).end();
});

// ──────────────────────────────────────────────────────────
// Members sub-resource
// ──────────────────────────────────────────────────────────

// GET /api/v1/admin/groups/:id/members
adminGroupsRouter.get('/:id/members', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const members = await prisma.distributionGroupMember.findMany({
    where: { groupId: id },
    orderBy: { memberEmail: 'asc' },
  });
  res.json(members);
});

const AddMemberSchema = z.object({
  memberEmail: z.string().email(),
  memberType: z.enum(['USER', 'SHARED_MAILBOX', 'GROUP', 'EXTERNAL']).default('USER'),
});

// POST /api/v1/admin/groups/:id/members
adminGroupsRouter.post('/:id/members', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = AddMemberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const group = await prisma.distributionGroup.findUnique({ where: { id } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const { memberEmail, memberType } = parsed.data;
  const addedBy = req.apiUser?.userId;

  try {
    const member = await prisma.distributionGroupMember.create({
      data: {
        groupId: id,
        memberEmail,
        memberType,
        ...(addedBy !== undefined ? { addedBy } : {}),
      },
    });
    res.status(201).json(member);
  } catch {
    res.status(409).json({ error: 'Member already in group' });
  }
});

// DELETE /api/v1/admin/groups/:id/members/:memberEmail
adminGroupsRouter.delete('/:id/members/:memberEmail', async (req: Request, res: Response) => {
  const { id, memberEmail } = req.params as { id: string; memberEmail: string };
  const member = await prisma.distributionGroupMember.findFirst({
    where: { groupId: id, memberEmail },
  });
  if (!member) { res.status(404).json({ error: 'Member not found' }); return; }
  await prisma.distributionGroupMember.delete({ where: { id: member.id } });
  res.status(204).end();
});

// ──────────────────────────────────────────────────────────
// GAL — Global Address List (public, no admin required)
// ──────────────────────────────────────────────────────────

// GET /api/v1/admin/groups/gal  — visible groups for address autocomplete
adminGroupsRouter.get('/gal/list', async (_req: Request, res: Response) => {
  const groups = await prisma.distributionGroup.findMany({
    where: { active: true, hiddenFromGal: false },
    select: { id: true, email: true, displayName: true, description: true },
    orderBy: { displayName: 'asc' },
  });
  res.json(groups);
});
