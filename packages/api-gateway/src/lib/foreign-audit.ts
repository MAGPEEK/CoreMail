/**
 * Audit of the webmail access to someone else's mailbox: folder create /
 * rename / delete / empty and message move / delete on a Shared Mailbox or a
 * delegated user mailbox (9.3 review A3), and — 9.4 — opening it (aggregated:
 * one entry per user, mailbox and hour). Written through the shared mailbox
 * access audit of @coremail/storage (mailbox-access-audit.ts, source
 * `webmail`): targetType `sharedMailbox` (SharedMailbox id) or `mailbox`
 * (Mailbox id of the delegating user), the mailbox id and the affected folder /
 * message counts in `changes`. Fire-and-forget.
 *
 * Actions: mailbox.foreign.open | .folder.create | .folder.update |
 *          .folder.delete | .folder.empty | .message.move | .message.delete
 */
import type { Request } from 'express';
import { recordMailboxAccess, type MailboxAccessAction } from '@coremail/storage';
import { auditContext } from './audit.js';

export type ForeignAuditAction = Exclude<MailboxAccessAction, 'mailbox.foreign.open' | 'mailbox.foreign.send_as' | 'mailbox.foreign.send_on_behalf'>;

export interface ForeignAuditTarget {
  kind: 'shared' | 'delegated';
  /** SharedMailbox id (shared) or Mailbox id (delegated). */
  id: string;
  mailboxId: string;
  email?: string;
}

function record(req: Request, target: ForeignAuditTarget, action: MailboxAccessAction, changes?: Record<string, unknown>): void {
  const ctx = auditContext(req);
  void recordMailboxAccess({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email,
    target: {
      kind: target.kind,
      sharedMailboxId: target.kind === 'shared' ? target.id : null,
      mailboxId: target.mailboxId,
      ...(target.email ? { email: target.email } : {}),
    },
    action,
    source: 'webmail',
    ...(changes ? { changes } : {}),
    ...(ctx.ipAddress ? { ipAddress: ctx.ipAddress } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
  });
}

export function auditForeignWrite(
  req: Request,
  target: ForeignAuditTarget,
  action: ForeignAuditAction,
  changes: Record<string, unknown>,
): void {
  record(req, target, action, changes);
}

/** Opening / reading the mailbox (aggregated by the storage recorder). */
export function auditForeignOpen(req: Request, target: ForeignAuditTarget): void {
  record(req, target, 'mailbox.foreign.open');
}
