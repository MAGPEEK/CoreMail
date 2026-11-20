/**
 * Admin API — Retention Policies & Tags (Phase 9)
 *
 * Tag concept:
 *   • DPT (Default Policy Tag) — applies to the whole mailbox
 *   • RPT (Retention Policy Tag) — binds to a default folder (Inbox, Sent, …)
 *   • PERSONAL — user-assignable to individual items/folders
 *
 * Hierarchy per item: Personal > RPT > DPT
 *
 * Routes — Tags:
 *   GET    /api/v1/admin/compliance/retention/tags
 *   POST   /api/v1/admin/compliance/retention/tags
 *   PUT    /api/v1/admin/compliance/retention/tags/:id
 *   DELETE /api/v1/admin/compliance/retention/tags/:id
 *
 * Routes — Policies:
 *   GET    /api/v1/admin/compliance/retention
 *   POST   /api/v1/admin/compliance/retention
 *   GET    /api/v1/admin/compliance/retention/:id
 *   PUT    /api/v1/admin/compliance/retention/:id
 *   DELETE /api/v1/admin/compliance/retention/:id
 *   POST   /api/v1/admin/compliance/retention/:id/toggle
 *   POST   /api/v1/admin/compliance/retention/:id/tags/:tagId    — attach tag
 *   DELETE /api/v1/admin/compliance/retention/:id/tags/:tagId    — detach tag
 *
 * Routes — assignments + run:
 *   GET    /api/v1/admin/compliance/retention/:id/assignments
 *   POST   /api/v1/admin/compliance/retention/:id/assignments
 *   DELETE /api/v1/admin/compliance/retention/:id/assignments/:aid
 *   POST   /api/v1/admin/compliance/retention/run                — run MFA now
 *   GET    /api/v1/admin/compliance/retention/targets?q=         — domains + users for assignments
 *   GET    /api/v1/admin/compliance/retention/runs               — MFA run history
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage/prisma';
import { z } from 'zod';
import { patchSchema } from '../../lib/zod-compat.js';
import { requireArea } from '../../middleware/auth.js';
import { requireUnscoped } from '../../middleware/admin-scope.js';
import { internalAuthHeaders } from '@coremail/core';
import { invalidInputMessage } from '../../lib/zod-message.js';

export const adminRetentionRouter: RouterType = Router();
// 9.5: retention policies and tags apply organisation-wide — unscoped admins only.
adminRetentionRouter.use(requireArea('compliance'), requireUnscoped);

// ── Tag CRUD ─────────────────────────────────────────────────────────────────

const TAG_TYPES   = ['DPT', 'RPT', 'PERSONAL'] as const;
const TAG_ACTIONS = ['MOVE_TO_ARCHIVE', 'DELETE_AND_ALLOW_RECOVERY', 'PERMANENTLY_DELETE', 'MARK_AS_PAST_RETENTION_LIMIT'] as const;
const FOLDER_TARGETS = ['INBOX','SENT_ITEMS','DELETED_ITEMS','JUNK_EMAIL','DRAFTS','OUTBOX','RECOVERABLE_ITEMS','ARCHIVE','ALL_OTHER'] as const;

const TagSchema = z.object({
  name:          z.string().min(1).max(120),
  description:   z.string().default(''),
  type:          z.enum(TAG_TYPES),
  action:        z.enum(TAG_ACTIONS),
  retentionDays: z.number().int().min(1),
  folderTarget:  z.enum(FOLDER_TARGETS).optional(),
  enabled:       z.boolean().default(true),
});

type TagType = typeof TAG_TYPES[number];
type FolderTarget = typeof FOLDER_TARGETS[number];

/**
 * Effective folderTarget of a tag (9.1.x): RPT needs one (never ALL_OTHER),
 * DPT is always ALL_OTHER, PERSONAL has none. Returns an error text instead
 * when the combination is invalid. Shared by create and update, so switching
 * a tag's type can no longer leave a stale / missing folderTarget behind.
 */
