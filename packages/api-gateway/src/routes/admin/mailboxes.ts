import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, resetQuotaCache, purgeRecoverableItems, getQuotaStatus, announceUserEvent } from '@coremail/storage';
import { hashPassword } from '@coremail/core';
import { checkPasswordPolicy, publishUserAuthChange, revokeAllSessions } from '@coremail/storage/auth';
import { requireArea } from '../../middleware/auth.js';
import { canAssignRole, canManageAccount, hasAdminAction, mailboxUpdateFields, USER_ROLES } from '../../lib/rbac.js';
import { ensureMailboxProvisioned } from '../../lib/provision-mailbox.js';
import { audit, auditContext } from '../../lib/audit.js';
import { quotaLevelError, quotaLevelPatchError } from '../../lib/quota-levels.js';
import { publishPermissionChange } from '../../lib/permission-events.js';
import { addressCollision } from '../../lib/address-collision.js';
import { getMailFlowHandler, putMailFlowHandler } from '../../lib/mail-flow-admin.js';
import { listFolderPermissionsHandler, getFolderPermissionsHandler, putFolderPermissionsHandler } from '../../lib/folder-permissions-admin.js';
import { allowDomain, redactorOf, requireUnscoped, scopeOf, scopeParam, targetInScope } from '../../middleware/admin-scope.js';
import { domainIdWhere } from '../../lib/admin-scope.js';

export const adminMailboxesRouter: RouterType = Router();
// v6 RBAC: area 'recipients'. HELP_DESK may additionally PUT /:id (password
// reset / enable-disable of USER accounts only — enforced in the handler) and
// (v8.1) POST /:id/revoke-sessions ("sign out everywhere", USER accounts only).
// 8.x: who gets these extras comes from the action map (lib/rbac.ts ADMIN_ACTIONS).
// 8.1: only real ids match — the fixed (non-id) paths of this router are never
// an `:id` (PUT /quota-defaults used to slip through for HELP_DESK).
export const RESERVED_MAILBOX_PATHS: ReadonlySet<string> = new Set([
  'quota-defaults', 'recalculate-all-quotas', 'bulk-provision',
]);
const idOf = (path: string, re: RegExp): string | null => {
  const m = re.exec(path);
  if (!m?.[1]) return null;
  let id: string;
  try { id = decodeURIComponent(m[1]); } catch { return null; }
  return RESERVED_MAILBOX_PATHS.has(id.toLowerCase()) ? null : id;
};
export const isHelpDeskReset = (role: string, req: Request): boolean =>
  (req.method === 'PUT' && idOf(req.path, /^\/([^/]+)\/?$/) !== null
    && (hasAdminAction(role, 'resetPassword') || hasAdminAction(role, 'toggleActive')))
  || (req.method === 'POST' && idOf(req.path, /^\/([^/]+)\/revoke-sessions\/?$/) !== null && hasAdminAction(role, 'revokeSessions'));
adminMailboxesRouter.use(requireArea('recipients', isHelpDeskReset));
// Route-level guard for the fixed paths: recipients write only, no extras
// (defence in depth should the router-level predicate ever widen again).
// 9.5: they act on every mailbox / the server defaults — organisation-wide admins only.
const requireRecipientsWrite = [requireArea('recipients'), requireUnscoped];
// 9.5: a mailbox outside the admin's management scope is "not found" on every /:id route.
adminMailboxesRouter.param('id', scopeParam('user'));

// Fields of a user that may be returned to admins (never passwordHash).
const PUBLIC_USER_SELECT = {
  id: true, email: true, displayName: true, role: true, active: true,
  quotaBytes: true, usedBytes: true, domainId: true, authSource: true, externalId: true,
  quotaWarningBytes: true, quotaProhibitSendBytes: true, quotaWarnedAt: true,
  createdAt: true, updatedAt: true, lastLoginAt: true,
} as const;

const QuotaDefaultsSchema = z.object({
  quotaWarningPercent: z.number().int().min(1).max(100).optional(),
  quotaProhibitSendPercent: z.number().int().min(1).max(100).optional(),
}).strict();

