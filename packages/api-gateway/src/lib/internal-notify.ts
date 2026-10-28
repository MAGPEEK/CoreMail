/**
 * Internal Notification Helper (v3.18.16)
 *
 * Delivers system notifications (e.g. calendar share invitation) directly into
 * the recipient's INBOX, without the detour via the SMTP outbound queue.
 * Faster, no DKIM/spam check needed, also works when the MX server is
 * currently under load.
 *
 * The sender is always `system@<publicHostname>` so it is clearly recognizable
 * as an automated mail.
 */
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('internal-notify');

export interface InternalNotifyOpts {
  /** User ID of the recipient (NOT the email address) */
  recipientUserId: string;
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
  messageId?: string;
}

/**
 * Delivers a notification mail directly into the recipient's INBOX.
 * Fire-and-forget — errors are logged but not propagated.
 */
export async function notifyUserInbox(opts: InternalNotifyOpts): Promise<void> {
  try {
    const mailbox = await prisma.mailbox.findFirst({
      where: { userId: opts.recipientUserId },
      include: { folders: true },
    });
    if (!mailbox) {
      log.warn({ recipientUserId: opts.recipientUserId }, 'no mailbox for recipient — notification dropped');
      return;
    }

    // Find the INBOX folder (typically displayName="Inbox" or name="Inbox")
    const inbox = mailbox.folders.find(
      (f) => f.name === 'Inbox' || f.displayName === 'Inbox' || f.name === 'INBOX',
    );
    if (!inbox) {
      log.warn({ recipientUserId: opts.recipientUserId }, 'no INBOX folder — notification dropped');
      return;
    }

    // Increment UID / modSeq — standard IMAP pattern. We read the current
    // values and add +1. The race-condition risk is acceptable for system-
    // generated mails (one per share, low frequency).
    const lastMessage = await prisma.message.findFirst({
      where: { folderId: inbox.id },
      orderBy: { uid: 'desc' },
      select: { uid: true, modSeq: true },
    });
    const nextUid = (lastMessage?.uid ?? 0) + 1;
    const nextModSeq = (lastMessage?.modSeq ?? 0n) + 1n;

    const bodyHtml = opts.bodyHtml ?? `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(opts.bodyText)}</pre>`;
    const messageId = opts.messageId ?? `<${Date.now()}.${Math.random().toString(36).slice(2)}@coremail.system>`;

    await prisma.message.create({
      data: {
        folderId: inbox.id,
        uid: nextUid,
        modSeq: nextModSeq,
        flags: [],  // unread
        subject: opts.subject,
        fromAddr: opts.fromAddr,
        fromName: opts.fromName,
        toAddrs: [],
        ccAddrs: [],
        bccAddrs: [],
        date: new Date(),
        bodyText: opts.bodyText,
        bodyHtml,
        rawSize: Buffer.byteLength(bodyText(opts), 'utf8'),
        messageId,
        ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
      },
    });

    log.info({ recipientUserId: opts.recipientUserId, subject: opts.subject }, 'internal notification delivered');
  } catch (err) {
    log.error({ err, recipientUserId: opts.recipientUserId }, 'internal notification failed');
  }
}

function bodyText(opts: InternalNotifyOpts): string {
  return `${opts.fromName} <${opts.fromAddr}>\n${opts.subject}\n\n${opts.bodyText}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
