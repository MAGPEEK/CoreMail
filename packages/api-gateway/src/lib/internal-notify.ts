/**
 * Internal Notification Helper (v3.18.16)
 *
 * Stellt System-Benachrichtigungen (z. B. Calendar-Share-Einladung) direkt in
 * das INBOX-Postfach des Empfängers ein, ohne den Umweg über die SMTP-Outbound-
 * Queue. Schneller, kein DKIM/Spam-Check nötig, funktioniert auch wenn der
 * MX-Server gerade unter Last steht.
 *
 * Sender ist immer `system@<publicHostname>` damit klar erkennbar ist, dass es
 * sich um eine automatische Mail handelt.
 */
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('internal-notify');

export interface InternalNotifyOpts {
  /** User-ID des Empfängers (NICHT E-Mail-Adresse) */
  recipientUserId: string;
  /** Anzeigename des Absenders (z. B. „CoreMail System" oder Owner-Name) */
  fromName: string;
  /** E-Mail-Adresse des Absenders (z. B. owner@domain oder system@domain) */
  fromAddr: string;
  subject: string;
  bodyText: string;
  /** Optional HTML-Body; wenn weggelassen, wird `bodyText` als <pre> gewrappt */
  bodyHtml?: string;
  /** Zusätzliche Headers für Threading (selten genutzt) */
  inReplyTo?: string;
  messageId?: string;
}

/**
 * Stellt eine Notification-Mail direkt in die INBOX des Empfängers ein.
 * Fire-and-forget — Fehler werden geloggt aber nicht propagiert.
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

    // INBOX-Folder finden (typisch displayName="Inbox" oder name="Inbox")
    const inbox = mailbox.folders.find(
      (f) => f.name === 'Inbox' || f.displayName === 'Inbox' || f.name === 'INBOX',
    );
    if (!inbox) {
      log.warn({ recipientUserId: opts.recipientUserId }, 'no INBOX folder — notification dropped');
      return;
    }

    // UID / modSeq inkrementieren — standard IMAP-Pattern. Wir lesen aktuelle
    // Werte und legen +1 an. Race-Condition-Risiko ist akzeptabel für system-
    // generierte Mails (eine pro Share, niedrige Frequenz).
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
        flags: [],  // ungelesen
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
