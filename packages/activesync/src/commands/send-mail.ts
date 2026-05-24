import { prisma } from '@coremail/storage/prisma';
import { getRedisClient, CHANNEL_MAIL_NEW } from '@coremail/core';
import { encodeWbxml, el, getText, getChild, type WbxmlElement } from '../wbxml.js';

/**
 * SendMail command — send outgoing email
 */
export async function handleSendMail(
  body: WbxmlElement,
  userId: string,
): Promise<Buffer> {
  const mimeData = getText(body, 'Mime');
  const saveInSent = getText(body, 'SaveInSentItems') !== '0';

  if (!mimeData) {
    return encodeWbxml(el('SendMail', undefined, [el('Status', '120')]));
  }

  try {
    // Parse basic headers from MIME
    const lines = mimeData.split('\r\n');
    let subject = '';
    let from = '';
    const to: string[] = [];
    let i = 0;
    for (; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line === '') break;
      if (line.toLowerCase().startsWith('subject:')) {
        subject = line.slice(8).trim();
      } else if (line.toLowerCase().startsWith('from:')) {
        from = line.slice(5).trim();
      } else if (line.toLowerCase().startsWith('to:')) {
        to.push(...line.slice(3).trim().split(',').map((a: string) => a.trim()).filter(Boolean));
      }
    }
    const bodyText = lines.slice(i + 1).join('\n');

    // Get user info
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const fromAddr = from || user?.email || userId;

    // Save to Sent folder if requested
    if (saveInSent) {
      const mailbox = await prisma.mailbox.findFirst({ where: { userId } });
      if (mailbox) {
        const sentFolder = await prisma.folder.findFirst({
          where: { mailboxId: mailbox.id, name: 'Sent' },
        });
        if (sentFolder) {
          const updatedMailbox = await prisma.mailbox.update({
            where: { id: mailbox.id },
            data: { uidNext: { increment: 1 } },
          });
          await prisma.message.create({
            data: {
              folderId: sentFolder.id,
              uid: updatedMailbox.uidNext - 1,
              modSeq: BigInt(Date.now()),
              flags: ['\\Seen'],
              subject,
              fromAddr,
              toAddrs: to,
              ccAddrs: [],
              date: new Date(),
              bodyText,
              bodyHtml: '',
              rawSize: mimeData.length,
              storagePath: '',
            },
          });
          await prisma.folder.update({
            where: { id: sentFolder.id },
            data: { totalCount: { increment: 1 } },
          });
        }
      }
    }

    // Enqueue for outbound delivery
    const redis = getRedisClient();
    await redis.lpush(
      'smtp:outbound:eas',
      JSON.stringify({
        from: fromAddr,
        to,
        subject,
        bodyText,
        bodyHtml: '',
        mime: mimeData,
      }),
    );

    return encodeWbxml(el('SendMail', undefined, [el('Status', '1')]));
  } catch {
    return encodeWbxml(el('SendMail', undefined, [el('Status', '120')]));
  }
}

/**
 * SmartReply / SmartForward — reply/forward with original message included
 */
export async function handleSmartReply(
  body: WbxmlElement,
  userId: string,
  command: 'SmartReply' | 'SmartForward',
): Promise<Buffer> {
  // Delegate to SendMail logic (MIME includes original message inline)
  return handleSendMail(body, userId);
}
