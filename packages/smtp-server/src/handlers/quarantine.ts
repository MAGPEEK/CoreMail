/**
 * Quarantine store path — shared by the content-filter decision (ClamAV /
 * rspamd via security-filter, inbound/handler.ts) and the transport-rule
 * `quarantine` action (handlers/transport-actions.ts).
 *
 * Persists the RAW message to MinIO (`quarantine/<id>.eml`, 90-day lifecycle)
 * plus a `Quarantine` row with the full envelope in `details.envelope`.
 * No mailbox delivery happens here — a BCP release re-injects the message.
 */
import crypto from 'crypto';
import { createLogger, getRedisClient } from '@coremail/core';
import { prisma, uploadBuffer, quarantineKey, type QuarantineReason } from '@coremail/storage';

const log = createLogger('smtp:quarantine');

export interface QuarantineInput {
  raw:        Buffer;
  from:       string;
  recipients: string[];
  reason:     QuarantineReason;
  /** Extra details (virusName, ruleIds, filterReason …) merged into `details`. */
  details?:   Record<string, unknown>;
  spamScore?: number;
}

export interface QuarantineDeps {
  upload:  (key: string, buf: Buffer, contentType: string) => Promise<void>;
  keyFor:  (id: string) => string;
  /** Admin notification (Redis pub/sub) — best effort. */
  notify:  (event: Record<string, unknown>) => Promise<void>;
}

const defaultDeps: QuarantineDeps = {
  upload: (key, buf, ct) => uploadBuffer(key, buf, ct),
  keyFor: quarantineKey,
  notify: async (event) => {
    await getRedisClient().publish('admin:event', JSON.stringify(event));
  },
};

function extractHeaders(raw: Buffer): { subject: string; messageId: string } {
  const end = raw.indexOf('\r\n\r\n');
  const text = raw.subarray(0, end > 0 ? end : Math.min(raw.length, 8192)).toString('binary');
  const subjectMatch = /^Subject:\s*(.+?)(?=\r?\n\S|\r?\n\r?\n|$)/im.exec(text);
  const msgIdMatch   = /^Message-ID:\s*([^\r\n]+)/im.exec(text);
  return {
    subject:   (subjectMatch?.[1] ?? '').replace(/\r?\n[ \t]/g, ' ').trim(),
    messageId: (msgIdMatch?.[1] ?? '').trim(),
  };
}

/** Stores the message in quarantine and returns the quarantine id. */
export async function quarantineMessage(input: QuarantineInput, deps: QuarantineDeps = defaultDeps): Promise<string> {
  const headers = extractHeaders(input.raw);
  const recipients = [...new Set(input.recipients.map((r) => r.toLowerCase()))];
  const id = crypto.randomUUID();
  const rawPath = deps.keyFor(id);

  await deps.upload(rawPath, input.raw, 'message/rfc822');

  await prisma.quarantine.create({
    data: {
      id,
      ...(headers.messageId ? { messageId: headers.messageId } : {}),
      fromAddr: input.from,
      toAddr:   recipients[0] ?? '',
      subject:  headers.subject,
      reason:   input.reason,
      details:  {
        ...(input.details ?? {}),
        envelope: { from: input.from, recipients },
        ...(input.spamScore !== undefined ? { spamScore: input.spamScore } : {}),
      } as never,
      rawPath,
    },
  });

  // MAIL_FLOW — message flow tracing
  void prisma.systemLog.create({
    data: {
      level: 'WARN',
      service: 'smtp-server',
      category: 'MAIL_FLOW',
      message: `Quarantined: ${input.from} → ${recipients.join(', ')}`,
      ...(headers.messageId ? { messageId: headers.messageId } : {}),
      metadata: {
        sender: input.from,
        recipient: recipients.join(', '),
        subject: headers.subject,
        status: 'QUARANTINE',
        messageId: headers.messageId,
        size: String(input.raw.length),
        spamScore: input.spamScore !== undefined ? String(input.spamScore) : '',
        reason: input.reason,
        direction: 'INBOUND',
      },
    },
  }).catch((err: unknown) => log.error({ err }, 'MAIL_FLOW log failed'));

  log.warn({ id, reason: input.reason, from: input.from, recipients }, 'Message quarantined');

  await deps.notify({
    type: 'QUARANTINE',
    reason: input.reason,
    ...(typeof input.details?.['virusName'] === 'string' ? { virusName: input.details['virusName'] } : {}),
    from: input.from,
    to: recipients,
    quarantineId: id,
    timestamp: new Date().toISOString(),
  }).catch((err: unknown) => log.warn({ err }, 'Quarantine admin notification failed'));

  return id;
}
