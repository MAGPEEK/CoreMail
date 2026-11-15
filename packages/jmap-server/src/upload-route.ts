/**
 * Blob upload endpoint (RFC 8620 §6.1): POST /jmap/upload/:accountId
 *
 * v8.1: order of checks — authentication, maxConcurrentUpload per user,
 * account visible, account writable (403 forbidden for read-only accounts) —
 * all before the body is read; then the upload quota (403 overQuota).
 */
import express from 'express';
import { createLogger } from '@coremail/core';
import { RequestError } from './errors.js';
import { LIMITS } from './limits.js';
import {
  concurrencyLimit, uploadGate, UploadQuotaError, UploadReadOnlyError, type ConcurrencyGate,
} from './request-limits.js';
import type { AccountContext, JmapUser } from './types.js';

const log = createLogger('jmap:upload');

type AuthedRequest = express.Request & { jmapUser?: JmapUser };

export interface UploadRouteDeps {
  auth: express.RequestHandler;
  resolveAccounts(user: JmapUser): Promise<Map<string, AccountContext>>;
  store(account: AccountContext, data: Buffer, type: string): Promise<{ blobId: string; size: number; type: string }>;
  gate?: ConcurrencyGate;
  maxConcurrentUpload?: () => number;
  maxSizeUpload?: number;
}

function problem(res: express.Response, err: RequestError): void {
  res.status(err.status).type('application/problem+json').send(JSON.stringify(err.toJson()));
}

export function createUploadRouter(deps: UploadRouteDeps): express.Router {
  const router = express.Router();
  const maxSize = deps.maxSizeUpload ?? LIMITS.maxSizeUpload;
  router.post(
    '/jmap/upload/:accountId',
    deps.auth,
    concurrencyLimit(deps.gate ?? uploadGate, deps.maxConcurrentUpload ?? (() => LIMITS.maxConcurrentUpload), 'maxConcurrentUpload'),
    async (req, res, next) => {
      const accounts = await deps.resolveAccounts((req as AuthedRequest).jmapUser!);
      const account = accounts.get(String(req.params['accountId']));
      if (!account) { problem(res, new RequestError('accountNotFound', 404)); return; }
      if (account.readOnly) { problem(res, new RequestError('forbidden', 403, 'The account is read-only')); return; }
      res.locals['account'] = account;
      next();
    },
    express.raw({ type: () => true, limit: maxSize }),
    async (req, res) => {
      const account = res.locals['account'] as AccountContext;
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const type = (req.get('Content-Type') ?? 'application/octet-stream').split(';')[0]!.trim();
      try {
        const stored = await deps.store(account, data, type);
        res.status(201).json({ accountId: account.accountId, blobId: stored.blobId, type: stored.type, size: stored.size });
      } catch (err) {
        if (err instanceof UploadReadOnlyError) { problem(res, new RequestError('forbidden', 403, 'The account is read-only')); return; }
        if (err instanceof UploadQuotaError) {
          log.info({ accountId: account.accountId, used: err.used, quota: err.quota }, 'JMAP upload refused — quota exceeded');
          problem(res, new RequestError('overQuota', 403, err.message));
          return;
        }
        throw err;
      }
    },
  );
  router.use('/jmap/upload', (err: Error & { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) { next(err); return; }
    if (err.type === 'entity.too.large') { problem(res, new RequestError('limit', 413, 'Upload too large', { limit: 'maxSizeUpload' })); return; }
    next(err);
  });
  return router;
}