// GET /api/v1/admin/mailboxes/quota-defaults — v8.1 server-wide quota levels
// (percent of a mailbox's quota, used when the mailbox sets no own level)
adminMailboxesRouter.get('/quota-defaults', async (_req: Request, res: Response) => {
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { quotaWarningPercent: true, quotaProhibitSendPercent: true },
  });
  res.json({ quotaWarningPercent: s?.quotaWarningPercent ?? 83, quotaProhibitSendPercent: s?.quotaProhibitSendPercent ?? 87 });
});

// PUT /api/v1/admin/mailboxes/quota-defaults
adminMailboxesRouter.put('/quota-defaults', requireRecipientsWrite, async (req: Request, res: Response) => {
  const parsed = QuotaDefaultsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const cur = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' }, select: { quotaWarningPercent: true, quotaProhibitSendPercent: true },
  });
  const before = { quotaWarningPercent: cur?.quotaWarningPercent ?? 83, quotaProhibitSendPercent: cur?.quotaProhibitSendPercent ?? 87 };
  const warning = parsed.data.quotaWarningPercent ?? before.quotaWarningPercent;
  const send = parsed.data.quotaProhibitSendPercent ?? before.quotaProhibitSendPercent;
  if (warning > send) { res.status(400).json({ error: 'quotaWarningPercent must not exceed quotaProhibitSendPercent' }); return; }
  const data = { quotaWarningPercent: warning, quotaProhibitSendPercent: send };
  await prisma.serverSettings.upsert({ where: { id: 'singleton' }, update: data, create: { id: 'singleton', ...data } });
  resetQuotaCache();
  audit({
    actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
    action: 'mailbox.quota-defaults.update', targetType: 'settings', targetId: 'singleton', targetName: 'quota-defaults',
    changes: { before, after: data },
    ...auditContext(req),
  });
  res.json(data);
});

const ROLE_ENUM = z.enum(USER_ROLES);

function forbidden(res: Response, error: string): void {
  res.status(403).json({ error, code: 'FORBIDDEN_ROLE' });
}

/**
 * Lock-out guard: true when the change would leave no active ORGANIZATION_MANAGEMENT
 * account (demoting, deactivating or deleting the last one). Only that role can
 * assign roles, so the organisation could not be administered any more.
 */
async function removesLastOrgAdmin(
  user: { id: string; role: string; active: boolean },
  change: { role?: string | undefined; active?: boolean | undefined; deleted?: boolean },
): Promise<boolean> {
  if (user.role !== 'ORGANIZATION_MANAGEMENT' || !user.active) return false;
  const losesRole = change.deleted === true
    || (change.role !== undefined && change.role !== 'ORGANIZATION_MANAGEMENT')
    || change.active === false;
  if (!losesRole) return false;
  const others = await prisma.user.count({
    where: { role: 'ORGANIZATION_MANAGEMENT', active: true, id: { not: user.id } },
  });
  return others === 0;
}
const LAST_ORG_ADMIN = {
  error: 'This is the last active Organization Management account — assign the role to another account first.',
  code: 'LAST_ORG_ADMIN',
} as const;

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
// Returns all users (9.5: of the admin's management scope). usedBytes is
// computed live from the messages and updated in the user record at the same
// time (lazy sync).
adminMailboxesRouter.get('/', async (req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: domainIdWhere(scopeOf(req)),
    select: {
      id: true, email: true, displayName: true, role: true, active: true, quotaBytes: true, usedBytes: true, domainId: true, createdAt: true,
      lastLoginAt: true, quotaWarningBytes: true, quotaProhibitSendBytes: true,
    },
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
  // v8.1: effective quota levels (explicit or server default) + current level
  const quota = await getQuotaStatus({ kind: 'user', id }, { fresh: true }).catch(() => null);
  res.json({ ...user, usedBytes, ...(quota ? { quotaLimits: quota.limits, quotaLevel: quota.level } : {}) });
});

