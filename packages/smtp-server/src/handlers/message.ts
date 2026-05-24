import { prisma, parseRawMessage, uploadBuffer, rawMessageKey, attachmentKey } from '@coremail/storage';
import { getRedisClient, CHANNEL_MAIL_NEW, createLogger } from '@coremail/core';
import { verifyIncomingSmime, decryptIncomingSmime } from '../smime/index.js';
// Journaling-Feature komplett entfernt in v3.13.6

const log = createLogger('smtp:message-handler');

const LARGE_MESSAGE_THRESHOLD = 256 * 1024; // 256 KB — store raw in MinIO above this

export interface StoreOptions {
  fromAddr: string;
  rcptTo: string;
  toJunk: boolean;
  spamScore?: number;
}

export async function storeInboundMessage(
  rawBuffer: Buffer,
  opts: StoreOptions,
): Promise<void> {
  // Find recipient — kann User (Postfach) oder SharedMailbox sein
  const [user, sharedMailbox] = await Promise.all([
    prisma.user.findFirst({
      where: { email: opts.rcptTo.toLowerCase(), active: true },
      include: { mailbox: { include: { folders: true } } },
    }),
    prisma.sharedMailbox.findFirst({
      where: { email: opts.rcptTo.toLowerCase(), active: true },
      include: { mailbox: { include: { folders: true } } },
    }),
  ]);

  // Common-Mode: User-Postfach. Fallback: SharedMailbox (für lokale Zustellung).
  // Wenn beides null → unbekannter Empfänger (Mail wird verworfen).
  let mailbox = user?.mailbox ?? sharedMailbox?.mailbox ?? null;
  const ownerType: 'user' | 'shared' = user?.mailbox ? 'user' : 'shared';

  if (!mailbox) {
    log.warn({ rcptTo: opts.rcptTo }, 'Mailbox not found — dropping message');
    return;
  }

  // ── Phase 9: S/MIME — decrypt + verify (NUR User-Postfächer, nicht SharedMailbox)
  let processedBuffer = rawBuffer;
  let smimeDecrypted = false;
  let smimeVerifyResult: Record<string, unknown> = {};
  if (ownerType === 'user' && user) {
    const smimeSettings = await prisma.smimeSettings.findUnique({
      where: { userId: user.id },
    });
    if (smimeSettings?.decryptIncoming !== false) {
      const decryptResult = await decryptIncomingSmime(rawBuffer, user.id);
      if (decryptResult.encrypted && decryptResult.decrypted && decryptResult.plaintext) {
        processedBuffer = decryptResult.plaintext;
        smimeDecrypted = true;
        log.debug({ rcptTo: opts.rcptTo }, 'S/MIME message decrypted for storage');
      }
    }
    if (smimeSettings?.verifyIncoming !== false) {
      const verifyResult = await verifyIncomingSmime(processedBuffer);
      if (verifyResult.signed) {
        smimeVerifyResult = verifyResult as unknown as Record<string, unknown>;
        log.debug({ rcptTo: opts.rcptTo, valid: verifyResult.valid }, 'S/MIME signature verified');
      }
    }
  }

  // Use decrypted buffer (or original) for parsing and storage
  const effectiveBuffer = smimeDecrypted ? processedBuffer : rawBuffer;
  // mailbox wurde oben aus user?.mailbox bzw. sharedMailbox?.mailbox aufgelöst
  // → muss als non-null behandelt werden (early-return-check oben)
  mailbox = mailbox!;

  // ── USER-JUNK-Sperrliste prüfen ──────────────────────────────────────────────
  // Wenn ein User einen Absender manuell als Junk markiert hat (Aktion 'spam' in
  // der MWA), wird ein Blacklist-Eintrag mit scope='USER-JUNK' für diese UserID
  // gespeichert. Mails von diesem Absender landen dann immer im Junk-Ordner.
  let forceJunk = opts.toJunk;
  if (!forceJunk && user) {
    const junkRule = await prisma.blacklist.findFirst({
      where: {
        scope: 'USER-JUNK',
        scopeId: user.id,
        pattern: opts.fromAddr.toLowerCase(),
        active: true,
      },
    });
    if (junkRule) {
      forceJunk = true;
      log.debug({ rcptTo: opts.rcptTo, fromAddr: opts.fromAddr }, 'USER-JUNK rule matched — delivering to Junk');
    }
  }

  // Find the target folder (INBOX or Junk)
  // WICHTIG: Ordner heißt 'Junk' (nicht 'Junk E-Mail') und 'INBOX' (nicht 'Inbox')
  const targetFolderName = forceJunk ? 'Junk' : 'INBOX';
  const folder = mailbox.folders.find(
    (f: { name: string }) => f.name === targetFolderName,
  ) ?? mailbox.folders.find(
    (f: { name: string }) => f.name === 'INBOX',
  );

  if (!folder) {
    log.error({ rcptTo: opts.rcptTo, folder: targetFolderName }, 'Target folder not found');
    return;
  }

  const parsed = await parseRawMessage(effectiveBuffer);

  // Allocate UID and modseq atomically
  const updatedMailbox = await prisma.mailbox.update({
    where: { id: mailbox.id },
    data: {
      uidNext: { increment: 1 },
      highestModSeq: { increment: 1 },
    },
  });

  const uid    = updatedMailbox.uidNext - 1;
  const modSeq = updatedMailbox.highestModSeq;

  // Store raw message in MinIO if large, otherwise inline
  let storagePath: string | null = null;
  if (effectiveBuffer.length > LARGE_MESSAGE_THRESHOLD) {
    const msgId = crypto.randomUUID();
    storagePath = rawMessageKey(msgId);
    await uploadBuffer(storagePath, effectiveBuffer, 'message/rfc822');
  }

  // Build S/MIME header JSON for OWA display
  const smimeHeader = Object.keys(smimeVerifyResult).length > 0 || smimeDecrypted
    ? JSON.stringify({ ...smimeVerifyResult, decrypted: smimeDecrypted })
    : null;

  // Create message record
  const message = await prisma.message.create({
    data: {
      folderId: folder.id,
      uid,
      modSeq,
      flags: opts.toJunk ? [] : [],
      subject: parsed.subject,
      fromAddr: parsed.fromAddr,
      fromName: parsed.fromName,
      toAddrs: parsed.toAddrs,
      ccAddrs: parsed.ccAddrs,
      bccAddrs: parsed.bccAddrs,
      replyTo: parsed.replyTo,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      date: parsed.date,
      bodyText: storagePath ? '' : parsed.bodyText,
      bodyHtml: storagePath ? '' : parsed.bodyHtml,
      rawSize: effectiveBuffer.length,
      storagePath,
      changeKey: modSeq.toString(),
      ...(smimeHeader ? { smimeMeta: smimeHeader } : {}),
    },
  });

  // Store attachments (deduplicated by SHA256)
  for (const att of parsed.attachments) {
    const key = attachmentKey(message.id, att.filename);
    await uploadBuffer(key, att.buffer, att.mimeType);

    await prisma.attachment.create({
      data: {
        messageId: message.id,
        contentId: att.contentId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        sha256: att.sha256,
        storagePath: key,
        inline: att.inline,
      },
    });
  }

  // Update folder counters
  await prisma.folder.update({
    where: { id: folder.id },
    data: {
      totalCount: { increment: 1 },
      unreadCount: { increment: 1 },
      changeKey: modSeq.toString(),
    },
  });

  // Update quota usage — entweder User- oder SharedMailbox-Tabelle
  if (ownerType === 'user' && user) {
    await prisma.user.update({
      where: { id: user.id },
      data: { usedBytes: { increment: effectiveBuffer.length } },
    });
  } else if (ownerType === 'shared' && sharedMailbox) {
    await prisma.sharedMailbox.update({
      where: { id: sharedMailbox.id },
      data: { usedBytes: { increment: effectiveBuffer.length } },
    });
  }

  // Publish real-time notification
  // Für SharedMailbox: an alle User mit Permission FULL_ACCESS/READ_ONLY publishen,
  // damit Empfänger in MWA Live-Update sehen
  const redis = getRedisClient();
  const notifyUserIds: string[] = [];
  if (ownerType === 'user' && user) {
    notifyUserIds.push(user.id);
  } else if (ownerType === 'shared' && sharedMailbox) {
    const perms = await prisma.sharedMailboxPerm.findMany({
      where: {
        sharedMailboxId: sharedMailbox.id,
        permission: { in: ['FULL_ACCESS', 'READ_ONLY'] },
      },
      select: { userId: true },
    });
    notifyUserIds.push(...perms.map((p) => p.userId));
  }
  for (const notifyUserId of notifyUserIds) {
    await redis.publish(
      CHANNEL_MAIL_NEW,
      JSON.stringify({
        userId: notifyUserId,
        folderId: folder.id,
        messageId: message.id,
        uid,
        subject: parsed.subject,
        fromAddr: parsed.fromAddr,
        fromName: parsed.fromName,
        date: parsed.date.toISOString(),
        isJunk: opts.toJunk,
      }),
    );
  }

  // MAIL_FLOW — Nachrichtenablaufverfolgung
  void prisma.systemLog.create({
    data: {
      level: 'INFO',
      service: 'smtp-server',
      category: 'MAIL_FLOW',
      message: `Inbound: ${opts.fromAddr} → ${opts.rcptTo}`,
      ...(ownerType === 'user' && user ? { userId: user.id } : {}),
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
      metadata: {
        sender: opts.fromAddr,
        recipient: opts.rcptTo,
        subject: parsed.subject ?? '',
        status: opts.toJunk ? 'JUNK' : 'DELIVERED',
        messageId: parsed.messageId ?? '',
        size: String(effectiveBuffer.length),
        spamScore: opts.spamScore !== undefined ? String(opts.spamScore) : '',
        direction: 'INBOUND',
      },
    },
  }).catch((err: unknown) => log.error({ err }, 'MAIL_FLOW log failed'));

  log.info(
    { rcptTo: opts.rcptTo, folder: folder.name, uid, size: effectiveBuffer.length },
    'Message stored',
  );
}
