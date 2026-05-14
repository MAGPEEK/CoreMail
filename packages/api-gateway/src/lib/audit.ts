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
        actorId: entry.actorId,
        actorEmail: entry.actorEmail,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        targetName: entry.targetName,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        ...(entry.changes ? { changes: entry.changes } : {}),
        success: entry.success ?? true,
        errorMsg: entry.errorMsg,
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
  // Only audit mutating operations
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (mutating.includes(req.method) && req.path.startsWith('/api/v1/admin/')) {
    const user = (req as Request & { apiUser?: { userId: string; email: string } }).apiUser;
    const pathParts = req.path.replace('/api/v1/admin/', '').split('/');
    const resource = pathParts[0] ?? 'unknown';
    const verb = req.method.toLowerCase();

    audit({
      actorId: user?.userId,
      actorEmail: user?.email,
      action: `${resource}.${verb}`,
      targetId: pathParts[1],
      ...auditContext(req),
    });
  }
  next();
}
