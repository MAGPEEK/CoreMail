import { Queue, Worker, UnrecoverableError, type Job } from 'bullmq';
import { Readable } from 'stream';
import nodemailer from 'nodemailer';
import { createBullMqConnection, createLogger } from '@coremail/core';
import { prisma, downloadBuffer, deleteObject, buildOutboundJobOptions, getOutboundJobOptions, loadQueueSettings, isExpiredInQueue } from '@coremail/storage';
import { relayMessage, type RecipientFailure, type RelayResult, type DkimOptions } from './relay.js';
import { extractSmtpCode, sendDsnBounce, type DsnOptions } from './dsn.js';
import { BARE_POSTMASTER } from '../core/types.js';
import { signMessageForUser, encryptMessageForRecipient } from '../smime/index.js';
import { storeInboundMessage } from '../handlers/message.js';
import { isRuleForwardedAlready } from '../handlers/rule-forward.js';
import type { SenderAuth } from '@coremail/storage';
import { expandRecipients } from '../handlers/expand.js';
import { resolveJobDkim } from './dkim.js';
import { notifyDeadLetter, startQueueMaintenance } from './dead-letter.js';
// Journaling feature completely removed in v3.13.6

const log = createLogger('smtp:outbound-queue');

// ── Message format ────────────────────────────────────────────────────────────
//
// Since v3.17.30: api-gateway passes structured messages (no more base64 blob
// in the Redis job). The worker builds the RFC 5322 buffer with nodemailer.
// SMTP submission (ports 465/587) still uses rawMessage (base64) — email
// clients already deliver complete RFC 5322 messages.

export interface StructuredAttachment {
  filename:    string;
  minioPath:   string;   // key in MinIO (outbound-queue/{jobId}/{filename})
  contentType: string;
  size:        number;
}

export interface StructuredMessage {
  from:       string;    // sender email address
  fromName:   string;    // display name (empty → no quoted string)
  /** Optional RFC 5322 §3.6.2 Sender header for "on behalf of" (SEND_ON_BEHALF). */
  sender?:    string;
  to:         string[];
  cc:         string[];
  bcc:        string[];  // SMTP envelope only, NOT in the header
  subject:    string;
  html:       string;
  text:       string;
  messageId:  string;    // <uuid@domain>
  date:       string;    // ISO string
  inReplyTo?:  string;
  references?: string;
  attachments: StructuredAttachment[];
}

export interface OutboundJob {
  messageId:      string;    // tracking ID (not the email Message-ID)
  from:           string;    // SMTP-Envelope MAIL FROM
  to:             string[];  // SMTP envelope RCPT TO (all: To + CC + BCC)
  senderUserId?:  string;    // for S/MIME auto-sign
  /**
   * Created by a user's redirect rule: the envelope sender is the ORIGINAL
   * (possibly forged) sender, so a failure is bounced only to a local sender —
   * never to an external one (no backscatter).
   */
  ruleRedirect?:  boolean;
  dkimDomain?:    string;
  dkimSelector?:  string;
  dkimPrivateKey?: string;
  // Exactly one of the following fields must be set:
  message?:    StructuredMessage;  // web client path (v3.17.30+)
  rawMessage?: string;             // base64, SMTP submission path (clients)
  /**
   * Set by the BCP quarantine release (api-gateway). Local recipients are then
   * stored with `quarantineRelease` so the transport-rule quarantine action does
   * not re-quarantine the message. Only internal producers can set job fields.
   */
  quarantineReleaseId?: string;
  // ── Delivery progress (written by the worker, survives retries) ──────────
  /** Recipients (after alias expansion) that were stored or accepted remotely. */
  deliveredRcpts?: string[];
  /** Recipients that failed permanently and were already bounced. */
  bouncedRcpts?:   string[];
  /** Last temporary failure per recipient still pending (final bounce text). */
  pendingFailures?: RecipientFailure[];
  /** A delay DSN (RFC 3464 Action: delayed) was sent — at most one per message. */
  delayNotified?: boolean;
}

