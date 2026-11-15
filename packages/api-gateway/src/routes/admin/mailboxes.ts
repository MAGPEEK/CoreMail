import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { hashPassword } from '@coremail/core';
import { checkPasswordPolicy, publishUserAuthChange, revokeAllSessions } from '@coremail/storage/auth';
import { requireArea } from '../../middleware/auth.js';
import { canAssignRole, canManageAccount, USER_ROLES } from '../../lib/rbac.js';
import { ensureMailboxProvisioned } from '../../lib/provision-mailbox.js';

export const adminMailboxesRouter: RouterType = Router();
// v6 RBAC: area 'recipients'. HELP_DESK may additionally PUT /:id (password
// reset / enable-disable of USER accounts only — enforced in the handler).
export const isHelpDeskReset = (role: string, req: Request): boolean =>
  role === 'HELP_DESK' && req.method === 'PUT' && /^\/[^/]+\/?$/.test(req.path);
adminMailboxesRouter.use(requireArea('recipients', isHelpDeskReset));

// Fields of a user that may be returned to admins (never passwordHash).
const PUBLIC_USER_SELECT = {
  id: true, email: true, displayName: true, role: true, active: true,
  quotaBytes: true, usedBytes: true, domainId: true, authSource: true, externalId: true,
  createdAt: true, updatedAt: true,
} as const;

const ROLE_ENUM = z.enum(USER_ROLES);

function forbidden(res: Response, error: string): void {
  res.status(403).json({ error, code: 'FORBIDDEN_ROLE' });
}

// ── Helper: compute real storage from messages ───────────────────────────────
// Aggregates rawSize of all non-deleted messages of a user.
async function calcUsedBytes(userId: string): Promise<number> {
  const result = await prisma.message.aggregate({
    where: {
      deletedAt: null,
      folder: { mailbox: { userId } },
    },
    _sum: { rawSize: true },
  });
  return result._sum.rawSize ?? 0;
}

// GET /api/v1/admin/mailboxes
// Returns all users. usedBytes is computed live from the messages and
// updated in the user record at the same time (lazy sync).
adminMailboxesRouter.get('/', async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, displayName: true, role: true, active: true, quotaBytes: true, usedBytes: true, domainId: true, createdAt: true },
    orderBy: { email: 'asc' },
  });

  // Compute real storage usage for all users in parallel
  const usageMap = await Promise.all(
    users.map(async (u) => ({ id: u.id, usedBytes: await calcUsedBytes(u.id) }))
  );

  // Update usedBytes in the DB (fire-and-forget, do not wait for the result)
  void Promise.all(
    usageMap.map(({ id, usedBytes }) =>
      prisma.user.update({ where: { id }, data: { usedBytes: BigInt(usedBytes) } }).catch(() => null)
    )
  );

  // Response with computed values
  const usageById = Object.fromEntries(usageMap.map(({ id, usedBytes }) => [id, usedBytes]));
  res.json(users.map((u) => ({ ...u, usedBytes: usageById[u.id] ?? 0 })));
});

// GET /api/v1/admin/mailboxes/:id
adminMailboxesRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const [user, usedBytes] = await Promise.all([
    prisma.user.findUnique({
      where: { id },
      // v6: explicit select — never return passwordHash
      select: {
        ...PUBLIC_USER_SELECT,
        mailbox: { include: { folders: { select: { id: true, name: true, displayName: true, totalCount: true, unreadCount: true } } } },
      },
    }),
    calcUsedBytes(id),
  ]);
  if (!user) { res.status(404).json({ error: 'Mailbox not found' }); return; }
  // Update DB (fire-and-forget)
  void prisma.user.update({ where: { id }, data: { usedBytes: BigInt(usedBytes) } }).catch(() => null);
  res.json({ ...user, usedBytes });
});

// POST /api/v1/admin/mailboxes/:id/recalculate-quota
// Recomputes usedBytes from actual message sizes and stores the value.
adminMailboxesRouter.post('/:id/recalculate-quota', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const usedBytes = await calcUsedBytes(id);
  await prisma.user.update({ where: { id }, data: { usedBytes: BigInt(usedBytes) } });
  res.json({ ok: true, userId: id, email: user.email, usedBytes });
});

