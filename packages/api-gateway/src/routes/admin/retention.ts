/**
 * Admin API — Retention Policies (Phase 9)
 *
 * ECP → Compliance Management → Retention Policies
 *
 * Routes:
 *   GET    /api/v1/admin/compliance/retention                       — list policies
 *   POST   /api/v1/admin/compliance/retention                       — create policy
 *   GET    /api/v1/admin/compliance/retention/:id                   — get policy
 *   PUT    /api/v1/admin/compliance/retention/:id                   — update policy
 *   DELETE /api/v1/admin/compliance/retention/:id                   — delete policy
 *   POST   /api/v1/admin/compliance/retention/:id/toggle            — enable/disable
 *   GET    /api/v1/admin/compliance/retention/:id/assignments       — list assignments
 *   POST   /api/v1/admin/compliance/retention/:id/assignments       — add assignment
 *   DELETE /api/v1/admin/compliance/retention/:id/assignments/:aid  — remove assignment
 *   POST   /api/v1/admin/compliance/retention/run                   — trigger manual run
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage/prisma';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';

export const adminRetentionRouter: RouterType = Router();
adminRetentionRouter.use(requireAuth, requireAdmin);

// ── Policy CRUD ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/compliance/retention
 * List all retention policies with their assignment counts.
 */
adminRetentionRouter.get('/', async (_req: Request, res: Response) => {
  const policies = await prisma.retentionPolicy.findMany({
    include: { _count: { select: { assignments: true } } },
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
    respectLegalHold,
    enabled,
  } = req.body as {
    name?: string;
    description?: string;
    retentionDays?: number;
    action?: string;
    targetFolder?: string;
    scope?: string;
    respectLegalHold?: boolean;
    enabled?: boolean;
  };

  if (!name || retentionDays === undefined || retentionDays === null) {
    res.status(400).json({ error: 'name and retentionDays are required' });
    return;
  }

  if (retentionDays < 1) {
    res.status(400).json({ error: 'retentionDays must be at least 1' });
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
      respectLegalHold: respectLegalHold ?? true,
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
    include: { assignments: true },
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
    name, description, retentionDays, action, targetFolder, scope, respectLegalHold, enabled,
  } = req.body as {
    name?: string;
    description?: string;
    retentionDays?: number;
    action?: string;
    targetFolder?: string;
    scope?: string;
    respectLegalHold?: boolean;
    enabled?: boolean;
  };

  const existing = await prisma.retentionPolicy.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ error: 'Retention policy not found' });
    return;
  }

  if (retentionDays !== undefined && retentionDays < 1) {
    res.status(400).json({ error: 'retentionDays must be at least 1' });
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
      ...(respectLegalHold !== undefined ? { respectLegalHold } : {}),
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
  res.json(assignments);
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
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const body = await response.text();
      res.status(502).json({ error: 'Retention run failed', detail: body });
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