// POST /api/v1/admin/mailboxes/:id/recoverable/purge — v8.1: permanently remove
// the user's recoverable (deleted) items before DELETED_ITEM_RETENTION_DAYS ends.
// Body { ids?: string[] } — without ids every recoverable item is purged.
adminMailboxesRouter.post('/:id/recoverable/purge', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(10_000).optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const user = await prisma.user.findUnique({ where: { id }, select: { role: true, mailbox: { select: { id: true } } } });
  if (!user?.mailbox) { res.status(404).json({ error: 'Mailbox not found' }); return; }
  if (req.apiUser!.userId !== id && !canManageAccount(req.apiUser!.role, user.role)) {
    forbidden(res, 'Only Organization Management may modify admin accounts'); return;
  }
  const purged = await purgeRecoverableItems(user.mailbox.id, parsed.data.ids);
  audit({
    actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
    action: 'mailbox.recoverable.purge', targetType: 'mailbox', targetId: id,
    changes: { purged, ...(parsed.data.ids ? { ids: parsed.data.ids.length } : { all: true }) },
    ...auditContext(req),
  });
  res.json({ ok: true, purged });
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
adminMailboxesRouter.post('/recalculate-all-quotas', requireRecipientsWrite, async (_req: Request, res: Response) => {
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
  email: z.string().trim().email(),
  displayName: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(128),
  domainId: z.string(),
  role: ROLE_ENUM.default('USER'),
  quotaBytes: z.number().int().min(0).default(5368709120),
  quotaWarningBytes: z.number().int().min(0).nullable().optional(),
  quotaProhibitSendBytes: z.number().int().min(0).nullable().optional(),
});

// POST /api/v1/admin/mailboxes
adminMailboxesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = CreateMailboxSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const { email, displayName, password, domainId, role, quotaBytes, quotaWarningBytes, quotaProhibitSendBytes } = parsed.data;
  const levelError = quotaLevelError(quotaWarningBytes, quotaProhibitSendBytes, quotaBytes);
  if (levelError) { res.status(400).json({ error: levelError }); return; }
  // v6 escalation guard: only ORGANIZATION_MANAGEMENT may create admin accounts
  if (!canAssignRole(req.apiUser?.role, role)) {
    forbidden(res, 'Only Organization Management may assign admin roles'); return;
  }
  // v7.0.0: minimum length from ServerSettings.minPasswordLength
  const policyError = await checkPasswordPolicy(password);
  if (policyError) { res.status(400).json({ error: policyError }); return; }

  {
    // 9.5: a scoped admin creates mailboxes only in its own domains — checked
    // before the address lookup, so an address of another domain is never probed
    if (!allowDomain(req, res, domainId)) return;
    const domain = await prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
    // The address must belong to the chosen domain (domain-scoped settings, LDAP/SSO
    // and the domain filter all go by domainId).
    if (email.toLowerCase().split('@')[1] !== domain.name.toLowerCase()) {
      res.status(400).json({ error: `The address must end in @${domain.name}` }); return;
    }

    // users, shared mailboxes and aliases share one address namespace
    const collision = await addressCollision(email);
    if (collision) { res.status(409).json({ error: collision }); return; }

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(), displayName, passwordHash, role, quotaBytes: BigInt(quotaBytes), domainId,
        ...(typeof quotaWarningBytes === 'number' ? { quotaWarningBytes: BigInt(quotaWarningBytes) } : {}),
        ...(typeof quotaProhibitSendBytes === 'number' ? { quotaProhibitSendBytes: BigInt(quotaProhibitSendBytes) } : {}),
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
  displayName: z.string().trim().min(1).max(200).optional(),
  role: ROLE_ENUM.optional(), // v6: was z.string() → invalid enum value crashed Prisma
  active: z.boolean().optional(),
  quotaBytes: z.number().int().min(0).optional(),
  // v8.1: Exchange quota levels (IssueWarningQuota / ProhibitSendQuota);
  // null = server default (percent of quotaBytes = ProhibitSendReceiveQuota).
  quotaWarningBytes: z.number().int().min(0).nullable().optional(),
  quotaProhibitSendBytes: z.number().int().min(0).nullable().optional(),
  password: z.string().min(1).max(128).optional(), // length policy: checkPasswordPolicy()
  // 8.0.0: with `password` — also delete all app passwords of the user (and end
  // the mail connections using them), e.g. when the account was compromised.
  // Default false: a plain reset keeps app passwords (pre-8.0 behaviour).
  revokeAppPasswords: z.boolean().optional(),
}).strict();

