/**
 * User-facing retention tag API (Phase 9, Exchange 2019 compliant)
 *
 * Lists the PERSONAL retention tags that end users can assign to folders/items
 * themselves. DPT/RPT tags are managed centrally by the admin and are
 * read-only for users.
 *
 * Route:
 *   GET /api/v1/retention-tags  — list of assignable PERSONAL tags
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