// ── Build RFC 5322 buffer from structured message ─────────────────────────────

async function buildRawFromMessage(msg: StructuredMessage): Promise<Buffer> {
  // Load attachments from MinIO (in parallel)
  const attachments: nodemailer.SendMailOptions['attachments'] = await Promise.all(
    msg.attachments.map(async (att) => ({
      filename:    att.filename,
      content:     await downloadBuffer(att.minioPath),
      contentType: att.contentType,
    }))
  );

  const transport = nodemailer.createTransport({
    streamTransport: true,
    newline: 'crlf',   // RFC 5321: SMTP requires CRLF line endings
  });

  const fromField: nodemailer.SendMailOptions['from'] = msg.fromName
    ? { name: msg.fromName, address: msg.from }
    : msg.from;

  const info = await transport.sendMail({
    messageId: msg.messageId,
    from:      fromField,
    // Sender: for SEND_ON_BEHALF — Outlook shows "Stefan on behalf of info@firma.de"
    ...(msg.sender ? { sender: msg.sender } : {}),
    to:        msg.to,
    subject:   msg.subject,
    date:      new Date(msg.date),
    ...(msg.cc.length         ? { cc: msg.cc }                                : {}),
    // BCC: NEVER in the message headers — only in the SMTP envelope (job.to)
    ...(msg.html              ? { html: msg.html }                            : {}),
    ...(msg.text              ? { text: msg.text }                            : {}),
    ...(msg.inReplyTo         ? { inReplyTo:  msg.inReplyTo,
                                  references: msg.references ?? msg.inReplyTo } : {}),
    ...(attachments.length    ? { attachments }                               : {}),
  });

  const stream = info.message as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/** Clean up a queue job's MinIO attachments after successful delivery. */
async function cleanupMinioAttachments(msg: StructuredMessage): Promise<void> {
  await Promise.allSettled(
    msg.attachments.map((att) => deleteObject(att.minioPath))
  );
}

// ── BullMQ queue ──────────────────────────────────────────────────────────────

const QUEUE_NAME = 'smtp-outbound'; // BullMQ v5: no ':' allowed in queue names

let _queue: Queue<OutboundJob> | null = null;

export function getOutboundQueue(): Queue<OutboundJob> {
  if (!_queue) {
    _queue = new Queue<OutboundJob>(QUEUE_NAME, {
      connection: createBullMqConnection(),
      // fallback only — every job gets its options from QueueSettings (getOutboundJobOptions)
      defaultJobOptions: buildOutboundJobOptions(null),
    });
  }
  return _queue;
}

export async function enqueueOutbound(job: OutboundJob): Promise<string> {
  const queue = getOutboundQueue();
  // QueueSettings (retry + retention) — admin changes apply without restart (60 s cache)
  const opts = await getOutboundJobOptions();
  const result = await queue.add('send', job, {
    ...opts,
    jobId: `${job.messageId}-${Date.now()}`,
  });
  log.info({ jobId: result.id, to: job.to, attempts: opts.attempts, backoffDelay: opts.backoff.delay }, 'Message enqueued to outbound queue');
  return result.id ?? '';
}

// ── Delivery of one job (pure orchestration, injectable I/O) ─────────────────

/** The parts of a BullMQ job the delivery logic needs. */
export interface OutboundJobLike {
  id?: string | undefined;
  data: OutboundJob;
  attemptsMade: number;
  opts: { attempts?: number | undefined; delay?: number | undefined };
  /** Enqueue time (ms) — BullMQ `job.timestamp`; used for the delay DSN. */
  timestamp?: number | undefined;
  updateData(data: OutboundJob): Promise<void>;
}

/**
 * Hours a message may wait in the queue before the sender gets ONE delay
 * notification (RFC 3464 Action: delayed, status 4.4.7). Env
 * `OUTBOUND_DELAY_DSN_HOURS` (default 4, 0 = off).
 */
export function delayDsnHours(env: Record<string, string | undefined> = process.env): number {
  const raw = (env['OUTBOUND_DELAY_DSN_HOURS'] ?? '').trim();
  if (raw === '') return 4;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 4;
}

/** Pure: is a delay DSN due for this job (once, after `hours` since the planned send time)? */
export function delayDsnDue(job: Pick<OutboundJobLike, 'data' | 'timestamp' | 'opts'>, hours: number, now = Date.now()): boolean {
  if (hours <= 0 || job.data.delayNotified || job.timestamp === undefined) return false;
  if (!job.data.from) return false; // null sender (bounces) never get a DSN
  const start = job.timestamp + Math.max(0, job.opts.delay ?? 0);
  return now - start >= hours * 3_600_000;
}

export interface OutboundDeps {
  isLocalAddress(addr: string): Promise<boolean>;
  expand(addrs: string[]): Promise<string[]>;
  storeLocal(raw: Buffer, from: string, rcpt: string, job: OutboundJob): Promise<void>;
  resolveDkim(job: OutboundJob): Promise<DkimOptions>;
  relay(raw: Buffer, from: string, to: string[], dkim: DkimOptions): Promise<RelayResult>;
  bounce(opts: DsnOptions): Promise<void>;
  hostname(): Promise<string>;
  /** When the queue gives up on the job (Will-Retry-Until of a delay DSN). */
  retryUntil?(job: Pick<OutboundJobLike, 'timestamp' | 'opts'>): Promise<Date>;
}

export interface DeliverySummary {
  local:     string[];
  external:  string[];
  delivered: string[];
  bounced:   string[];
}

/** Error thrown when recipients are still pending; carries the first remote reply code. */
class TemporaryDeliveryError extends Error {
  responseCode?: number;
}

/**
 * Delivers one queue job. Progress is stored in the job (`deliveredRcpts`,
 * `bouncedRcpts`) so a retry only handles the recipients that are still open:
 * local copies are never stored twice and domains that accepted the message
 * are not contacted again (RFC 5321 §6.1).
 *
 *  - permanent failures (5yz, null MX, NXDOMAIN) are bounced once, immediately
 *  - temporary failures are retried (throws), the last reply per recipient is
 *    kept for the final bounce
 *  - when every recipient failed permanently the job ends as a dead letter
 *    (UnrecoverableError) — the bounce has already been sent
 */
export async function deliverOutboundJob(job: OutboundJobLike, buffer: Buffer, deps: OutboundDeps): Promise<DeliverySummary> {
  const data = job.data;
  const { from, to } = data;
  const delivered = new Set(data.deliveredRcpts ?? []);
  const bounced   = new Set(data.bouncedRcpts ?? []);
  const persist = (pending: RecipientFailure[]) => job.updateData({
    ...job.data,
    deliveredRcpts:  [...delivered],
    bouncedRcpts:    [...bounced],
    pendingFailures: pending,
  });
  const isLocal = async (addr: string) => addr.toLowerCase() === BARE_POSTMASTER || deps.isLocalAddress(addr);

  // Split → expand local recipients (aliases, postmaster) → split again.
  const localRcpts: string[] = [];
  const externalRcpts: string[] = [];
  for (const rcpt of to) (await isLocal(rcpt) ? localRcpts : externalRcpts).push(rcpt);
  const expanded = localRcpts.length > 0 ? await deps.expand(localRcpts) : [];
  const finalLocal: string[] = [];
  const finalExternal: string[] = [...externalRcpts];
  for (const rcpt of expanded) (await isLocal(rcpt) ? finalLocal : finalExternal).push(rcpt);
  const external = [...new Set(finalExternal)];

  // ── Local delivery (write directly into the mailbox) ──────────────────────
  for (const rcpt of finalLocal) {
    if (delivered.has(rcpt)) continue;
    try {
      await deps.storeLocal(buffer, from, rcpt, data);
    } catch (err) {
      await persist(data.pendingFailures ?? []);
      throw err;
    }
    delivered.add(rcpt);
    log.info({ rcpt, jobId: job.id }, 'Local delivery (outbound → mailbox)');
  }

  // ── External delivery via MX / smarthost ──────────────────────────────────
  const pending = external.filter((r) => !delivered.has(r) && !bounced.has(r));
  let transient: RecipientFailure[] = [];
  const newlyBounced: string[] = [];
  if (pending.length > 0) {
    const result = await deps.relay(buffer, from, pending, await deps.resolveDkim(data));
    for (const r of result.delivered) delivered.add(r);
    const permanent = result.failures.filter((f) => f.permanent);
    transient = result.failures.filter((f) => !f.permanent);
    if (permanent.length > 0) {
      await deps.bounce({
        originalFrom:      from,
        originalTo:        permanent.map((f) => f.rcpt),
        originalSubject:   data.message?.subject ?? '',
        originalMessageId: data.message?.messageId ?? null,
        failureReason:     permanent[0]!.message,
        smtpCode:          permanent[0]!.code,
        serverHostname:    await deps.hostname(),
        recipients:        permanent.map((f) => ({ rcpt: f.rcpt, status: f.status, diagnostic: f.message, remote: f.code !== null })),
        deliverExternal:   data.ruleRedirect !== true, // redirect rule: no backscatter to a forged external sender
      });
      for (const f of permanent) { bounced.add(f.rcpt); newlyBounced.push(f.rcpt); }
    }
  }
  await persist(transient);

  // One delay notification once the message waited OUTBOUND_DELAY_DSN_HOURS.
  // Marked in the job BEFORE sending: at most one DSN even if sending fails.
  if (transient.length > 0 && delayDsnDue(job, delayDsnHours())) {
    await job.updateData({ ...job.data, delayNotified: true });
    try {
      await deps.bounce({
        originalFrom:      from,
        originalTo:        transient.map((f) => f.rcpt),
        originalSubject:   data.message?.subject ?? '',
        originalMessageId: data.message?.messageId ?? null,
        failureReason:     transient[0]!.message,
        smtpCode:          transient[0]!.code,
        serverHostname:    await deps.hostname(),
        recipients:        transient.map((f) => ({ rcpt: f.rcpt, status: '4.4.7', diagnostic: f.message, remote: f.code !== null })),
        deliverExternal:   data.ruleRedirect !== true,
        action:            'delayed',
        ...(deps.retryUntil ? { willRetryUntil: await deps.retryUntil(job) } : {}),
      });
    } catch (err) {
      log.warn({ err, jobId: job.id }, 'Delay DSN failed');
    }
  }

  if (transient.length > 0) {
    const err = new TemporaryDeliveryError(
      `Temporary failure for ${transient.length} recipient(s): ${transient.map((f) => `<${f.rcpt}> ${f.message}`).join('; ')}`,
    );
    const code = transient.find((f) => f.code !== null)?.code;
    if (code) err.responseCode = code;
    throw err;
  }
  if (newlyBounced.length > 0 && delivered.size === 0) {
    throw new UnrecoverableError(`All recipients failed permanently: ${newlyBounced.join(', ')}`);
  }
  return { local: finalLocal, external, delivered: [...delivered], bounced: [...bounced] };
}

/**
 * Recipients of the final bounce when a job gives up (retries exhausted, expiry,
 * unrecoverable error): every recipient neither delivered nor bounced before,
 * with its last temporary failure when one is known.
 */
export function finalBounceRecipients(data: OutboundJob, err: unknown): RecipientFailure[] {
  const done = new Set([...(data.deliveredRcpts ?? []), ...(data.bouncedRcpts ?? [])]);
  const known = (data.pendingFailures ?? []).filter((f) => !done.has(f.rcpt));
  if (known.length > 0) return known;
  const { code } = extractSmtpCode(err);
  const message = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, ' ');
  return data.to
    .filter((r) => !done.has(r))
    .map((rcpt) => ({ rcpt, code, status: code ? `${Math.floor(code / 100)}.0.0` : '4.4.7', message, permanent: false }));
}