export function resolveFolderTarget(type: TagType, folderTarget: FolderTarget | null | undefined): { folderTarget: FolderTarget | null } | { error: string } {
  if (type === 'RPT') {
    if (!folderTarget || folderTarget === 'ALL_OTHER') return { error: 'RPT-Tags benötigen einen Standardordner (Posteingang, Gesendet, …)' };
    return { folderTarget };
  }
  if (type === 'DPT') {
    if (folderTarget && folderTarget !== 'ALL_OTHER') return { error: 'DPT-Tags gelten für das ganze Postfach (folderTarget=ALL_OTHER)' };
    return { folderTarget: 'ALL_OTHER' };
  }
  return { folderTarget: null };
}

const isUniqueViolation = (err: unknown): boolean =>
  (err as { code?: unknown })?.code === 'P2002' || String(err).includes('Unique');

adminRetentionRouter.get('/tags', async (_req: Request, res: Response) => {
  const tags = await prisma.retentionTag.findMany({
    include: { _count: { select: { policyTags: true, messages: true, folders: true } } },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });
  res.json(tags);
});

adminRetentionRouter.post('/tags', async (req: Request, res: Response) => {
  const p = TagSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: invalidInputMessage(p.error), details: p.error.issues }); return; }
  const target = resolveFolderTarget(p.data.type, p.data.folderTarget);
  if ('error' in target) { res.status(400).json({ error: target.error }); return; }

  try {
    const tag = await prisma.retentionTag.create({
      data: {
        name: p.data.name, description: p.data.description,
        type: p.data.type, action: p.data.action, retentionDays: p.data.retentionDays,
        ...(target.folderTarget ? { folderTarget: target.folderTarget } : {}),
        enabled: p.data.enabled,
        createdBy: req.apiUser?.userId ?? '',
      },
    });
    res.status(201).json(tag);
  } catch (err) {
    if (isUniqueViolation(err)) { res.status(409).json({ error: 'Tag-Name bereits vergeben' }); return; }
    throw err;
  }
});

adminRetentionRouter.put('/tags/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const tag = await prisma.retentionTag.findUnique({ where: { id } });
  if (!tag) { res.status(404).json({ error: 'Tag not found' }); return; }
  if (tag.isSystem) { res.status(403).json({ error: 'System-Tags können nicht geändert werden' }); return; }

  const p = patchSchema(TagSchema).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: invalidInputMessage(p.error), details: p.error.issues }); return; }

  // Re-validate the EFFECTIVE type/folderTarget (a type switch used to keep the old target)
  const type = p.data.type ?? tag.type;
  const target = resolveFolderTarget(type, p.data.folderTarget !== undefined ? p.data.folderTarget : (p.data.type !== undefined ? undefined : tag.folderTarget));
  if ('error' in target) { res.status(400).json({ error: target.error }); return; }

  // Becoming a DPT must not give a policy a second DPT
  if (type === 'DPT' && tag.type !== 'DPT') {
    const clash = await prisma.retentionPolicyTag.findFirst({
      where: { tag: { type: 'DPT', NOT: { id } }, policy: { policyTags: { some: { tagId: id } } } },
      select: { policyId: true },
    });
    if (clash) { res.status(409).json({ error: 'Eine Richtlinie mit diesem Tag hat bereits einen DPT' }); return; }
  }

  try {
    const updated = await prisma.retentionTag.update({
      where: { id },
      data: {
        ...(p.data.name !== undefined ? { name: p.data.name } : {}),
        ...(p.data.description !== undefined ? { description: p.data.description } : {}),
        type,
        ...(p.data.action !== undefined ? { action: p.data.action } : {}),
        ...(p.data.retentionDays !== undefined ? { retentionDays: p.data.retentionDays } : {}),
        folderTarget: target.folderTarget,
        ...(p.data.enabled !== undefined ? { enabled: p.data.enabled } : {}),
      },
    });
    res.json(updated);
  } catch (err) {
    if (isUniqueViolation(err)) { res.status(409).json({ error: 'Tag-Name bereits vergeben' }); return; }
    throw err;
  }
});

adminRetentionRouter.delete('/tags/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const tag = await prisma.retentionTag.findUnique({ where: { id } });
  if (!tag) { res.status(404).json({ error: 'Tag not found' }); return; }
  if (tag.isSystem) { res.status(403).json({ error: 'System-Tags können nicht gelöscht werden' }); return; }
  await prisma.retentionTag.delete({ where: { id } });
  res.status(204).end();
});

// ── Tag ↔ Policy ─────────────────────────────────────────────────────────────

