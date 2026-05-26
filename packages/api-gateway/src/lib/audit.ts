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
 * v3.18.30: In-Memory-Cache (60s TTL) für auditLogEnabled-Flag. Vermeidet
 * Datenbank-Hit auf jedem Audit-Write. Invalidiert wird via Redis-Channel
 * `settings:reload` (siehe global-settings.ts Save-Handler).
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
    return true; // fail-safe: bei DB-Fehler weiterhin loggen
  }
}

/**
 * v3.18.30: Audit-Actions die IMMER protokolliert werden müssen — auch wenn
 * der globale Toggle aus ist. Zentral: alle Settings-Änderungen und der
 * Audit-Toggle selbst (Compliance-Anforderung — sonst könnte man unentdeckt
 * loggen ausschalten, Daten exfiltrieren, wieder anschalten).
 */
const ALWAYS_AUDIT = /^(settings\.|audit\.|user\.role|oauth\.client|mailbox\.delete|domain\.delete)/i;

/**
 * Write an audit log entry asynchronously (fire-and-forget).
 * Never throws — audit failures must not break the main flow.
 *
 * v3.18.30: Respektiert ServerSettings.auditLogEnabled — wenn aus, werden
 * normale Events nicht geloggt. Kritische Aktionen (ALWAYS_AUDIT) werden
 * ungeachtet des Toggles immer geloggt.
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
 * GET-Pfade, die trotz Lese-Operation als auditrelevant gelten und mitprotokolliert
 * werden müssen (Data-Export, Compliance-Auswertung, Quelltext-Zugriff).
 *
 * Compliance-Hintergrund: Wer Audit-Daten exportiert oder rohen Mail-Inhalt liest,
 * wird selbst auditiert — sonst könnte ein Admin Daten exfiltrieren ohne Spuren.
 */
const AUDIT_SENSITIVE_GET = [
  /^\/audit-log\/export\.(csv|pdf|json)$/i,
  /^\/audit-log\/anomalies$/i,
];

/**
 * Express middleware that auto-audits admin API calls.
 *
 * - Mutating ops (POST/PUT/PATCH/DELETE) → immer auditiert
 * - Sensitive GET (audit-log exports, anomalies) → ebenfalls auditiert
 *
 * NOTE: Mounted via `app.use('/api/v1/admin', auditMiddleware)`. Express strips
 * the mount prefix → req.path is relative (e.g. '/mailboxes/123').
 *
 * IMMUTABILITY-Hinweis (Meta-Logging): Diese Middleware schreibt direkt in die
 * `audit_log`-Tabelle, die keinen DELETE-Endpoint hat. Selbst Admins können
 * Einträge weder löschen noch verändern (DSGVO/SOX/HIPAA/TISAX/ISO 27001).
 * Ein Versuch, die Middleware zur Laufzeit zu deaktivieren, bedingt einen
 * Code-Deploy und ist damit über Git/CI/CD nachvollziehbar.
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

  // v3.18.34 KRITISCHER BUG-FIX: req.path NOW erfassen.
  // Express mutiert req.url/req.path beim Descend in Sub-Router (z.B.
  // `app.use('/api/v1/admin/certificates', certRouter)` setzt im Sub-Router
  // req.path auf '/cmplad51y0…/activate-https' statt '/certificates/cmplad…').
  // Im `res.on('finish')`-Callback ist das mutierte Path — daher landeten
  // im Audit-Log Aktionen wie `cmplad51y0.post` statt `certificates.post`.
  const capturedPath = req.path;
  const capturedMethod = req.method;

  // KRITISCH: Loggen erst nach Response-Ende, damit `req.apiUser` durch
  // `requireAuth` (in den einzelnen Router-Mountings) bereits gesetzt ist.
  // Vor dem Fix wurde synchron geloggt → apiUser war undefined → Akteur immer leer.
  // Außerdem kennen wir nach Response den HTTP-Status (Erfolg / Fehler).
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
 * v3.18.34: CUID-bewusster Action-Builder. Aus dem path-relativ zur audit-
 * middleware-Mountpoint (z.B. `/certificates/<cuid>/activate-https`) wird:
 *   action     = 'certificates.activate-https.post'  (CUIDs werden NICHT zum Action-String)
 *   targetType = 'certificates'                        (immer das erste Segment)
 *   targetId   = '<cuid>'                              (letztes CUID-Segment im Path)
 *
 * Beispiele:
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

  // Letztes CUID-Segment ist targetId; alle Nicht-CUID-Segmente formen Action.
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