/**
 * Pure: sender authentication for a locally delivered queue job. Only jobs of
 * an authenticated user (REST/JMAP/EAS/SMTP submission set `senderUserId`,
 * after their sender-identity check) count — not rule forwards/redirects
 * (they carry someone else's message) and not quarantine releases.
 */
export function senderAuthForJob(job: OutboundJob, raw: Buffer): { senderAuth: SenderAuth } | Record<string, never> {
  if (!job.senderUserId || job.ruleRedirect || job.quarantineReleaseId) return {};
  if (isRuleForwardedAlready(raw)) return {};
  return { senderAuth: { authenticatedSender: job.from } };
}

// ── Worker ────────────────────────────────────────────────────────────────────

async function publicHostname(): Promise<string> {
  const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } });
  return settings?.publicHostname ?? 'mail.local';
}

const defaultOutboundDeps: OutboundDeps = {
  isLocalAddress: async (addr) => {
    const domain = addr.slice(addr.lastIndexOf('@') + 1).toLowerCase();
    if (!addr.includes('@') || !domain) return false;
    return !!(await prisma.domain.findFirst({ where: { name: domain, active: true }, select: { id: true } }));
  },
  expand: (addrs) => expandRecipients(addrs),
  storeLocal: (raw, from, rcpt, job) => storeInboundMessage(raw, {
    fromAddr: from,
    rcptTo:   rcpt,
    toJunk:   false,
    ...senderAuthForJob(job, raw),
    // Stable across the job's retries: rule forwards are not queued twice.
    deliveryKey: `job:${job.messageId}`,
    ...(job.quarantineReleaseId ? { quarantineRelease: true } : {}),
  }),
  // Jobs without DKIM fields (SMTP submission, rule forwards, EAS) get the key
  // of the envelope-from domain — every local-domain mail is signed.
  resolveDkim: (job) => resolveJobDkim({
    from: job.from,
    ...(job.dkimDomain     ? { dkimDomain: job.dkimDomain }         : {}),
    ...(job.dkimSelector   ? { dkimSelector: job.dkimSelector }     : {}),
    ...(job.dkimPrivateKey ? { dkimPrivateKey: job.dkimPrivateKey } : {}),
  }),
  relay: (raw, from, to, dkim) => relayMessage(raw, from, to, dkim),
  bounce: (opts) => sendDsnBounce(opts),
  hostname: publicHostname,
  retryUntil: async (job) => {
    const s = await loadQueueSettings();
    return new Date((job.timestamp ?? Date.now()) + Math.max(0, job.opts.delay ?? 0) + s.outboundRetentionHours * 3_600_000);
  },
};

