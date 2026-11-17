/**
 * Audit of writes in someone else's mailbox (9.3 review A3): folder create /
 * rename / delete / empty and message move / delete on a Shared Mailbox or a
 * delegated user mailbox. Same shape as the recover-deleted-items audit
 * (routes/recoverable.ts): targetType `sharedMailbox` (SharedMailbox id) or
 * `mailbox` (Mailbox id of the delegating user), the mailbox id and the
 * affected folder / message counts in `changes`. Fire-and-forget (lib/audit.ts).
 *
 * Actions: mailbox.foreign.folder.create | .folder.update | .folder.delete |
 *          .folder.empty | .message.move | .message.delete
 */
import type { Request } from 'express';
import { audit, auditContext } from './audit.js';

export type ForeignAuditAction =
  | 'mailbox.foreign.folder.create'
  | 'mailbox.foreign.folder.update'
  | 'mailbox.foreign.folder.delete'
  | 'mailbox.foreign.folder.empty'
  | 'mailbox.foreign.message.move'
  | 'mailbox.foreign.message.delete';

export interface ForeignAuditTarget {
  kind: 'shared' | 'delegated';
  /** SharedMailbox id (shared) or Mailbox id (delegated). */
  id: string;
  mailboxId: string;
  email?: string;
}

export function auditForeignWrite(
  req: Request,
  target: ForeignAuditTarget,
  action: ForeignAuditAction,
  changes: Record<string, unknown>,
): void {
  audit({
    actorId: req.apiUser!.userId,
    actorEmail: req.apiUser!.email,
    action,
    targetType: target.kind === 'shared' ? 'sharedMailbox' : 'mailbox',
    targetId: target.id,
    ...(target.email ? { targetName: target.email } : {}),
    changes: { mailboxId: target.mailboxId, ...changes },
    ...auditContext(req),
  });
}
