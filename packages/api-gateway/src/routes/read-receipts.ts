/**
 * 9.4: answering read-receipt requests of the user's own messages.
 *
 *   POST /api/v1/mail/messages/:id/receipt  { action: 'send' | 'ignore', mode?: 'manual' | 'automatic' }
 *
 * The request is read from the raw original (the Disposition-Notification-To
 * column is only the webmail's hint). Both actions set the $MDNSent keyword so
 * the user is asked at most once per message — also by other clients that honour
 * the keyword. Sending goes through `smtp-outbound` like every other mail
 * (DKIM of the user's domain, ProhibitSendQuota respected) with a null envelope
 * sender, so a receipt never causes bounces. Never sent: for messages in Junk,
 * mailing-list / bulk / automatic mail (storage mdn.ts), and `mode: 'automatic'`
 * only when the user chose "always answer" (Settings → Lesen).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  prisma, setFlags, loadRawMessage, receiptAddressOfRaw, buildReadReceipt, checkSendQuota,
} from '@coremail/storage';
import { getOutboundJobOptions } from '@coremail/storage/queue-options';
import { createLogger } from '@coremail/core';
import { requireAuth } from '../middleware/auth.js';
import { loadPreferences } from '../lib/preferences-store.js';
import { getOutboundQueue } from './mail.js';

const log = createLogger('api:read-receipts');
export const MDN_SENT_FLAG = '$MDNSent';
const JUNK_FOLDER = 'Junk';

export const readReceiptRouter: RouterType = Router();

const ReceiptSchema = z.object({
  action: z.enum(['send', 'ignore']),
  mode: z.enum(['manual', 'automatic']).default('manual'),
}).strict();

readReceiptRouter.post('/messages/:id/receipt', requireAuth, async (req: Request, res: Response) => {
  const parsed = ReceiptSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const { id } = req.params as { id: string };
  const userId = req.apiUser!.userId;

  const msg = await prisma.message.findFirst({
    where: { id, deletedAt: null, folder: { mailbox: { userId } } },
    include: { attachments: true, folder: { select: { mailboxId: true, name: true } } },
  });
  if (!msg) { res.status(404).json({ error: 'Nachricht nicht gefunden' }); return; }
  if (msg.flags.includes(MDN_SENT_FLAG)) {
    res.status(409).json({ error: 'Lesebestätigung wurde bereits beantwortet', code: 'RECEIPT_HANDLED' });
    return;
  }
  const markHandled = () => prisma.$transaction((tx) => setFlags(
    tx, [{ id: msg.id, flags: [...msg.flags, MDN_SENT_FLAG] }], { mailboxId: msg.folder.mailboxId },
  ));

  if (parsed.data.action === 'ignore') {
    await markHandled();
    res.json({ ok: true, sent: false });
    return;
  }

  if (msg.folder.name === JUNK_FOLDER) {
    res.status(409).json({ error: 'Keine Lesebestätigung für Junk-E-Mails', code: 'RECEIPT_NOT_ALLOWED' });
    return;
  }
  if (parsed.data.mode === 'automatic' && (await loadPreferences(userId)).reading.answerReceipts !== 'always') {
    res.status(409).json({ error: 'Automatische Lesebestätigungen sind ausgeschaltet', code: 'RECEIPT_NOT_AUTOMATIC' });
    return;
  }

  let to: string | null;
  try {
    to = receiptAddressOfRaw(await loadRawMessage(msg, { persist: false }));
  } catch (err) {
    log.warn({ err, id }, 'Raw message not readable for a read receipt');
    res.status(503).json({ error: 'Nachricht vorübergehend nicht lesbar' });
    return;
  }
  if (!to) { res.status(409).json({ error: 'Keine Lesebestätigung angefordert', code: 'NO_RECEIPT_REQUESTED' }); return; }

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { domain: true } });
  if (!user) { res.status(404).json({ error: 'Benutzer nicht gefunden' }); return; }
  const quota = await checkSendQuota(user.id);
  if (!quota.allowed) { res.status(403).json({ error: quota.message, code: 'MAILBOX_QUOTA_EXCEEDED' }); return; }

  const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } });
  const receipt = buildReadReceipt({
    fromAddr: user.email,
    fromName: user.displayName ?? '',
    to,
    originalMessageId: msg.messageId,
    originalSubject: msg.subject,
    finalRecipient: user.email,
    reportingHost: settings?.publicHostname || user.domain.name,
    mode: parsed.data.mode,
  });
  await getOutboundQueue().add('send', {
    messageId: `mdn-${crypto.randomUUID()}`,
    // null envelope sender: a receipt that cannot be delivered is not reported back
    from: '',
    to: [to],
    senderUserId: user.id,
    ...(user.domain.dkimPrivateKey ? {
      dkimDomain: user.domain.name,
      dkimSelector: user.domain.dkimSelector ?? 'mail',
      dkimPrivateKey: user.domain.dkimPrivateKey,
    } : {}),
    rawMessage: receipt.raw.toString('base64'),
  }, await getOutboundJobOptions());
  await markHandled();
  log.info({ userId, id, mode: parsed.data.mode }, 'Read receipt queued');
  res.json({ ok: true, sent: true });
});