// Fields a role WITHOUT write on recipients may change come from its actions
// (HELP_DESK: password reset + enable/disable) — lib/rbac.ts mailboxUpdateFields().

// PUT /api/v1/admin/mailboxes/:id
adminMailboxesRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = UpdateMailboxSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, active: true, quotaBytes: true, quotaWarningBytes: true, quotaProhibitSendBytes: true },
  });
  if (!user) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  // v6 escalation guards
  const actor = req.apiUser!;
  const isSelf = actor.userId === id;
  const limitedFields = mailboxUpdateFields(actor.role);
  if (limitedFields && Object.keys(parsed.data).some((k) => !limitedFields.has(k))) {
    forbidden(res, 'Help Desk may only reset passwords or enable/disable accounts'); return;
  }
  if (!canAssignRole(actor.role, parsed.data.role, user.role)) {
    forbidden(res, 'Only Organization Management may change roles'); return;
  }
  if (!isSelf && !canManageAccount(actor.role, user.role)) {
    forbidden(res, 'Only Organization Management may modify admin accounts'); return;
  }

  const { displayName, role, active, quotaBytes, quotaWarningBytes, quotaProhibitSendBytes, password, revokeAppPasswords } = parsed.data;
  if (revokeAppPasswords && !password) {
    res.status(400).json({ error: 'revokeAppPasswords is only valid together with password' }); return;
  }
  if (await removesLastOrgAdmin(user, { role, active })) { res.status(409).json(LAST_ORG_ADMIN); return; }
  // 8.1: partial updates are validated against the stored levels
  const levelError = quotaLevelPatchError({ quotaBytes, quotaWarningBytes, quotaProhibitSendBytes }, user);
  if (levelError) { res.status(400).json({ error: levelError }); return; }
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
      ...(quotaWarningBytes !== undefined ? { quotaWarningBytes: quotaWarningBytes === null ? null : BigInt(quotaWarningBytes) } : {}),
      ...(quotaProhibitSendBytes !== undefined ? { quotaProhibitSendBytes: quotaProhibitSendBytes === null ? null : BigInt(quotaProhibitSendBytes) } : {}),
      ...(password ? { passwordHash: await hashPassword(password) } : {}),
    },
    select: { id: true, email: true, displayName: true, role: true, active: true },
  });
  // 9.4: a quota change reaches the user's open webmail
  if (quotaBytes !== undefined || quotaWarningBytes !== undefined || quotaProhibitSendBytes !== undefined) {
    announceUserEvent(id, { type: 'quota' });
  }
  // v7.0.0: an admin password reset or a deactivation ends all web/API sessions
  // (app passwords are kept unless revokeAppPasswords is set; inactive users
  // cannot use them anyway).
  const roleChanged = !!role && role !== user.role;
  if (roleChanged) {
    // always logged (ALWAYS_AUDIT matches user.role), with the old/new role diff —
    // the generic middleware entry is only `mailboxes.put`
    audit({
      actorId: actor.userId, actorEmail: actor.email,
      action: 'user.role.change', targetType: 'user', targetId: id, targetName: user.email,
      changes: { before: { role: user.role }, after: { role } },
      ...auditContext(req),
    });
  }
  if (password || (active === false && user.active)) {
    const r = await revokeAllSessions(id, {
      reason: password ? 'admin-password-reset' : 'deactivated',
      ...(password && revokeAppPasswords ? { appPasswords: true } : {}),
    });
    if (password && revokeAppPasswords) {
      res.json({ ...updated, appPasswordsRevoked: r.appPasswords });
      return;
    }
  } else if (roleChanged) {
    // v7.1.0: the role travels in the access token — a role change ends all
    // web/API sessions (refresh tokens included) so no token keeps the old
    // role. Mail-protocol logins and app passwords are not affected.
    await revokeAllSessions(id, { reason: 'role-change' });
  } else if (active !== undefined && active !== user.active) {
    // v7.1.0: cached logins carry the active state — drop them now.
    await publishUserAuthChange(id, 'reactivated');
  }
  res.json(updated);
});