adminRetentionRouter.post('/:id/tags/:tagId', async (req: Request, res: Response) => {
  const { id, tagId } = req.params as { id: string; tagId: string };
  const [policy, tag] = await Promise.all([
    prisma.retentionPolicy.findUnique({ where: { id } }),
    prisma.retentionTag.findUnique({ where: { id: tagId } }),
  ]);
  if (!policy || !tag) { res.status(404).json({ error: 'Policy oder Tag nicht gefunden' }); return; }

  // A policy may have at most 1 DPT
  if (tag.type === 'DPT') {
    const existingDpt = await prisma.retentionPolicyTag.findFirst({
      where: { policyId: id, tag: { type: 'DPT' } },
    });
    if (existingDpt && existingDpt.tagId !== tagId) {
      res.status(409).json({ error: 'Diese Policy hat bereits einen DPT — bitte erst entfernen' });
      return;
    }
  }

  try {
    await prisma.retentionPolicyTag.create({ data: { policyId: id, tagId } });
    res.status(201).json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Tag ist bereits an diese Policy gehängt' });
  }
});

adminRetentionRouter.delete('/:id/tags/:tagId', async (req: Request, res: Response) => {
  const { id, tagId } = req.params as { id: string; tagId: string };
  await prisma.retentionPolicyTag.delete({
    where: { policyId_tagId: { policyId: id, tagId } },
  }).catch(() => undefined);
  res.status(204).end();
});

// ── MFA run history ───────────────────────────────────────────────────────────

adminRetentionRouter.get('/runs', async (_req: Request, res: Response) => {
  const runs = await prisma.managedFolderRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: 30,
  });
  res.json(runs);
});

// ── Assignment targets (picker) ───────────────────────────────────────────────

/**
 * GET /api/v1/admin/compliance/retention/targets?q=
 * Domains (all) and up to 20 matching users for the assignment picker — the
 * compliance role has no access to the recipients/domains areas.
 */
adminRetentionRouter.get('/targets', async (req: Request, res: Response) => {
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim().slice(0, 100) : '';
  const [domains, users] = await Promise.all([
    prisma.domain.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.user.findMany({
      where: q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { displayName: { contains: q, mode: 'insensitive' } }] } : {},
      select: { id: true, email: true, displayName: true },
      orderBy: { email: 'asc' },
      take: 20,
    }),
  ]);
  res.json({ domains, users });
});

// ── Policy CRUD ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/compliance/retention
 * List all retention policies with their assignment counts.
 */