// POST /api/v1/admin/mailboxes/recalculate-all-quotas
// Recomputes usedBytes for ALL users (admin maintenance function).
adminMailboxesRouter.post('/recalculate-all-quotas', async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  const results = await Promise.all(
    users.map(async (u) => {
      const usedBytes = await calcUsedBytes(u.id);
      await prisma.user.update({ where: { id: u.id }, data: { usedBytes: BigInt(usedBytes) } });
      return { email: u.email, usedBytes };
    })
  );
  res.json({ ok: true, updated: results.length, results });
});

const CreateMailboxSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(1).max(128),
  domainId: z.string(),
  role: ROLE_ENUM.default('USER'),
  quotaBytes: z.number().int().default(5368709120),
});

// POST /api/v1/admin/mailboxes
adminMailboxesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = CreateMailboxSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const { email, displayName, password, domainId, role, quotaBytes } = parsed.data;
  // v6 escalation guard: only ORGANIZATION_MANAGEMENT may create admin accounts
  if (!canAssignRole(req.apiUser?.role, role)) {
    forbidden(res, 'Only Organization Management may assign admin roles'); return;
  }
  // v7.0.0: minimum length from ServerSettings.minPasswordLength
  const policyError = await checkPasswordPolicy(password);
  if (policyError) { res.status(400).json({ error: policyError }); return; }

  {
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) { res.status(409).json({ error: 'E-Mail-Adresse wird bereits verwendet' }); return; }

    const domain = await prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) { res.status(404).json({ error: 'Domain nicht gefunden' }); return; }

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(), displayName, passwordHash, role, quotaBytes: BigInt(quotaBytes), domainId,
        mailbox: {
          create: {
            folders: {
              create: [
                { name: 'INBOX',   displayName: 'Inbox',         totalCount: 0, unreadCount: 0 },
                { name: 'Drafts',  displayName: 'Drafts',        totalCount: 0, unreadCount: 0 },
                { name: 'Sent',    displayName: 'Sent Items',    totalCount: 0, unreadCount: 0 },
                { name: 'Trash',   displayName: 'Deleted Items', totalCount: 0, unreadCount: 0 },
                { name: 'Junk',    displayName: 'Junk Email',    totalCount: 0, unreadCount: 0 },
                { name: 'Archive', displayName: 'Archive',       totalCount: 0, unreadCount: 0 },
              ],
            },
          },
        },
        calendars: { create: [{ name: 'Kalender', color: '#0078D4', isDefault: true, sortOrder: 0 }] },
      },
      select: { id: true, email: true, displayName: true, role: true, createdAt: true },
    });
    res.status(201).json(user);
  }
  // v6: no local catch that echoed err.message (Prisma messages contain query
  // details) — the shared error middleware maps P2002 → 409 etc. and logs the rest.
});

const UpdateMailboxSchema = z.object({
  displayName: z.string().min(1).optional(),
  role: ROLE_ENUM.optional(), // v6: was z.string() → invalid enum value crashed Prisma
  active: z.boolean().optional(),
  quotaBytes: z.number().int().min(0).optional(),
  password: z.string().min(1).max(128).optional(), // length policy: checkPasswordPolicy()
}).strict();

// Fields HELP_DESK may change (password reset + enable/disable).
const HELP_DESK_FIELDS = new Set(['password', 'active']);

