/**
 * 10.6: audit rows written by the shared auth code (passkey registration,
 * removal, counter regression, recovery, migration). Credential events are
 * always written — like the api-gateway's ALWAYS_AUDIT actions they do not
 * depend on the audit-log toggle (ServerSettings.auditLogEnabled). Never throws.
 * Test seam: setAuthAuditSink(fn) captures the entries (null restores it).
 */
import { createLogger } from '@coremail/core';
import { prisma } from '../prisma/index.js';

const log = createLogger('auth:audit');

export interface AuthAuditEntry {
  action: string;
  actorId?: string | undefined;
  actorEmail?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  targetName?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  changes?: Record<string, unknown> | undefined;
  success?: boolean | undefined;
  errorMsg?: string | undefined;
}

type Sink = (e: AuthAuditEntry) => Promise<void> | void;
let sink: Sink | null = null;

/** Tests: capture audit entries instead of writing rows. */
export function setAuthAuditSink(fn: Sink | null): void {
  sink = fn;
}

export async function writeAuthAudit(e: AuthAuditEntry): Promise<void> {
  try {
    if (sink) { await sink(e); return; }
    await prisma.auditLog.create({
      data: {
        action: e.action,
        ...(e.actorId !== undefined ? { actorId: e.actorId } : {}),
        ...(e.actorEmail !== undefined ? { actorEmail: e.actorEmail } : {}),
        ...(e.targetType !== undefined ? { targetType: e.targetType } : {}),
        ...(e.targetId !== undefined ? { targetId: e.targetId } : {}),
        ...(e.targetName !== undefined ? { targetName: e.targetName } : {}),
        ...(e.ipAddress !== undefined ? { ipAddress: e.ipAddress } : {}),
        ...(e.userAgent !== undefined ? { userAgent: e.userAgent } : {}),
        ...(e.changes !== undefined ? { changes: e.changes as unknown as Record<string, string> } : {}),
        success: e.success ?? true,
        ...(e.errorMsg !== undefined ? { errorMsg: e.errorMsg } : {}),
      },
    });
  } catch (err) {
    log.error({ err, action: e.action }, 'auth audit write failed');
  }
}
