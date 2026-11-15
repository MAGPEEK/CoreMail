/**
 * v7.1 object storage admin API — /api/v1/admin/storage (ORGANIZATION_MANAGEMENT only).
 *
 *   GET  /                 driver, location, startup-check result, migration job
 *   POST /check            re-run the storage check now
 *   GET  /migrate          current / last migration job
 *   POST /migrate          { from, to, dryRun?, verifyExisting? } → 202, background job
 *   POST /migrate/cancel   stop the running job (copied objects stay; resume = start again)
 *
 * Used by `coremail storage status|check|migrate` (packages/cli).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { getObjectStore, getStorageHealth } from '@coremail/storage';
import { requireRole } from '../../middleware/auth.js';
import { startMigration, getMigrationJob, cancelMigration, isDriver } from '../../lib/storage-migration.js';

export const adminStorageRouter: RouterType = Router();
adminStorageRouter.use(requireRole());

const driverSchema = z.string().refine(isDriver, 'from/to must be one of minio, s3, filesystem');
const migrateSchema = z.object({
  from: driverSchema,
  to: driverSchema,
  dryRun: z.boolean().optional(),
  verifyExisting: z.boolean().optional(),
}).strict();

function storeInfo(): { driver: string; location: string } | { driver: null; location: null; error: string } {
  try {
    const s = getObjectStore();
    return { driver: s.driver, location: s.location };
  } catch (err) {
    return { driver: null, location: null, error: (err as Error).message };
  }
}

adminStorageRouter.get('/', async (_req: Request, res: Response) => {
  const info = storeInfo();
  const health = 'error' in info ? null : await getStorageHealth().catch((err: unknown) => ({ status: 'unavailable', error: (err as Error).message }));
  res.json({ ...info, health, migration: await getMigrationJob() });
});

adminStorageRouter.post('/check', async (_req: Request, res: Response) => {
  const info = storeInfo();
  if ('error' in info) { res.status(500).json(info); return; }
  res.json({ ...info, health: await getStorageHealth(0, true) });
});

adminStorageRouter.get('/migrate', async (_req: Request, res: Response) => {
  res.json({ job: await getMigrationJob() });
});

adminStorageRouter.post('/migrate', async (req: Request, res: Response) => {
  const parsed = migrateSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') }); return; }
  const b = parsed.data as { from: 'minio' | 's3' | 'filesystem'; to: 'minio' | 's3' | 'filesystem'; dryRun?: boolean; verifyExisting?: boolean };
  if (b.from === b.to) { res.status(400).json({ error: 'from and to must differ' }); return; }
  const r = await startMigration({ from: b.from, to: b.to, dryRun: b.dryRun ?? false, verifyExisting: b.verifyExisting ?? false, actor: req.apiUser?.email ?? 'unknown' });
  if (r.started) { res.status(202).json({ job: r.job }); return; }
  const status = r.reason === 'running' ? 409 : 400;
  res.status(status).json({ error: r.message, code: r.reason, ...(r.job ? { job: r.job } : {}) });
});

adminStorageRouter.post('/migrate/cancel', (_req: Request, res: Response) => {
  if (!cancelMigration()) { res.status(404).json({ error: 'no migration running' }); return; }
  res.json({ cancelled: true });
});
