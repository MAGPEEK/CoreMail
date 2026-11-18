import { prisma, parseRawMessage, uploadBuffer, storeRawMessage, truncateBodyColumn, attachmentKey, applyMailRules, applyTransportRules, applyOutcomeToBuffer, processITipInbound, deliveredImportance, createMessage, deferMailboxChanges, createRulePatternBudget, ruleMessageStepBudget, checkReceiveQuota, recordDelivery, loadMailFlowPolicy, deliveryRefusal, headerFromAddress, type SenderAuth, type QuotaOwner, type MailFlowOwner, type TransportOutcome } from '@coremail/storage';
import type { LocalOutcome } from './delivery.js';
import { getRedisClient, CHANNEL_MAIL_NEW, createLogger } from '@coremail/core';
import { verifyIncomingSmime, decryptIncomingSmime } from '../smime/index.js';
import { enqueueRuleForward, isRuleForwardedAlready, planAdminForward, adminForwardSource } from './rule-forward.js';
import { handleTransportOutcome } from './transport-actions.js';
import { sendAutoReplyIfNeeded } from './auto-reply.js';
import { withReturnPath } from './trace.js';
import { processResourceMailboxes } from './resource-booking.js';
// Journaling feature completely removed in v3.13.6

const log = createLogger('smtp:message-handler');

export interface StoreOptions {
  fromAddr: string;
  rcptTo: string;
  toJunk: boolean;
  spamScore?: number;
  /** Extra delivery created by a transport rule (redirect/addRecipient) — do not re-evaluate rules (loop guard). */
  skipTransportRules?: boolean;
  /**
   * Re-injected by a BCP quarantine release: the transport-rule `quarantine`
   * action is skipped. Internal flag only (BullMQ job field) — never derived
   * from a message header.
   */
  quarantineRelease?: boolean;
  /**
   * SMTP transaction key (handlers/delivery.ts deliveryKey): a retry of a
   * transaction whose local store failed does not queue the rule forwards again.
   */
  deliveryKey?: string;
  /**
   * How the sender was authenticated (inbound filter verdict or authenticated
   * local sender). Absent = unauthenticated: iTIP REPLYs are not applied.
   */
  senderAuth?: SenderAuth;
  /**
   * 9.4: a notice this server generates for the recipient (DSN / NDR to a local
   * sender, dead-letter notice): the mailbox's sender lists and receive size
   * limit do not apply. Internal callers only — never derived from a header.
   */
  systemNotice?: boolean;
}

/**
 * Result of one local delivery:
 *  - 'stored'   the message is in the mailbox (or a rule/transport rule took it over)
 *  - 'resource' the recipient is a resource mailbox — the invitation was processed
 *  - 'unknown'  no active mailbox/resource of that address — the caller sends an
 *               NDR to the sender (never a silent drop)
 *  - 'quota'    v8.1: the mailbox is at/over its ProhibitSendReceiveQuota — not
 *               stored; the caller sends an NDR (5.2.2)
 *  - 'policy'   9.4: refused by the mailbox's mail flow policy (accept-only-from,
 *               reject-from, receive size limit) — not stored; NDR (5.7.1)
 */
export type StoreResult = 'stored' | 'resource' | 'unknown' | 'quota' | 'policy';

/** Pure: the delivery-ledger outcome of a store result. */
export function toLocalOutcome(result: StoreResult | void): LocalOutcome {
  return result === 'unknown' || result === 'quota' || result === 'policy' ? result : 'delivered';
}

export function storeInboundMessage(rawBuffer: Buffer, opts: StoreOptions): Promise<StoreResult> {
  // 9.4: one realtime announcement once the delivery is complete (message,
  // rule copies, attachments, folder counters) — a client re-reading on the
  // event sees the new counts and attachments, not a half-written state
  return deferMailboxChanges(() => deliverInbound(rawBuffer, opts));
}