export function startOutboundWorker(): Worker<OutboundJob> {
  const worker = new Worker<OutboundJob>(
    QUEUE_NAME,
    async (job: Job<OutboundJob>) => {
      const { from, to, senderUserId } = job.data;

      log.info({ jobId: job.id, from, to, attempt: job.attemptsMade + 1 }, 'Delivery started');

      // QueueSettings.outboundRetentionHours: give up on messages that stayed
      // too long in the queue (→ dead letter + DSN, no further retries).
      const queueSettings = await loadQueueSettings();
      if (isExpiredInQueue(job, queueSettings)) {
        throw new UnrecoverableError(`Message expired in queue after ${queueSettings.outboundRetentionHours} hours`);
      }

      // ── Schedule-send: cancellation check ────────────────────────────────
      // If the user cancelled the scheduled mail in the MWA via "cancel schedule",
      // the job was removed (BullMQ.remove()), but if it has already started,
      // the worker itself must check whether the message has meanwhile been
      // set to CANCELLED.
      if (job.id) {
        const scheduled = await prisma.message.findFirst({
          where: { scheduledJobId: job.id },
          select: { id: true, scheduledStatus: true },
        });
        if (scheduled && scheduled.scheduledStatus === 'CANCELLED') {
          log.info({ jobId: job.id, msgId: scheduled.id }, 'Scheduled send cancelled — worker stops');
          return; // mark job as successful without sending
        }
      }

      // ── Build RFC 5322 buffer ─────────────────────────────────────────────
      // Either from a structured message (web client path, v3.17.30+)
      // or from base64 raw data (SMTP submission path, clients).
      let buffer: Buffer;
      if (job.data.message) {
        buffer = await buildRawFromMessage(job.data.message);
        log.debug({ jobId: job.id }, 'RFC 5322 buffer built from structured message');
      } else if (job.data.rawMessage) {
        buffer = Buffer.from(job.data.rawMessage, 'base64');
        log.debug({ jobId: job.id }, 'RFC 5322 buffer decoded from base64 raw data');
      } else {
        throw new UnrecoverableError('OutboundJob without message and rawMessage — invalid job');
      }

      // ── Phase 9: S/MIME Auto-Sign / Auto-Encrypt ──────────────────────────
      if (senderUserId) {
        const settings = await prisma.smimeSettings.findUnique({
          where: { userId: senderUserId },
        });
        if (settings?.autoSign) {
          buffer = Buffer.from(await signMessageForUser(buffer, senderUserId));
          log.debug({ jobId: job.id }, 'S/MIME signature applied');
        }
        if (settings?.autoEncrypt && to.length === 1) {
          buffer = Buffer.from(await encryptMessageForRecipient(buffer, to[0]!));
          log.debug({ jobId: job.id }, 'S/MIME encryption applied');
        }
      }

      const summary = await deliverOutboundJob(job, buffer, defaultOutboundDeps);

      // ── MAIL_FLOW log ─────────────────────────────────────────────────────
      void prisma.systemLog.create({
        data: {
          level:     'INFO',
          service:   'smtp-server',
          category:  'MAIL_FLOW',
          message:   `Delivered: ${from} → ${summary.delivered.join(', ')}`,
          messageId: job.data.messageId,
          ...(job.data.senderUserId ? { userId: job.data.senderUserId } : {}),
          metadata: {
            sender:        from,
            recipient:     summary.delivered.join(', '),
            subject:       job.data.message?.subject ?? '',
            status:        'DELIVERED',
            messageId:     job.data.messageId,
            size:          String(buffer.length),
            localRcpts:    summary.local.join(', '),
            externalRcpts: summary.external.join(', '),
            bouncedRcpts:  summary.bounced.join(', '),
            direction:     'OUTBOUND',
          },
        },
      }).catch((e: unknown) => log.error({ err: e }, 'MAIL_FLOW log failed'));

      log.info({ jobId: job.id, to }, 'Message delivered');

      // Schedule-send: set status to SENT so the banner in the MWA disappears
      if (job.id) {
        await prisma.message.updateMany({
          where: { scheduledJobId: job.id, scheduledStatus: 'PENDING' },
          data:  { scheduledStatus: 'SENT' },
        }).catch((e: unknown) => log.warn({ err: e }, 'scheduledStatus=SENT update failed'));
      }
    },
    {
      connection: createBullMqConnection(), // maxRetriesPerRequest: null (required by BullMQ)
      concurrency: 10,
    },
  );

  // ── MinIO cleanup after completion ────────────────────────────────────────
  worker.on('completed', (job) => {
    log.info({ jobId: job.id }, 'Delivery completed');
    if (job.data.message?.attachments.length) {
      void cleanupMinioAttachments(job.data.message).catch(
        (e: unknown) => log.warn({ err: e, jobId: job.id }, 'MinIO cleanup failed')
      );
    }
  });

  worker.on('failed', (job, err) => {
    if (!job?.data) {
      log.error({ jobId: job?.id, err }, 'Delivery failed (no job data)');
      return;
    }
    handleFailedJob(job, err, defaultOutboundDeps);
  });

  // QueueSettings retention: periodic cleaner (completed + auto-flushed dead letters)
  const stopMaintenance = startQueueMaintenance(getOutboundQueue());
  worker.on('closed', stopMaintenance);

  return worker;
}

