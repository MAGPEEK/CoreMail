/**
 * Audit Log Helper — Phase 10
 *
 * Provides a typed function to write audit log entries.
 * Called from route handlers and middleware.
 *
 * Action naming convention:  "<resource>.<verb>"
 *   mailbox.create / mailbox.delete / mailbox.update
 *   auth.login / auth.login_failed / auth.logout / auth.mfa_enabled
 *   domain.create / domain.delete
 *   rule.create / rule.update / rule.delete
 *   session.revoke / oauth.token_issued / oauth.token_revoked
 *   gateway.settings_updated / retention.run / journaling.rule_created
 */

import { prisma } from '@coremail/storage/prisma';
import { createLogger } from '@coremail/core';
import type { Request } from 'express';

const log = createLogger('audit');

export interface AuditEntry {
  actorId?: string;
  actorEmail?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  ipAddress?: string;
  userAgent?: string;
  changes?: Record<string, unknown>;
  success?: boolean;
  errorMsg?: string;
}

/**
 * Write an audit log entry asynchronously (fire-and-forget).
 * Never throws — audit failures must not break the main flow.
 */
export function audit(entry: AuditEntry): void {
  prisma.auditLog
    .create({
      data: {
        ...(entry.actorId !== undefined ? { actorId: entry.actorId } : {}),
        ...(entry.actorEmail !== undefined ? { actorEmail: entry.actorEmail } : {}),
        action: entry.action,
        ...(entry.targetType !== undefined ? { targetType: entry.targetType } : {}),
        ...(entry.targetId !== undefined ? { targetId: entry.targetId } : {}),
        ...(entry.targetName !== undefined ? { targetName: entry.targetName } : {}),
        ...(entry.ipAddress !== undefined ? { ipAddress: entry.ipAddress } : {}),
        ...(entry.userAgent !== undefined ? { userAgent: entry.userAgent } : {}),
        // Cast via unknown: Prisma InputJsonValue doesn't accept Record<string, unknown> directly
        ...(entry.changes !== undefined ? { changes: entry.changes as unknown as Record<string, string> } : {}),
        success: entry.success ?? true,
        ...(entry.errorMsg !== undefined ? { errorMsg: entry.errorMsg } : {}),
      },
    })
    .catch((err) => log.error({ err, action: entry.action }, 'Audit log write failed'));
}

/**
 * Extract audit context from an Express request.
 */
export function auditContext(req: Request): Pick<AuditEntry, 'ipAddress' | 'userAgent'> {
  return {
    ipAddress: (req.headers['x-forwarded-for'] as string | undefined) ?? req.ip ?? '',
    userAgent: req.get('user-agent') ?? '',
  };
}

/**
 * Express middleware that auto-audits mutating admin API calls.
 * Logs action = "<method>.<path>" for all POST/PUT/PATCH/DELETE on /api/v1/admin/
 */
export function auditMiddleware(
  req: Request,
  _res: import('express').Response,
  next: import('express').NextFunction,
): void {
  // Only audit mutating operations.
  // NOTE: This middleware is mounted at app.use('/api/v1/admin', auditMiddleware).
  // Express strips the mount prefix from req.path — so req.path is already relative,
  // e.g. '/mailboxes/123' NOT '/api/v1/admin/mailboxes/123'.
  // Checking req.path.startsWith('/api/v1/admin/') would NEVER match here.
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (mutating.includes(req.method)) {
    const user = (req as Request & { apiUser?: { userId: string; email: string } }).apiUser;
    // Strip leading slash, split into segments: '/mailboxes/123' → ['mailboxes', '123']
    const pathParts = req.path.replace(/^\//, '').split('/');
    const resource = pathParts[0] ?? 'unknown';
    const verb = req.method.toLowerCase();

    audit({
      ...(user?.userId !== undefined ? { actorId: user.userId } : {}),
      ...(user?.email !== undefined ? { actorEmail: user.email } : {}),
      action: `${resource}.${verb}`,
      ...(pathParts[1] !== undefined ? { targetId: pathParts[1] } : {}),
      ...auditContext(req),
    });
  }
  next();
}