// DELETE /api/v1/admin/mailboxes/:id
adminMailboxesRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, active: true } });
  if (!user) { res.status(404).json({ error: 'Mailbox not found' }); return; }
  if (!canManageAccount(req.apiUser?.role, user.role)) {
    forbidden(res, 'Only Organization Management may delete admin accounts'); return;
  }
  // e.g. a bulk delete with the own row selected
  if (req.apiUser?.userId === id) {
    res.status(409).json({ error: 'You cannot delete your own account', code: 'SELF_DELETE' }); return;
  }
  if (await removesLastOrgAdmin(user, { deleted: true })) { res.status(409).json(LAST_ORG_ADMIN); return; }
  await prisma.user.delete({ where: { id } });
  // v7.1.0: access tokens + cached mail logins of the deleted user end now
  // (session rows are already gone via cascade; this sets the revocation mark).
  await revokeAllSessions(id, { reason: 'deleted' });
  res.json({ ok: true });
});

// POST /api/v1/admin/mailboxes/:id/revoke-sessions — "sign out everywhere" (v8.1)
// Replaces the removed DELETE /auth/sessions/admin/:userId. Ends every web/API
// session of the user (refresh tokens deleted, access tokens rejected via the
// revocation marks, live SSE/EAS/JMAP connections closed through
// publishUserAuthChange). App passwords are kept — revoke them via a password
// reset with revokeAppPasswords.
adminMailboxesRouter.post('/:id/revoke-sessions', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  const actor = req.apiUser!;
  if (actor.userId !== id && !canManageAccount(actor.role, user.role)) {
    forbidden(res, 'Only Organization Management may sign out admin accounts'); return;
  }
  const r = await revokeAllSessions(id, { reason: 'admin-revoke-sessions' });
  audit({
    actorId: actor.userId, actorEmail: actor.email,
    action: 'mailbox.sessions.revoke', targetType: 'mailbox', targetId: id, targetName: user.email,
    changes: { sessionsRevoked: r.sessions },
    ...auditContext(req),
  });
  res.json({ ok: true, sessionsRevoked: r.sessions });
});

// ── 9.4: per-mailbox mail flow (lib/mail-flow-admin.ts) ─────────────────────
adminMailboxesRouter.get('/:id/mail-flow', getMailFlowHandler('user'));
adminMailboxesRouter.put('/:id/mail-flow', putMailFlowHandler('user'));

// ── w3: folder permissions (lib/folder-permissions-admin.ts) ────────────────
adminMailboxesRouter.get('/:id/folder-permissions', listFolderPermissionsHandler('user'));
adminMailboxesRouter.get('/:id/folders/:folderId/permissions', getFolderPermissionsHandler('user'));
// 9.5: recipients write (not requireRecipientsWrite — that one is organisation-wide only); the scope is checked by param('id')
adminMailboxesRouter.put('/:id/folders/:folderId/permissions', requireArea('recipients'), putFolderPermissionsHandler('user'));

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
  // w3: grantees of other domains are shown as "(andere Domain)" to a scoped admin
  const redactor = await redactorOf(req);
  res.json((mailbox?.delegates ?? []).map((d) => (d.grantee ? { ...d, grantee: redactor.person(d.grantee) } : d)));
});