/**
 * BullMQ `failed` event — emitted after EVERY failed attempt (after
 * moveToFailed, so retry decisions are already made: a `job.discard()` here
 * would be too late). Permanent per-recipient failures were bounced inside the
 * processor; here only the final give-up bounces the still-open recipients.
 */
export function handleFailedJob(
  job: Pick<OutboundJobLike, 'id' | 'data' | 'attemptsMade' | 'opts'>,
  err: Error,
  deps: Pick<OutboundDeps, 'bounce' | 'hostname'> & { deadLetter?: typeof notifyDeadLetter },
): { final: boolean; bounced: string[] } {
  const deadLetter = deps.deadLetter ?? notifyDeadLetter;
  const attemptsMax = job.opts.attempts ?? 10;
  const { code: smtpCode } = extractSmtpCode(err);
  const unrecoverable = err instanceof UnrecoverableError || err?.name === 'UnrecoverableError';
  const final = unrecoverable || job.attemptsMade >= attemptsMax;

  log.error(
    { jobId: job.id, err, smtpCode, final, attempt: job.attemptsMade },
    final ? 'Delivery permanently failed' : 'Delivery temporarily failed (will be retried)',
  );

  let bounceList: RecipientFailure[] = [];
  if (final) {
    // Clean up MinIO attachments only on permanent failure (retries need them)
    if (job.data.message?.attachments.length) {
      void cleanupMinioAttachments(job.data.message).catch(
        (e: unknown) => log.warn({ err: e, jobId: job.id }, 'MinIO cleanup failed')
      );
    }
    // QueueSettings.notifyOnDeadLetter → notice to the admins (throttled)
    void deadLetter({
      jobId:    String(job.id ?? ''),
      from:     job.data.from,
      to:       job.data.to,
      subject:  job.data.message?.subject ?? '',
      reason:   err.message,
      smtpCode,
      attempts: job.attemptsMade,
    }).catch((e: unknown) => log.warn({ err: e, jobId: job.id }, 'Dead-letter notification failed'));

    // RFC 5321 §6.1: the message was accepted (250) → the sender MUST be
    // notified, also when it is external. Exactly once: only on give-up and
    // only for recipients that were not delivered or bounced before.
    bounceList = finalBounceRecipients(job.data, err);
    if (bounceList.length > 0) {
      const list = bounceList;
      void (async () => {
        try {
          await deps.bounce({
            originalFrom:      job.data.from,
            originalTo:        list.map((f) => f.rcpt),
            originalSubject:   job.data.message?.subject ?? '',
            originalMessageId: job.data.message?.messageId ?? null,
            failureReason:     err.message,
            smtpCode,
            serverHostname:    await deps.hostname(),
            recipients:        list.map((f) => ({ rcpt: f.rcpt, status: f.status, diagnostic: f.message, remote: f.code !== null })),
            deliverExternal:   job.data.ruleRedirect !== true, // redirect rule: no backscatter
          });
        } catch (dsnErr) {
          log.error({ err: dsnErr, jobId: job.id }, 'DSN generation failed');
        }
      })();
    }
  }

  void prisma.systemLog.create({
    data: {
      level:    final ? 'ERROR' : 'WARN',
      service:  'smtp-server',
      category: 'MAIL_FLOW',
      message:  `${final ? 'Failed' : 'Deferred'}: ${job.data.from} → ${job.data.to.join(', ')}${smtpCode ? ` [${smtpCode}]` : ''}`,
      messageId: job.data.messageId,
      ...(job.data.senderUserId ? { userId: job.data.senderUserId } : {}),
      metadata: {
        sender:    job.data.from,
        recipient: job.data.to.join(', '),
        subject:   job.data.message?.subject ?? '',
        status:    final ? 'REJECTED' : 'DEFERRED',
        messageId: job.data.messageId,
        reason:    err.message,
        smtpCode:  smtpCode !== null ? String(smtpCode) : '',
        attempt:   String(job.attemptsMade),
        direction: 'OUTBOUND',
      },
    },
  }).catch(() => {});

  return { final, bounced: bounceList.map((f) => f.rcpt) };
}
