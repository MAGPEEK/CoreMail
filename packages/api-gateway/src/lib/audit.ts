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
 * v3.18.30: in-memory cache (60s TTL) for the auditLogEnabled flag. Avoids a
 * database hit on every audit write. Invalidated via the Redis channel
 * `settings:reload` (see the global-settings.ts save handler).
 */
let _auditEnabledCache: { value: boolean; expiresAt: number } | null = null;

export function invalidateAuditCache(): void { _auditEnabledCache = null; }

async function isAuditEnabled(): Promise<boolean> {
  if (_auditEnabledCache && _auditEnabledCache.expiresAt > Date.now()) {
    return _auditEnabledCache.value;
  }
  try {
    const s = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { auditLogEnabled: true },
    });
    const enabled = s?.auditLogEnabled ?? true;
    _auditEnabledCache = { value: enabled, expiresAt: Date.now() + 60_000 };
    return enabled;
  } catch {
    return true; // fail-safe: keep logging on DB error
  }
}

/**
 * v3.18.30: audit actions that must ALWAYS be logged — even when the
 * global toggle is off. Central: all settings changes and the audit toggle
 * itself (compliance requirement — otherwise one could silently disable
 * logging, exfiltrate data, and re-enable it).
 */
const ALWAYS_AUDIT = /^(settings\.|audit\.|user\.role|oauth\.client|mailbox\.delete|domain\.delete)/i;

/**
 * Write an audit log entry asynchronously (fire-and-forget).
 * Never throws — audit failures must not break the main flow.
 *
 * v3.18.30: respects ServerSettings.auditLogEnabled — when off, normal
 * events are not logged. Critical actions (ALWAYS_AUDIT) are always logged
 * regardless of the toggle.
 */
export function audit(entry: AuditEntry): void {
  void (async () => {
    const isCritical = ALWAYS_AUDIT.test(entry.action);
    if (!isCritical) {
      const enabled = await isAuditEnabled();
      if (!enabled) return;
    }

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
          ...(entry.changes !== undefined ? { changes: entry.changes as unknown as Record<string, string> } : {}),
          success: entry.success ?? true,
          ...(entry.errorMsg !== undefined ? { errorMsg: entry.errorMsg } : {}),
        },
      })
      .catch((err) => log.error({ err, action: entry.action }, 'Audit log write failed'));
  })();
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
 * GET paths that count as audit-relevant despite being read operations and must
 * be logged as well (data export, compliance evaluation, raw source access).
 *
 * Compliance background: whoever exports audit data or reads raw mail content
 * is audited themselves — otherwise an admin could exfiltrate data without a trace.
 */
const AUDIT_SENSITIVE_GET = [
  /^\/audit-log\/export\.(csv|pdf|json)$/i,
  /^\/audit-log\/anomalies$/i,
];

/**
 * Express middleware that auto-audits admin API calls.
 *
 * - Mutating ops (POST/PUT/PATCH/DELETE) → always audited
 * - Sensitive GET (audit-log exports, anomalies) → audited as well
 *
 * NOTE: Mounted via `app.use('/api/v1/admin', auditMiddleware)`. Express strips
 * the mount prefix → req.path is relative (e.g. '/mailboxes/123').
 *
 * IMMUTABILITY note (meta-logging): this middleware writes directly to the
 * `audit_log` table, which has no DELETE endpoint. Even admins can neither
 * delete nor modify entries (GDPR/SOX/HIPAA/TISAX/ISO 27001).
 * Any attempt to disable the middleware at runtime requires a code deploy
 * and is therefore traceable via Git/CI/CD.
 */
export function auditMiddleware(
  req: Request,
  res: import('express').Response,
  next: import('express').NextFunction,
): void {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'];
  const isMutating = mutating.includes(req.method);
  const isSensitiveGet = req.method === 'GET' && AUDIT_SENSITIVE_GET.some((re) => re.test(req.path));

  if (!isMutating && !isSensitiveGet) {
    next();
    return;
  }

  // v3.18.34 CRITICAL BUG FIX: capture req.path NOW.
  // Express mutates req.url/req.path when descending into sub-routers (e.g.
  // `app.use('/api/v1/admin/certificates', certRouter)` sets req.path in the
  // sub-router to '/cmplad51y0…/activate-https' instead of '/certificates/cmplad…').
  // In the `res.on('finish')` callback the path is the mutated one — hence the
  // audit log contained actions like `cmplad51y0.post` instead of `certificates.post`.
  const capturedPath = req.path;
  const capturedMethod = req.method;

  // CRITICAL: log only after the response ends so that `req.apiUser` has
  // already been set by `requireAuth` (in the individual router mounts).
  // Before the fix logging was synchronous → apiUser was undefined → actor always empty.
  // Also, after the response we know the HTTP status (success / error).
  res.on('finish', () => {
    const user = (req as Request & { apiUser?: { userId: string; email: string } }).apiUser;
    const success = res.statusCode >= 200 && res.statusCode < 400;
    const { action, targetType, targetId } = buildAction(capturedMethod, capturedPath);

    audit({
      ...(user?.userId !== undefined ? { actorId: user.userId } : {}),
      ...(user?.email !== undefined ? { actorEmail: user.email } : {}),
      action,
      targetType,
      ...(targetId ? { targetId } : {}),
      success,
      ...(!success ? { errorMsg: `HTTP ${res.statusCode}` } : {}),
      ...auditContext(req),
    });
  });

  next();
}

/**
 * v3.18.34: CUID-aware action builder. From the path relative to the audit
 * middleware mount point (e.g. `/certificates/<cuid>/activate-https`) it derives:
 *   action     = 'certificates.activate-https.post'  (CUIDs do NOT become part of the action string)
 *   targetType = 'certificates'                        (always the first segment)
 *   targetId   = '<cuid>'                              (last CUID segment in the path)
 *
 * Examples:
 *   DELETE /backups/jobs/<cuid>       → backups.jobs.delete           targetId=<cuid>
 *   GET    /audit-log/anomalies        → audit-log.anomalies.get
 *   POST   /certificates/<cuid>/activate-https
 *                                       → certificates.activate-https.post  targetId=<cuid>
 *   PUT    /settings/security          → settings.security.put
 *   DELETE /mailboxes/<cuid>           → mailboxes.delete              targetId=<cuid>
 */
function buildAction(
  method: string,
  path: string,
): { action: string; targetType: string; targetId?: string } {
  const verb = method.toLowerCase();
  const parts = path.replace(/^\//, '').replace(/\/$/, '').split('/').filter(Boolean);
  const resource = parts[0] ?? 'unknown';

  // CUID: 25 chars, starts with 'c' followed by 24 [a-z0-9] chars
  const isCuid = (s: string): boolean => /^c[a-z0-9]{24}$/.test(s);

  // The last CUID segment is targetId; all non-CUID segments form the action.
  let targetId: string | undefined;
  const actionParts: string[] = [resource];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i]!;
    if (isCuid(seg)) {
      targetId = seg;
    } else {
      actionParts.push(seg);
    }
  }

  return {
    action: `${actionParts.join('.')}.${verb}`,
    targetType: resource,
    ...(targetId ? { targetId } : {}),
  };
}