// POST /api/v1/admin/mailboxes/:id/delegates — grant / update access
adminMailboxesRouter.post('/:id/delegates', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const schema = z.object({
    granteeId: z.string(),
    permission: z.enum(['FULL_ACCESS', 'SEND_AS', 'SEND_ON_BEHALF', 'READ_ONLY']),
    // 9.4 auto-mapping (default on): off → the grantee adds the mailbox to the folder pane / IMAP list
    autoMap: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (parsed.data.granteeId === id) { res.status(400).json({ error: 'User cannot delegate to themselves' }); return; }

  // A delegation is access to the owner's mail: the same rule as for modifying
  // the account applies (admin mailboxes are ORGANIZATION_MANAGEMENT-only), and
  // a non-ORG admin must never grant mailbox access to themselves.
  const actor = req.apiUser!;
  if (!canManageAccount(actor.role, user.role)) {
    forbidden(res, 'Only Organization Management may delegate access to admin mailboxes'); return;
  }
  if (parsed.data.granteeId === actor.userId && actor.role !== 'ORGANIZATION_MANAGEMENT') {
    forbidden(res, 'Admins may not grant mailbox access to themselves'); return;
  }

  const mailbox = await prisma.mailbox.findUnique({ where: { userId: id } });
  if (!mailbox) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  // v6: unknown grantee used to crash with a Prisma FK error.
  // 9.5: a grantee outside the admin's scope is "not found" as well.
  const grantee = await prisma.user.findUnique({ where: { id: parsed.data.granteeId }, select: { id: true, email: true } });
  if (!grantee || !(await targetInScope(req, 'user', grantee.id))) { res.status(404).json({ error: 'Grantee not found' }); return; }

  // Upsert: update if exists, create if not
  const delegate = await prisma.mailboxDelegate.upsert({
    where: { mailboxId_granteeId: { mailboxId: mailbox.id, granteeId: parsed.data.granteeId } },
    update: {
      permission: parsed.data.permission, grantedBy: req.apiUser!.userId,
      ...(parsed.data.autoMap !== undefined ? { autoMap: parsed.data.autoMap } : {}),
    },
    create: {
      mailboxId: mailbox.id,
      granteeId: parsed.data.granteeId,
      permission: parsed.data.permission,
      grantedBy: req.apiUser!.userId,
      ...(parsed.data.autoMap !== undefined ? { autoMap: parsed.data.autoMap } : {}),
    },
  });
  audit({
    actorId: actor.userId, actorEmail: actor.email,
    action: 'mailbox.delegate.grant', targetType: 'mailbox', targetId: id, targetName: user.email,
    changes: {
      owner: user.email, grantee: grantee.email, granteeId: grantee.id, permission: parsed.data.permission,
      ...(parsed.data.autoMap !== undefined ? { autoMap: parsed.data.autoMap } : {}),
    },
    ...auditContext(req),
  });
  await publishPermissionChange([grantee.id]); // 9.1: grantee caches (IMAP, JMAP) refresh at once
  res.status(201).json(delegate);
});

// DELETE /api/v1/admin/mailboxes/:id/delegates/:granteeId — revoke access
adminMailboxesRouter.delete('/:id/delegates/:granteeId', async (req: Request, res: Response) => {
  const { id, granteeId } = req.params as { id: string; granteeId: string };

  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  const actor = req.apiUser!;
  if (!canManageAccount(actor.role, user.role)) {
    forbidden(res, 'Only Organization Management may change delegations of admin mailboxes'); return;
  }

  const mailbox = await prisma.mailbox.findUnique({ where: { userId: id } });
  if (!mailbox) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  const grantee = await prisma.user.findUnique({ where: { id: granteeId }, select: { email: true } });
  const removed = await prisma.mailboxDelegate.deleteMany({ where: { mailboxId: mailbox.id, granteeId } });
  audit({
    actorId: actor.userId, actorEmail: actor.email,
    action: 'mailbox.delegate.revoke', targetType: 'mailbox', targetId: id, targetName: user.email,
    changes: { owner: user.email, grantee: grantee?.email ?? granteeId, granteeId, removed: removed.count },
    ...auditContext(req),
  });
  if (removed.count > 0) await publishPermissionChange([granteeId]); // 9.1: a selected folder closes ([CLOSED])
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
adminMailboxesRouter.post('/bulk-provision', requireRecipientsWrite, async (_req: Request, res: Response) => {
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
