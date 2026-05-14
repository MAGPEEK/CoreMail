import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { hashPassword } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';
import { ensureMailboxProvisioned } from '../../lib/provision-mailbox.js';

export const adminMailboxesRouter: RouterType = Router();
adminMailboxesRouter.use(requireAdmin);

// GET /api/v1/admin/mailboxes
adminMailboxesRouter.get('/', async (_req: Request, res: Response) => {
  
  const users = await prisma.user.findMany({
    select: { id: true, email: true, displayName: true, role: true, active: true, quotaBytes: true, usedBytes: true, domainId: true, createdAt: true },
    orderBy: { email: 'asc' },
  });
  res.json(users);
});

// GET /api/v1/admin/mailboxes/:id
adminMailboxesRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const user = await prisma.user.findUnique({
    where: { id },
    include: { mailbox: { include: { folders: { select: { id: true, name: true, totalCount: true, unreadCount: true } } } } },
  });
  if (!user) { res.status(404).json({ error: 'Mailbox not found' }); return; }
  res.json(user);
});

const CreateMailboxSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(8),
  domainId: z.string(),
  role: z.enum(['USER', 'ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT', 'RECIPIENT_MANAGEMENT', 'HELP_DESK', 'COMPLIANCE_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'VIEW_ONLY_ORG']).default('USER'),
  quotaBytes: z.number().int().default(5368709120),
});

// POST /api/v1/admin/mailboxes
adminMailboxesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = CreateMailboxSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const { email, displayName, password, domainId, role, quotaBytes } = parsed.data;
  

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) { res.status(409).json({ error: 'Email already in use' }); return; }

  const domain = await prisma.domain.findUnique({ where: { id: domainId } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      email, displayName, passwordHash, role, quotaBytes: BigInt(quotaBytes), domainId,
      mailbox: {
        create: {
          folders: {
            create: [
              { name: 'INBOX', displayName: 'Inbox', totalCount: 0, unreadCount: 0 },
              { name: 'Drafts', displayName: 'Drafts', totalCount: 0, unreadCount: 0 },
              { name: 'Sent', displayName: 'Sent Items', totalCount: 0, unreadCount: 0 },
              { name: 'Trash', displayName: 'Deleted Items', totalCount: 0, unreadCount: 0 },
              { name: 'Junk', displayName: 'Junk Email', totalCount: 0, unreadCount: 0 },
              { name: 'Archive', displayName: 'Archive', totalCount: 0, unreadCount: 0 },
            ],
          },
        },
      },
      calendars: { create: [{ name: 'Calendar', color: '#0078D4' }] },
    },
    select: { id: true, email: true, displayName: true, role: true, createdAt: true },
  });
  res.status(201).json(user);
});

// PUT /api/v1/admin/mailboxes/:id
adminMailboxesRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const schema = z.object({
    displayName: z.string().min(1).optional(),
    role: z.string().optional(),
    active: z.boolean().optional(),
    quotaBytes: z.number().int().optional(),
    password: z.string().min(8).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  const data: Record<string, unknown> = {};
  if (parsed.data.displayName) data['displayName'] = parsed.data.displayName;
  if (parsed.data.role) data['role'] = parsed.data.role;
  if (parsed.data.active !== undefined) data['active'] = parsed.data.active;
  if (parsed.data.quotaBytes) data['quotaBytes'] = BigInt(parsed.data.quotaBytes);
  if (parsed.data.password) {
    data['passwordHash'] = await hashPassword(parsed.data.password);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await prisma.user.update({ where: { id }, data: data as any });
  res.json({ id: updated.id, email: updated.email, displayName: updated.displayName });
});

// DELETE /api/v1/admin/mailboxes/:id
adminMailboxesRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) { res.status(404).json({ error: 'Mailbox not found' }); return; }
  await prisma.user.delete({ where: { id } });
  res.json({ ok: true });
});

// GET /api/v1/admin/shared-mailboxes
adminMailboxesRouter.get('/shared', async (_req: Request, res: Response) => {
  
  const mailboxes = await prisma.sharedMailbox.findMany({
    include: { permissions: { include: { user: { select: { id: true, email: true, displayName: true } } } } },
    orderBy: { email: 'asc' },
  });
  res.json(mailboxes);
});

// POST /api/v1/admin/shared-mailboxes
adminMailboxesRouter.post('/shared', async (req: Request, res: Response) => {
  const schema = z.object({
    email: z.string().email(),
    displayName: z.string().min(1),
    domainId: z.string(),
    quotaBytes: z.number().int().default(10737418240),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  
  const mailbox = await prisma.sharedMailbox.create({
    data: {
      email: parsed.data.email,
      displayName: parsed.data.displayName,
      domainId: parsed.data.domainId,
      quotaBytes: BigInt(parsed.data.quotaBytes),
    },
  });
  res.status(201).json(mailbox);
});

// POST /api/v1/admin/shared-mailboxes/:id/permissions
adminMailboxesRouter.post('/shared/:id/permissions', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const schema = z.object({
    userId: z.string(),
    permission: z.enum(['FULL_ACCESS', 'SEND_AS', 'SEND_ON_BEHALF', 'READ_ONLY']),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  
  const perm = await prisma.sharedMailboxPerm.upsert({
    where: { sharedMailboxId_userId: { sharedMailboxId: id, userId: parsed.data.userId } },
    update: { permission: parsed.data.permission },
    create: {
      sharedMailboxId: id,
      userId: parsed.data.userId,
      permission: parsed.data.permission,
      grantedBy: req.apiUser!.userId,
    },
  });
  res.status(201).json(perm);
});

// DELETE /api/v1/admin/shared-mailboxes/:id/permissions/:userId
adminMailboxesRouter.delete('/shared/:id/permissions/:userId', async (req: Request, res: Response) => {
  const { id, userId } = req.params as { id: string; userId: string };

  await prisma.sharedMailboxPerm.deleteMany({ where: { sharedMailboxId: id, userId } });
  res.json({ ok: true });
});

// ── Phase 10: Mailbox Provisioning ───────────────────────────────────────────

/**
 * POST /api/v1/admin/mailboxes/:id/provision
 * Ensure a user has a fully provisioned mailbox + default folders + calendar.
 * Idempotent — safe to call on existing users (fills in missing folders/calendars).
 */
adminMailboxesRouter.post('/:id/provision', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const result = await ensureMailboxProvisioned(id);
  res.json({ ok: true, userId: id, email: user.email, ...result });
});

/**
 * POST /api/v1/admin/mailboxes/bulk-provision
 * Provision mailboxes for all users who don't have one yet.
 * Returns a summary of what was created.
 */
adminMailboxesRouter.post('/bulk-provision', async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: { active: true },
    select: { id: true, email: true },
  });

  const results = {
    total: users.length,
    provisioned: 0,
    alreadyExisted: 0,
    errors: [] as string[],
  };

  for (const user of users) {
    try {
      const r = await ensureMailboxProvisioned(user.id);
      if (r.alreadyExisted) {
        results.alreadyExisted++;
      } else {
        results.provisioned++;
      }
    } catch (err) {
      results.errors.push(`${user.email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  res.json(results);
});
