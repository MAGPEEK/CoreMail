/**
 * Setup wizard after the commit (10.4.2, docs/setup-wizard.md).
 *
 *   GET  /api/v1/setup/secrets-download  the secrets file as an attachment
 *   POST /api/v1/setup/finish            the wizard reached its summary
 *
 * Both need the admin session the wizard signs in with after
 * POST /setup/complete: ORGANIZATION_MANAGEMENT, organisation-wide (requireRole
 * — current role from the DB, admin MFA rule). The download is open only while
 * the wizard has not finished and at most 24 h after the setup was completed
 * (lib/setup-secrets.ts secretsDownloadWindowOpen); outside that window, and
 * when there is no file, it answers 404 like an unknown route. Every download
 * (and every refused attempt of a signed-in admin) is audited as
 * `setup.secrets.download` — never with the file content. Mounted before the
 * setup router with its own rate limit (middleware/security.ts
 * setupFollowUpRateLimit).
 */
import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireRole } from '../middleware/auth.js';
import { setupFollowUpRateLimit } from '../middleware/security.js';
import { audit, auditContext } from '../lib/audit.js';
import {
  readSecretsForDownload, removeStagedSecretsCopy, secretsDownloadFilename, secretsDownloadWindowOpen,
} from '../lib/setup-secrets.js';

export interface SetupLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface SetupFollowUpOptions {
  log?: SetupLogger;
  /** Replaces the rate limit (tests). */
  rateLimit?: RequestHandler;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

const NOT_FOUND = { error: 'Not found' };

export function createSetupFollowUpRouter(opts: SetupFollowUpOptions = {}): RouterType {
  const log = opts.log ?? createLogger('api:setup');
  const limit = opts.rateLimit ?? setupFollowUpRateLimit;
  const env = (): NodeJS.ProcessEnv => opts.env ?? process.env;
  const now = (): Date => (opts.now ? opts.now() : new Date());
  const router: RouterType = Router();

  const refuse = (req: Request, res: Response, reason: string): void => {
    audit({
      ...(req.apiUser ? { actorId: req.apiUser.userId, actorEmail: req.apiUser.email } : {}),
      action: 'setup.secrets.download', targetType: 'secrets', targetName: 'coremail.env',
      ...auditContext(req), success: false, errorMsg: reason,
    });
    res.status(404).json(NOT_FOUND);
  };

  router.get('/secrets-download', limit, requireRole(), async (req: Request, res: Response) => {
    const s = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { setupCompletedAt: true, setupWizardFinishedAt: true, publicHostname: true },
    });
    if (!secretsDownloadWindowOpen(s, now())) {
      await removeStagedSecretsCopy(env());
      log.warn({ userId: req.apiUser?.userId }, 'Secrets download refused: outside the setup window');
      refuse(req, res, 'outside the setup window');
      return;
    }
    const content = await readSecretsForDownload(env());
    if (!content) {
      log.warn({ userId: req.apiUser?.userId }, 'Secrets download refused: no readable secrets file');
      refuse(req, res, 'no secrets file');
      return;
    }
    const filename = secretsDownloadFilename(s?.publicHostname, now());
    audit({
      ...(req.apiUser ? { actorId: req.apiUser.userId, actorEmail: req.apiUser.email } : {}),
      action: 'setup.secrets.download', targetType: 'secrets', targetName: 'coremail.env',
      ...auditContext(req), success: true,
    });
    log.info({ userId: req.apiUser?.userId, bytes: content.length }, 'Secrets file downloaded by the setup wizard');
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.status(200).end(content);
  });

  router.post('/finish', limit, requireRole(), async (req: Request, res: Response) => {
    const r = await prisma.serverSettings.updateMany({
      where: { id: 'singleton', setupCompletedAt: { not: null }, setupWizardFinishedAt: null },
      data: { setupWizardFinishedAt: now() },
    });
    await removeStagedSecretsCopy(env());
    if (r.count > 0) log.info({ userId: req.apiUser?.userId }, 'Setup wizard finished — secrets download closed');
    res.status(204).end();
  });

  return router;
}

export const setupFollowUpRouter: RouterType = createSetupFollowUpRouter();