async function deliverInbound(rawBuffer: Buffer, opts: StoreOptions): Promise<StoreResult> {
  // Find recipient — can be a User (mailbox) or a SharedMailbox.
  // (Public folder path removed in v3.18.31 — feature completely removed)
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

  // Common case: user mailbox. Fallback: SharedMailbox (for local delivery).
  // If both are null → unknown recipient (mail is discarded).
  let mailbox = user?.mailbox ?? sharedMailbox?.mailbox ?? null;
  const ownerType: 'user' | 'shared' = user?.mailbox ? 'user' : 'shared';

  if (!mailbox) {
    // Room/equipment mailbox: process the invitation for every delivery path
    // (port 25, submission, worker for MWA/JMAP/EAS) with the sender's auth.
    const handled = await processResourceMailboxes(rawBuffer, [opts.rcptTo], opts.fromAddr, opts.senderAuth ?? null);
    if (handled.length > 0) return 'resource';
    log.warn({ rcptTo: opts.rcptTo }, 'Mailbox not found — recipient unknown at delivery time');
    return 'unknown';
  }

  // 9.4: per-mailbox mail flow — accept-only-from / reject-from (envelope sender
  // and header From:) and the receive size limit. Port 25 refuses the envelope
  // sender at RCPT TO already; this covers every delivery path.
  const flowOwner: MailFlowOwner = ownerType === 'user' && user ? { userId: user.id } : { sharedMailboxId: sharedMailbox!.id };
  const flow = await loadMailFlowPolicy(flowOwner);
  const refusal = deliveryRefusal(flow, {
    envelopeFrom: opts.fromAddr || null, headerFrom: headerFromAddress(rawBuffer), sizeBytes: rawBuffer.length,
    ...(opts.systemNotice ? { systemNotice: true } : {}),
  });
  if (refusal) {
    log.warn({ rcptTo: opts.rcptTo, from: opts.fromAddr, refusal }, 'Delivery refused by the mailbox mail flow policy');
    return 'policy';
  }

  // v8.1: ProhibitSendReceiveQuota. Port 25 already refuses at RCPT TO; this
  // covers every other path (submission, outbound worker for MWA/JMAP/EAS, rule
  // redirects). Null-sender mail (bounces, DSNs) is refused too, like Exchange.
  const quotaOwner: QuotaOwner = ownerType === 'user' && user
    ? { kind: 'user', id: user.id }
    : { kind: 'shared', id: sharedMailbox!.id };
  if (await checkReceiveQuota(quotaOwner)) {
    log.warn({ rcptTo: opts.rcptTo }, 'Mailbox over its receive quota — not delivered');
    return 'quota';
  }

  // ── Phase 9: S/MIME — decrypt + verify (user mailboxes ONLY, not SharedMailbox)
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
  // `let` because TransportRules may modify the buffer (addHeader, disclaimer)
  let effectiveBuffer = smimeDecrypted ? processedBuffer : rawBuffer;
  // mailbox was resolved above from user?.mailbox or sharedMailbox?.mailbox
  // → must be treated as non-null (early-return check above)
  mailbox = mailbox!;

  // ── Check USER-JUNK blocklist ────────────────────────────────────────────────
  // When a user has manually marked a sender as junk ('spam' action in the
  // MWA), a blacklist entry with scope='USER-JUNK' is stored for that user ID.
  // Mails from that sender then always land in the Junk folder.
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
  // IMPORTANT: folder is named 'Junk' (not 'Junk E-Mail') and 'INBOX' (not 'Inbox')
  const targetFolderName = forceJunk ? 'Junk' : 'INBOX';
  const folder = mailbox.folders.find(
    (f: { name: string }) => f.name === targetFolderName,
  ) ?? mailbox.folders.find(
    (f: { name: string }) => f.name === 'INBOX',
  );

  if (!folder) {
    log.error({ rcptTo: opts.rcptTo, folder: targetFolderName }, 'Target folder not found');
    return 'unknown';
  }

  let parsed = await parseRawMessage(effectiveBuffer);

  // Regex step budget of this message (RULE_PATTERN_MESSAGE_STEP_BUDGET) for all
  // transport and inbox rules; each rule gets its own RULE_PATTERN_STEP_BUDGET within it.
  const patternBudget = createRulePatternBudget({
    steps: ruleMessageStepBudget(),
    onExhausted: () => log.warn({ rcptTo: opts.rcptTo }, 'Regex step budget exhausted — remaining rule regex conditions do not match'),
  });

  // ── iTIP REPLY handler (v3.18.25 A5) ────────────────────────────────────────
  // If the incoming mail is a REPLY to a calendar invitation, we update the
  // attendee status in the corresponding CalendarEvent. The mail is STILL
  // delivered normally to the inbox (user awareness, like Outlook).
  try {
    const handled = await processITipInbound(effectiveBuffer, {
      envelopeFrom: opts.fromAddr,
      recipientUserId: ownerType === 'user' && user ? user.id : null,
      senderAuth: opts.senderAuth ?? null,
    });
    if (handled) {
      log.info({ rcptTo: opts.rcptTo, from: opts.fromAddr }, 'iTIP REPLY processed — CalendarEvent attendee updated');
    }
  } catch (err) {
    log.warn({ err, rcptTo: opts.rcptTo }, 'iTIP processing failed — continuing normal delivery');
  }

  // ── Transport rules (server-wide, admin-configured, v3.18.9) ─────────────────
  // Evaluated BEFORE user mail rules — modifies header/subject/body and
  // can reject the mail entirely or move it to quarantine.
  let appliedTransport: TransportOutcome | null = null;
  if (!opts.skipTransportRules) try {
    const transportOutcome = await applyTransportRules(parsed, {
      envelopeRcpt: opts.rcptTo,
      patternBudget,
      ...(opts.spamScore !== undefined ? { spamScore: opts.spamScore } : {}),
    });
    // reject → DSN, quarantine → quarantine store, redirect/add/removeRecipient
    // → recipient set changes (handlers/transport-actions.ts).
    const decision = await handleTransportOutcome(transportOutcome, {
      raw:       rawBuffer,
      fromAddr:  opts.fromAddr,
      rcptTo:    opts.rcptTo,
      subject:   parsed.subject ?? '',
      messageId: parsed.messageId ?? null,
      ...(opts.spamScore !== undefined ? { spamScore: opts.spamScore } : {}),
      ...(opts.quarantineRelease ? { quarantineRelease: true } : {}),
    });
    if (decision === 'stop') return 'stored';
    // If buffer modifications are needed: adjust buffer + re-parse
    if (
      transportOutcome.headerAdds.length > 0 ||
      transportOutcome.headerRemoves.length > 0 ||
      transportOutcome.subjectPrefix ||
      transportOutcome.subjectSuffix ||
      transportOutcome.disclaimerHtml
    ) {
      effectiveBuffer = applyOutcomeToBuffer(effectiveBuffer, transportOutcome);
      parsed = await parseRawMessage(effectiveBuffer);
      appliedTransport = transportOutcome;
    }
  } catch (err) {
    log.error({ err }, 'TransportRules evaluation failed — delivering mail unchanged');
  }

  // ── Admin forwarding (9.4, MailFlowPolicy.forwardTo) ─────────────────────────
  // Queued before the local copy is committed, like rule forwards (a failure
  // defers the transaction; the claim keyed by the transaction prevents a second
  // forward on the retry). When the mailbox keeps no copy, delivery ends here.
  // An S/MIME message decrypted for storage is forwarded still encrypted.
  const forwardSource = adminForwardSource(effectiveBuffer, rawBuffer, smimeDecrypted, appliedTransport);
  const adminForward = planAdminForward(flow, {
    envelopeFrom: opts.fromAddr, alreadyForwarded: isRuleForwardedAlready(forwardSource),
  });
  if (adminForward === 'skipped-loop') {
    log.warn({ rcptTo: opts.rcptTo, to: flow.forwardTo }, 'Admin forwarding skipped (already forwarded / bounce) — delivering locally');
  } else if (adminForward !== 'none') {
    await enqueueRuleForward({
      rawBuffer:      forwardSource,
      toAddress:      adminForward.to,
      forwardingUser: ownerType === 'user' && user
        ? { id: user.id, email: user.email.toLowerCase() }
        : { id: sharedMailbox!.id, email: sharedMailbox!.email.toLowerCase(), shared: true },
      mode:           'forward',
      originalFrom:   opts.fromAddr,
      dedupKey:       opts.deliveryKey,
      recipient:      opts.rcptTo,
    });
    if (!adminForward.keepCopy) {
      log.info({ rcptTo: opts.rcptTo, to: adminForward.to }, 'Admin forwarding without a local copy');
      return 'stored';
    }
  }

  // ── User inbox rules (Outlook-style, v3.18.0) ────────────────────────────────
  // Engine can override folderId, set flags/categories, trigger a forward
  // or discard the mail entirely (hardDelete). User mailboxes only.
  let ruleFolderId   = folder.id;
  let ruleFlags: string[] = [];
  let ruleCategories: string[] = [];
  let rulePinned     = false;
  let ruleDiscard    = false;          // hardDelete → mail is not persisted at all
  let ruleImportance: 'high' | 'normal' | 'low' | null = null;   // 9.4: "set importance" action
  const ruleCopyTargets: string[] = [];
  const ruleForwards: Array<{ address: string; mode: 'forward' | 'redirect' }> = [];
  if (ownerType === 'user' && user) {
    try {
      const outcome = await applyMailRules(parsed, user.id, user.email, folder.id, patternBudget);
      if (outcome.targetFolderId) ruleFolderId = outcome.targetFolderId;
      ruleFlags = [...outcome.flagsToAdd];
      ruleCategories = [...outcome.categoriesToAdd];
      rulePinned = outcome.pinned;
      ruleImportance = outcome.importance;
      ruleCopyTargets.push(...outcome.copyTargets);

      // forceJunk override: rule can force delivery to Junk
      if (outcome.forceJunk) {
        const junk = mailbox.folders.find((f: { name: string }) => f.name === 'Junk');
        if (junk) ruleFolderId = junk.id;
      }
      // soft-delete = Trash
      if (outcome.deleted === 'soft') {
        const trash = mailbox.folders.find((f: { name: string }) => f.name === 'Trash');
        if (trash) ruleFolderId = trash.id;
      }
      // hard-delete = discard, do not store
      if (outcome.deleted === 'hard') {
        ruleDiscard = true;
      }

      ruleForwards.push(...outcome.forwards);

      if (outcome.appliedRuleIds.length > 0) {
        log.debug(
          { rcptTo: opts.rcptTo, ruleIds: outcome.appliedRuleIds, targetFolder: ruleFolderId, discarded: ruleDiscard },
          'Mail rules applied',
        );
      }
    } catch (err) {
      log.error({ err, userId: user.id }, 'Mail-Rules engine failed — using default delivery');
    }
  }

  // Rule forwards/redirects are enqueued BEFORE the message is committed and a
  // failure propagates (the SMTP transaction is answered 4yz and retried):
  // after a 250 a forward must not be lost silently (RFC 5321 §6.1). When the
  // store below fails instead, the retry finds the forward claimed under the
  // transaction key and does not queue it twice.
  // Redirects keep the original envelope sender (§3.9.1) — a null reverse-path
  // stays null, so a redirected bounce cannot loop.
  if (user) {
    for (const fwd of ruleForwards) {
      await enqueueRuleForward({
        rawBuffer:      effectiveBuffer,
        toAddress:      fwd.address,
        forwardingUser: { id: user.id, email: user.email },
        mode:           fwd.mode,
        originalFrom:   opts.fromAddr,
        dedupKey:       opts.deliveryKey,
        recipient:      opts.rcptTo,
      });
    }
  }

  if (ruleDiscard) {
    log.info({ rcptTo: opts.rcptTo, from: parsed.fromAddr }, 'Mail discarded by rule (hardDelete)');
    return 'stored';
  }

  // RFC 5321 §4.4: final delivery inserts Return-Path: <reverse-path> at the
  // beginning of the stored message (earlier Return-Path fields are removed).
  effectiveBuffer = withReturnPath(effectiveBuffer, opts.fromAddr);

  // Raw-always storage: the original RFC 5322 octets go to object storage for every
  // message (content-addressed, shared by all recipients and rule copies). IMAP,
  // POP3, JMAP and backups serve these octets; the body columns only feed search
  // and the web preview (truncated, never emptied).
  const { storagePath } = await storeRawMessage(effectiveBuffer);

  // Build S/MIME header JSON for OWA display
  const smimeHeader = Object.keys(smimeVerifyResult).length > 0 || smimeDecrypted
    ? JSON.stringify({ ...smimeVerifyResult, decrypted: smimeDecrypted })
    : null;

  const messageImportance = deliveredImportance(parsed.importance, ruleImportance);
  const baseData = {
    flags: ruleFlags,
    subject: parsed.subject,
    fromAddr: parsed.fromAddr,
    fromName: parsed.fromName,
    toAddrs: parsed.toAddrs,
    ccAddrs: parsed.ccAddrs,
    bccAddrs: parsed.bccAddrs,
    replyTo: parsed.replyTo,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    // 9.4: read receipt requested — the webmail asks / answers per the user's setting
    ...(parsed.dispositionNotificationTo ? { dispositionNotificationTo: parsed.dispositionNotificationTo } : {}),
    // 9.4: Importance / X-Priority (the webmail shows a badge); an inbox rule's
    // "set importance" replaces the header value (main message and rule copies)
    ...(messageImportance ? { importance: messageImportance } : {}),
    // 9.4: Sensitivity header (the webmail shows a badge for personal / private / confidential)
    ...(parsed.sensitivity ? { sensitivity: parsed.sensitivity } : {}),
    date: parsed.date,
    bodyText: truncateBodyColumn(parsed.bodyText),
    bodyHtml: truncateBodyColumn(parsed.bodyHtml),
    rawSize: effectiveBuffer.length,
    storagePath,
  };

  // Create message record (folderId + flags possibly overridden by mail rules).
  // UID + modSeq are allocated atomically by the message store.
  const mailboxId = mailbox.id;
  const message = await prisma.$transaction((tx) => createMessage(tx, mailboxId, ruleFolderId, {
    ...baseData,
    ...(rulePinned ? { pinnedAt: new Date() } : {}),
    ...(smimeHeader ? { smimeMeta: smimeHeader } : {}),
    // v3.18.6: persist rspamd score — for frontend spam banner and score badge
    ...(typeof opts.spamScore === 'number' ? { spamScore: opts.spamScore } : {}),
  }));
  const uid    = message.uid;
  const modSeq = message.modSeq;

  // Assign rule categories (best-effort, no hard fail)
  if (ruleCategories.length > 0) {
    await Promise.allSettled(
      ruleCategories.map((categoryId) =>
        prisma.messageCategory.create({
          data: { messageId: message.id, categoryId },
        }),
      ),
    );
  }

  // Rule copy targets: create additional message records in further folders
  const copyMessageIds: string[] = [];
  for (const copyFolderId of ruleCopyTargets) {
    if (copyFolderId === ruleFolderId) continue; // already the main copy
    try {
      const copy = await prisma.$transaction((tx) => createMessage(tx, mailboxId, copyFolderId, baseData));
      copyMessageIds.push(copy.id);
      await prisma.folder.update({
        where: { id: copyFolderId },
        data: { totalCount: { increment: 1 }, unreadCount: { increment: 1 } },
      });
    } catch (err) {
      log.warn({ err, copyFolderId }, 'Rule copyTo failed for one target — skipped');
    }
  }

  // Store attachments. One object per attachment index: two parts with the same
  // filename (e.g. inline "image.png") must not overwrite each other.
  for (const [index, att] of parsed.attachments.entries()) {
    const key = attachmentKey(message.id, `${index}-${att.sha256.slice(0, 16)}`);
    await uploadBuffer(key, att.buffer, att.mimeType);

    // Rule copies share the object (like message-store copyMessages).
    for (const messageId of [message.id, ...copyMessageIds]) {
      await prisma.attachment.create({
        data: {
          messageId,
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
  }

  // Update folder counters — counter applies to the ACTUAL target folder
  // (may be overridden by a mail rule). Only increment unreadCount if
  // the mail was not already marked as read by a rule.
  const incrementUnread = ruleFlags.includes('\\Seen') ? 0 : 1;
  await prisma.folder.update({
    where: { id: ruleFolderId },
    data: {
      totalCount: { increment: 1 },
      unreadCount: { increment: incrementUnread },
      changeKey: modSeq.toString(),
    },
  });

  // Update quota usage — either the User or the SharedMailbox table
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
  // v8.1: cached quota usage + (throttled) warning mail when the warning level is reached
  void recordDelivery(quotaOwner, effectiveBuffer.length * (1 + copyMessageIds.length));

  // Publish real-time notification
  // For SharedMailbox: publish to all users with FULL_ACCESS/READ_ONLY permission,
  // so recipients see a live update in the MWA
  const redis = getRedisClient();
  const notifyUserIds: string[] = [];
  if (ownerType === 'user' && user) {
    notifyUserIds.push(user.id);
  } else if (ownerType === 'shared' && sharedMailbox) {
    const perms = await prisma.sharedMailboxPerm.findMany({
      where: {
        sharedMailboxId: sharedMailbox.id,
        permission: { in: ['FULL_ACCESS', 'READ_ONLY'] },
        // 9.4: the event also drives Web Push — never to deactivated members
        user: { active: true },
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
        // 9.4: webmail mailbox key — the notification deep link opens the right mailbox
        mailbox: ownerType === 'shared' && sharedMailbox ? `shared:${sharedMailbox.id}` : 'own',
        folderId: ruleFolderId,
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

  // MAIL_FLOW — message flow tracing
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

  // Out-of-office reply (RFC 3834) — decision + sending in ./auto-reply.ts
  if (ownerType === 'user' && user) void sendAutoReplyIfNeeded({ userId: user.id, userEmail: user.email, envelopeFrom: opts.fromAddr, raw: effectiveBuffer, deliveredToJunk: opts.toJunk || mailbox.folders.find((f: { name: string }) => f.name === 'Junk')?.id === ruleFolderId });
  return 'stored';
}
