/**
 * Internal notifications (v3.18.16, moved to @coremail/storage in v8.1 so that
 * the smtp-server can use it for quota warnings).
 *
 * Delivers system notifications (calendar share invitation, mailbox quota
 * warning, …) directly into a mailbox's INBOX through the message store — no
 * SMTP round trip, no DKIM/spam check, works while the MX is under load and
 * while the mailbox is over its receive quota (like Exchange system messages).
 *
 * Never throws — errors are logged.
 */
import { randomBytes } from 'node:crypto';
import { createLogger } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { createMessage } from './message-store.js';
import { formatReferencesColumn, threadReferencesOf } from './references.js';

const log = createLogger('internal-notify');

export interface InternalNotifyContent {
  /** Display name of the sender (e.g. „CoreMail System" or owner name) */
  fromName: string;
  /** Email address of the sender (e.g. owner@domain or system@domain) */
  fromAddr: string;
  subject: string;
  bodyText: string;
  /** Optional HTML body; if omitted, `bodyText` is wrapped as <pre> */
  bodyHtml?: string;
  /** Additional headers for threading (rarely used) */
  inReplyTo?: string;
  /** References chain (msg-ids, oldest first); defaults to In-Reply-To. */
  references?: string[];
  messageId?: string;
}

export interface InternalNotifyOpts extends InternalNotifyContent {
  /** User ID of the recipient (NOT the email address) */
  recipientUserId: string;
}

export function escapeNotifyHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Delivers a notification into the INBOX of the given mailbox. Returns the message id (null on failure). */
export async function notifyMailboxInbox(mailboxId: string, opts: InternalNotifyContent): Promise<string | null> {
  try {
    const inbox = await prisma.folder.findFirst({
      where: { mailboxId, name: { in: ['INBOX', 'Inbox'] } },
      select: { id: true },
    });
    if (!inbox) {
      log.warn({ mailboxId }, 'no INBOX folder — notification dropped');
      return null;
    }
    const bodyHtml = opts.bodyHtml ?? `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeNotifyHtml(opts.bodyText)}</pre>`;
    const messageId = opts.messageId ?? `<${Date.now()}.${randomBytes(8).toString('hex')}@coremail.system>`;
    // UID + modSeq from the mailbox counters (atomic message store).
    const msg = await prisma.$transaction((tx) => createMessage(tx, mailboxId, inbox.id, {
      flags: [],
      subject: opts.subject,
      fromAddr: opts.fromAddr,
      fromName: opts.fromName,
      toAddrs: [],
      ccAddrs: [],
      bccAddrs: [],
      date: new Date(),
      bodyText: opts.bodyText,
      bodyHtml,
      rawSize: Buffer.byteLength(`${opts.fromName} <${opts.fromAddr}>\n${opts.subject}\n\n${opts.bodyText}`, 'utf8'),
      messageId,
      ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
      // No raw object: the References are known here, never left to the backfill.
      references: formatReferencesColumn(threadReferencesOf(opts.references ?? [], opts.inReplyTo)),
    }));
    await prisma.folder.update({
      where: { id: inbox.id },
      data: { totalCount: { increment: 1 }, unreadCount: { increment: 1 } },
    }).catch(() => undefined);
    log.info({ mailboxId, subject: opts.subject }, 'internal notification delivered');
    return msg.id;
  } catch (err) {
    log.error({ err, mailboxId }, 'internal notification failed');
    return null;
  }
}

/** Delivers a notification mail directly into the user's INBOX (fire-and-forget safe). */
export async function notifyUserInbox(opts: InternalNotifyOpts): Promise<void> {
  try {
    const mailbox = await prisma.mailbox.findFirst({ where: { userId: opts.recipientUserId }, select: { id: true } });
    if (!mailbox) {
      log.warn({ recipientUserId: opts.recipientUserId }, 'no mailbox for recipient — notification dropped');
      return;
    }
    const { recipientUserId: _ignored, ...content } = opts;
    await notifyMailboxInbox(mailbox.id, content);
  } catch (err) {
    log.error({ err, recipientUserId: opts.recipientUserId }, 'internal notification failed');
  }
}