adminRetentionRouter.get('/', async (_req: Request, res: Response) => {
  const policies = await prisma.retentionPolicy.findMany({
    include: {
      _count: { select: { assignments: true } },
      policyTags: { include: { tag: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json(policies);
});

/**
 * POST /api/v1/admin/compliance/retention
 * Create a retention policy.
 */
adminRetentionRouter.post('/', async (req: Request, res: Response) => {
  const {
    name,
    description,
    retentionDays,
    action,
    targetFolder,
    scope,
    enabled,
  } = req.body as {
    name?: string;
    description?: string;
    retentionDays?: number;
    action?: string;
    targetFolder?: string;
    scope?: string;
    enabled?: boolean;
  };

  if (!name || retentionDays === undefined || retentionDays === null) {
    res.status(400).json({ error: 'name and retentionDays are required' });
    return;
  }

  // 0 is allowed — for tag-based policies the tags control the period, not the policy itself
  if (retentionDays < 0) {
    res.status(400).json({ error: 'retentionDays muss 0 oder größer sein (0 = Frist wird durch Tags gesteuert)' });
    return;
  }

  const validActions = ['ARCHIVE', 'DELETE', 'MOVE_TO_FOLDER'];
  if (action && !validActions.includes(action)) {
    res.status(400).json({ error: `action must be one of: ${validActions.join(', ')}` });
    return;
  }

  if (action === 'MOVE_TO_FOLDER' && !targetFolder) {
    res.status(400).json({ error: 'targetFolder is required when action is MOVE_TO_FOLDER' });
    return;
  }

  const validScopes = ['ALL_ITEMS', 'INBOX', 'SENT_ITEMS', 'DELETED_ITEMS', 'JUNK'];
  if (scope && !validScopes.includes(scope)) {
    res.status(400).json({ error: `scope must be one of: ${validScopes.join(', ')}` });
    return;
  }

  const policy = await prisma.retentionPolicy.create({
    data: {
      name,
      description: description ?? '',
      retentionDays,
      action: (action as 'ARCHIVE' | 'DELETE' | 'MOVE_TO_FOLDER') ?? 'ARCHIVE',
      ...(targetFolder ? { targetFolder } : {}),
      scope: (scope as 'ALL_ITEMS' | 'INBOX' | 'SENT_ITEMS' | 'DELETED_ITEMS' | 'JUNK') ?? 'ALL_ITEMS',
      enabled: enabled ?? true,
      createdBy: req.apiUser!.userId,
    },
    include: { _count: { select: { assignments: true } } },
  });

  res.status(201).json(policy);
});

/**
 * GET /api/v1/admin/compliance/retention/:id
 * Get a specific retention policy.
 */
adminRetentionRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const policy = await prisma.retentionPolicy.findUnique({
    where: { id },
    include: {
      assignments: true,
      policyTags: { include: { tag: true } },
    },
  });
  if (!policy) {
    res.status(404).json({ error: 'Retention policy not found' });
    return;
  }
  res.json(policy);
});

/**
 * PUT /api/v1/admin/compliance/retention/:id
 * Update a retention policy.
 */
adminRetentionRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const {
    name, description, retentionDays, action, targetFolder, scope, enabled,
  } = req.body as {
    name?: string;
    description?: string;
    retentionDays?: number;
    action?: string;
    targetFolder?: string;
    scope?: string;
    enabled?: boolean;
  };

  const existing = await prisma.retentionPolicy.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'Retention policy not found' });
    return;
  }

  if (retentionDays !== undefined && (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays < 0)) {
    res.status(400).json({ error: 'retentionDays muss 0 oder größer sein (0 = Frist wird durch Tags gesteuert)' });
    return;
  }
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    res.status(400).json({ error: 'name darf nicht leer sein' });
    return;
  }
  // 9.1.x: same enum checks as POST (an invalid value used to end in a 500)
  if (action !== undefined && !['ARCHIVE', 'DELETE', 'MOVE_TO_FOLDER'].includes(action)) {
    res.status(400).json({ error: 'action must be one of: ARCHIVE, DELETE, MOVE_TO_FOLDER' });
    return;
  }
  if (scope !== undefined && !['ALL_ITEMS', 'INBOX', 'SENT_ITEMS', 'DELETED_ITEMS', 'JUNK'].includes(scope)) {
    res.status(400).json({ error: 'scope must be one of: ALL_ITEMS, INBOX, SENT_ITEMS, DELETED_ITEMS, JUNK' });
    return;
  }
  if ((action ?? existing.action) === 'MOVE_TO_FOLDER' && !(targetFolder ?? existing.targetFolder)) {
    res.status(400).json({ error: 'targetFolder is required when action is MOVE_TO_FOLDER' });
    return;
  }

  const policy = await prisma.retentionPolicy.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(retentionDays !== undefined ? { retentionDays } : {}),
      ...(action !== undefined ? { action: action as 'ARCHIVE' | 'DELETE' | 'MOVE_TO_FOLDER' } : {}),
      ...(targetFolder !== undefined ? { targetFolder } : {}),
      ...(scope !== undefined ? { scope: scope as 'ALL_ITEMS' | 'INBOX' | 'SENT_ITEMS' | 'DELETED_ITEMS' | 'JUNK' } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    },
    include: { _count: { select: { assignments: true } } },
  });

  res.json(policy);
});

/**
 * DELETE /api/v1/admin/compliance/retention/:id
 * Delete a retention policy (cascades to assignments).
 */
adminRetentionRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const existing = await prisma.retentionPolicy.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'Retention policy not found' });
    return;
  }
  await prisma.retentionPolicy.delete({ where: { id } });
  res.json({ ok: true });
});

/**
 * POST /api/v1/admin/compliance/retention/:id/toggle
 * Enable or disable a retention policy.
 */
adminRetentionRouter.post('/:id/toggle', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const existing = await prisma.retentionPolicy.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'Retention policy not found' });
    return;
  }
  const policy = await prisma.retentionPolicy.update({
    where: { id },
    data: { enabled: !existing.enabled },
  });
  res.json({ ok: true, enabled: policy.enabled });
});