// PUT /api/v1/admin/mailboxes/:id
adminMailboxesRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = UpdateMailboxSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, active: true } });
  if (!user) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  // v6 escalation guards
  const actor = req.apiUser!;
  const isSelf = actor.userId === id;
  if (actor.role === 'HELP_DESK' && Object.keys(parsed.data).some((k) => !HELP_DESK_FIELDS.has(k))) {
    forbidden(res, 'Help Desk may only reset passwords or enable/disable accounts'); return;
  }
  if (!canAssignRole(actor.role, parsed.data.role, user.role)) {
    forbidden(res, 'Only Organization Management may change roles'); return;
  }
  if (!isSelf && !canManageAccount(actor.role, user.role)) {
    forbidden(res, 'Only Organization Management may modify admin accounts'); return;
  }

  const { displayName, role, active, quotaBytes, password } = parsed.data;
  if (password) {
    // v7.0.0: minimum length from ServerSettings.minPasswordLength
    const policyError = await checkPasswordPolicy(password);
    if (policyError) { res.status(400).json({ error: policyError }); return; }
  }
  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(displayName ? { displayName } : {}),
      ...(role ? { role } : {}),
      ...(active !== undefined ? { active } : {}),
      ...(quotaBytes !== undefined ? { quotaBytes: BigInt(quotaBytes) } : {}),
      ...(password ? { passwordHash: await hashPassword(password) } : {}),
    },
    select: { id: true, email: true, displayName: true, role: true, active: true },
  });
  // v7.0.0: an admin password reset or a deactivation ends all web/API sessions
  // (app passwords are kept; inactive users cannot use them anyway).
  if (password || (active === false && user.active)) {
    await revokeAllSessions(id, { reason: password ? 'admin-password-reset' : 'deactivated' });
  } else if ((role && role !== user.role) || (active !== undefined && active !== user.active)) {
    // v7.0.1: cached logins carry the role / active state — drop them now.
    await publishUserAuthChange(id, role && role !== user.role ? 'role-change' : 'reactivated');
  }
  res.json(updated);
});

// DELETE /api/v1/admin/mailboxes/:id
adminMailboxesRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!user) { res.status(404).json({ error: 'Mailbox not found' }); return; }
  if (!canManageAccount(req.apiUser?.role, user.role)) {
    forbidden(res, 'Only Organization Management may delete admin accounts'); return;
  }
  await prisma.user.delete({ where: { id } });
  // v7.0.1: access tokens + cached mail logins of the deleted user end now
  // (session rows are already gone via cascade; this sets the revocation mark).
  await revokeAllSessions(id, { reason: 'deleted' });
  res.json({ ok: true });
});

// ── Mailbox delegation (user mailbox access rights) ─────────────────────────

// GET /api/v1/admin/mailboxes/:id/delegates
adminMailboxesRouter.get('/:id/delegates', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const mailbox = await prisma.mailbox.findUnique({
    where: { userId: id },
    include: {
      delegates: {
        include: { grantee: { select: { id: true, email: true, displayName: true } } },
        orderBy: { grantedAt: 'asc' },
      },
    },
  });
  res.json(mailbox?.delegates ?? []);
});

// POST /api/v1/admin/mailboxes/:id/delegates — grant / update access
adminMailboxesRouter.post('/:id/delegates', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const schema = z.object({
    granteeId: z.string(),
    permission: z.enum(['FULL_ACCESS', 'SEND_AS', 'SEND_ON_BEHALF', 'READ_ONLY']),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (parsed.data.granteeId === id) { res.status(400).json({ error: 'User cannot delegate to themselves' }); return; }

  const mailbox = await prisma.mailbox.findUnique({ where: { userId: id } });
  if (!mailbox) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  // v6: unknown grantee used to crash with a Prisma FK error
  const grantee = await prisma.user.findUnique({ where: { id: parsed.data.granteeId }, select: { id: true } });
  if (!grantee) { res.status(404).json({ error: 'Grantee not found' }); return; }

  // Upsert: update if exists, create if not
  const delegate = await prisma.mailboxDelegate.upsert({
    where: { mailboxId_granteeId: { mailboxId: mailbox.id, granteeId: parsed.data.granteeId } },
    update: { permission: parsed.data.permission, grantedBy: req.apiUser!.userId },
    create: {
      mailboxId: mailbox.id,
      granteeId: parsed.data.granteeId,
      permission: parsed.data.permission,
      grantedBy: req.apiUser!.userId,
    },
  });
  res.status(201).json(delegate);
});

// DELETE /api/v1/admin/mailboxes/:id/delegates/:granteeId — revoke access
adminMailboxesRouter.delete('/:id/delegates/:granteeId', async (req: Request, res: Response) => {
  const { id, granteeId } = req.params as { id: string; granteeId: string };

  const mailbox = await prisma.mailbox.findUnique({ where: { userId: id } });
  if (!mailbox) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  await prisma.mailboxDelegate.deleteMany({ where: { mailboxId: mailbox.id, granteeId } });
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
