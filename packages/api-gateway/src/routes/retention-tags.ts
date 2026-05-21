/**
 * User-facing Retention-Tag API (Phase 9, Exchange-2019-konform)
 *
 * Listet die PERSONAL-Aufbewahrungs-Tags, die End-User selbst Ordnern/Items
 * zuweisen können. DPT/RPT-Tags werden zentral vom Admin verwaltet und sind
 * für User schreibgeschützt.
 *
 * Route:
 *   GET /api/v1/retention-tags  — Liste der zuweisbaren PERSONAL-Tags
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const retentionTagsRouter: RouterType = Router();
retentionTagsRouter.use(requireAuth);

// GET /api/v1/retention-tags — list PERSONAL tags available to the user
retentionTagsRouter.get('/', async (_req: Request, res: Response) => {
  const tags = await prisma.retentionTag.findMany({
    where: { type: 'PERSONAL', enabled: true },
    select: {
      id: true,
      name: true,
      description: true,
      retentionDays: true,
      action: true,
      isSystem: true,
    },
    orderBy: [{ retentionDays: 'asc' }, { name: 'asc' }],
  });
  res.json(tags);
});