// ── Assignments ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/compliance/retention/:id/assignments
 * List all assignments for a policy.
 */
adminRetentionRouter.get('/:id/assignments', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const assignments = await prisma.retentionPolicyAssignment.findMany({
    where: { policyId: id },
    orderBy: { createdAt: 'asc' },
  });
  // 9.1.x: readable label (USER targets are ids; DOMAIN targets are domain names)
  const userIds = assignments.filter((a) => a.target === 'USER').map((a) => a.targetId);
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
    : [];
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  res.json(assignments.map((a) => ({
    ...a,
    label: a.target === 'GLOBAL' ? 'Alle Postfächer'
      : a.target === 'USER' ? (emailById.get(a.targetId) ?? `${a.targetId} (gelöscht)`)
      : a.targetId,
  })));
});

/**
 * POST /api/v1/admin/compliance/retention/:id/assignments
 * Add an assignment to a policy.
 * Body: { target: "GLOBAL"|"DOMAIN"|"USER", targetId?: string }
 */
adminRetentionRouter.post('/:id/assignments', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { target, targetId } = req.body as {
    target?: string;
    targetId?: string;
  };

  const existing = await prisma.retentionPolicy.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'Retention policy not found' });
    return;
  }

  const validTargets = ['GLOBAL', 'DOMAIN', 'USER'];
  if (!target || !validTargets.includes(target)) {
    res.status(400).json({ error: `target must be one of: ${validTargets.join(', ')}` });
    return;
  }

  if ((target === 'DOMAIN' || target === 'USER') && !targetId) {
    res.status(400).json({ error: 'targetId is required for DOMAIN and USER targets' });
    return;
  }

  // Validate targetId exists
  if (target === 'USER') {
    const user = await prisma.user.findUnique({ where: { id: targetId! } });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
  }

  if (target === 'DOMAIN') {
    const domain = await prisma.domain.findUnique({ where: { name: targetId! } });
    if (!domain) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }
  }

  try {
    const assignment = await prisma.retentionPolicyAssignment.create({
      data: {
        policyId: id,
        target: target as 'GLOBAL' | 'DOMAIN' | 'USER',
        targetId: targetId ?? '',
      },
    });
    res.status(201).json(assignment);
  } catch {
    // Unique constraint violation
    res.status(409).json({ error: 'This assignment already exists' });
  }
});

/**
 * DELETE /api/v1/admin/compliance/retention/:id/assignments/:aid
 * Remove an assignment from a policy.
 */
adminRetentionRouter.delete('/:id/assignments/:aid', async (req: Request, res: Response) => {
  const { id, aid } = req.params as { id: string; aid: string };
  const assignment = await prisma.retentionPolicyAssignment.findFirst({
    where: { id: aid, policyId: id },
  });
  if (!assignment) {
    res.status(404).json({ error: 'Assignment not found' });
    return;
  }
  await prisma.retentionPolicyAssignment.delete({ where: { id: aid } });
  res.json({ ok: true });
});

/**
 * POST /api/v1/admin/compliance/retention/run
 * Manually trigger a retention policy run (admin only).
 * Returns the run results synchronously (may take a while for large orgs).
 */
adminRetentionRouter.post('/run', async (_req: Request, res: Response) => {
  // Lazy import to avoid circular dep with backup-service
  // In practice this route lives in api-gateway, which calls the backup-service HTTP API
  // For now we trigger via internal HTTP to backup-service
  const backupServiceUrl = process.env['BACKUP_SERVICE_URL'] ?? 'http://localhost:3004';

  try {
    const response = await fetch(`${backupServiceUrl}/internal/retention/run`, {
      method: 'POST',
      // v6: /internal/* on the backup-service requires loopback or INTERNAL_API_TOKEN
      headers: { 'Content-Type': 'application/json', ...internalAuthHeaders() },
    });

    if (response.status === 409) {
      // v7.1.0: a run (scheduled or manual, any instance) is still in progress
      res.status(409).json({ error: 'A retention run is already in progress' });
      return;
    }
    if (!response.ok) {
      res.status(502).json({ error: 'Retention run failed', detail: `backup-service HTTP ${response.status}` });
      return;
    }

    const result = await response.json();
    res.json(result);
  } catch (err) {
    res.status(503).json({
      error: 'Backup service unavailable',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});
