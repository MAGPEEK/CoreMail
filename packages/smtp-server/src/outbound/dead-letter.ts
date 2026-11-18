/**
 * Queue housekeeping driven by QueueSettings (BCP → Queues → Settings):
 *
 *  - Periodic cleaner (every 15 min): removes delivered jobs older than
 *    completedRetentionHours and — only with autoFlushDead — dead letters
 *    older than deadLetterRetentionDays. Applies changed settings to jobs that
 *    were enqueued before the change (per-job removeOn* options cannot).
 *  - Dead-letter notification (notifyOnDeadLetter): when a message ends in the
 *    dead-letter queue, the admins (ORGANIZATION_MANAGEMENT / SERVER_MANAGEMENT)
 *    get a notice in their inbox — at most one per 15 minutes (Redis throttle),
 *    the notice says how many further dead letters may follow.
 */
import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { createLogger, getRedisClient } from '@coremail/core';
import { prisma, loadQueueSettings, invalidateQueueSettingsCache, queueCleanPlan } from '@coremail/storage';

const log = createLogger('smtp:dead-letter');

export const CLEAN_INTERVAL_MS = 15 * 60_000;
export const NOTIFY_THROTTLE_SEC = 15 * 60;
const NOTIFY_KEY = 'queue:dead-letter:notified';
const ADMIN_ROLES = ['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT'] as const;

export interface DeadLetterInfo {
  jobId: string;
  from: string;
  to: string[];
  subject: string;
  reason: string;
  smtpCode: number | null;
  attempts: number;
}

/** Remove control characters / line breaks from header values. */
function hdr(v: string): string {
  return v.replace(/[\r\n\t\0]+/g, ' ').slice(0, 300);
}

/** Pure: the internal notice (RFC 5322, text/plain UTF-8) delivered to one admin. */
export function buildDeadLetterNotice(info: DeadLetterInfo, adminEmail: string, hostname: string, now = new Date()): Buffer {
  const body = [
    'A message could not be delivered and was moved to the dead-letter queue.',
    '',
    `Queue job:   ${info.jobId}`,
    `Sender:      ${hdr(info.from) || '<> (null sender)'}`,
    `Recipients:  ${hdr(info.to.join(', '))}`,
    `Subject:     ${hdr(info.subject) || '(none)'}`,
    `Attempts:    ${info.attempts}`,
    `SMTP code:   ${info.smtpCode ?? '-'}`,
    `Reason:      ${hdr(info.reason)}`,
    '',
    `Further dead letters within the next ${NOTIFY_THROTTLE_SEC / 60} minutes are not notified individually.`,
    'Review them in the BCP under Queues -> Dead letter.',
    '',
    '-- ',
    `CoreMail queue monitor on ${hostname}`,
  ].join('\r\n');
  const headers = [
    `From: CoreMail Queue Monitor <postmaster@${hostname}>`,
    `To: <${adminEmail}>`,
    `Subject: =?UTF-8?B?${Buffer.from(hdr(`[CoreMail] Undeliverable message: ${info.subject || info.to.join(', ')}`)).toString('base64')}?=`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomUUID()}@${hostname}>`,
    'Auto-Submitted: auto-generated',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8');
}

export interface DeadLetterDeps {
  notifyEnabled(): Promise<boolean>;
  /** Returns true when this call won the throttle slot. */
  acquireThrottle(): Promise<boolean>;
  adminEmails(): Promise<string[]>;
  hostname(): Promise<string>;
  deliver(raw: Buffer, rcpt: string): Promise<void>;
}

/** Notify the admins about a dead letter (respecting notifyOnDeadLetter + throttle). Returns the notified addresses. */
export async function notifyDeadLetter(info: DeadLetterInfo, deps: DeadLetterDeps = defaultDeps): Promise<string[]> {
  if (!(await deps.notifyEnabled())) return [];
  if (!(await deps.acquireThrottle())) return [];
  const admins = [...new Set((await deps.adminEmails()).map((e) => e.toLowerCase()))];
  const hostname = await deps.hostname();
  for (const a of admins) {
    await deps.deliver(buildDeadLetterNotice(info, a, hostname), a).catch((err: unknown) =>
      log.warn({ err, admin: a }, 'Dead-letter notice could not be delivered'));
  }
  return admins;
}

const defaultDeps: DeadLetterDeps = {
  notifyEnabled: async () => (await loadQueueSettings()).notifyOnDeadLetter,
  acquireThrottle: async () => (await getRedisClient().set(NOTIFY_KEY, '1', 'EX', NOTIFY_THROTTLE_SEC, 'NX')) === 'OK',
  adminEmails: async () => (await prisma.user.findMany({
    where: { active: true, role: { in: [...ADMIN_ROLES] } },
    select: { email: true },
  })).map((u) => u.email),
  hostname: async () => (await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } }))?.publicHostname ?? 'mail.local',
  deliver: async (raw, rcpt) => {
    // local delivery straight into the admin mailbox — never leaves the server
    const { storeInboundMessage } = await import('../handlers/message.js');
    await storeInboundMessage(raw, { fromAddr: '', rcptTo: rcpt, toJunk: false, skipTransportRules: true, systemNotice: true });
  },
};

/** One cleaner run with the current settings. */
export async function cleanQueueOnce(queue: Pick<Queue, 'clean'>): Promise<{ completed: number; failed: number }> {
  invalidateQueueSettingsCache();
  const plan = queueCleanPlan(await loadQueueSettings());
  const completed = (await queue.clean(plan.completedGraceMs, 1000, 'completed')).length;
  const failed = plan.failedGraceMs !== null ? (await queue.clean(plan.failedGraceMs, 1000, 'failed')).length : 0;
  if (completed || failed) log.info({ completed, failed }, 'Queue cleaner removed old jobs');
  return { completed, failed };
}

/** Starts the periodic cleaner; returns a stop function. */
export function startQueueMaintenance(queue: Pick<Queue, 'clean'>): () => void {
  const run = () => { void cleanQueueOnce(queue).catch((err: unknown) => log.warn({ err }, 'Queue cleaner failed')); };
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, CLEAN_INTERVAL_MS);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
