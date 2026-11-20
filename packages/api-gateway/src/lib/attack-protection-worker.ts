/**
 * 10.5 attack protection — the api-gateway's background part
 * (docs/attack-protection.md):
 *
 *  - every 60 s: flush the queued lock / auto-block / threshold items into ONE
 *    aggregated notice (at most one per 15 minutes, Redis-locked across
 *    instances — @coremail/storage flushAttackNotifications);
 *  - hourly: purge expired block list entries and old attack events
 *    (ATTACK_EVENT_RETENTION_DAYS, default 90; Redis-locked).
 *
 * Delivery: a local, active recipient gets the notice straight into the INBOX
 * (internal notify path — works while the MX is under attack); any other
 * address goes through the BullMQ `smtp-outbound` queue (rawMessage).
 */
import crypto from 'node:crypto';
import { createLogger, getRedisClient } from '@coremail/core';
import {
  prisma, getProductName, brandDisplayName, notifyMailboxInbox, buildCrlfMime,
  flushAttackNotifications, loadAttackProtectionSettings, attackNoticeRecipients, localMailboxIdOf,
  purgeAttackProtectionData,
  type NotifyRedis,
} from '@coremail/storage';

const log = createLogger('attack-protection');

const FLUSH_INTERVAL_MS = 60_000;
const PURGE_EVERY_TICKS = 60;
const PURGE_LOCK = 'attackprot:purge:lock';

interface Notice { subject: string; text: string; html: string }

async function senderAddress(): Promise<string> {
  const [s, primary] = await Promise.all([
    prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } }),
    prisma.domain.findFirst({ where: { primary: true, active: true }, select: { name: true } }),
  ]);
  return primary?.name ? `postmaster@${primary.name}` : `noreply@${s?.publicHostname || 'mail.local'}`;
}

/** Builds the raw MIME of a notice (CRLF, like every outbound job). */
function rawNotice(from: { name: string; address: string }, to: string, notice: Notice): Promise<Buffer> {
  return buildCrlfMime({
    from, to, subject: notice.subject, text: notice.text, html: notice.html,
    headers: { 'Auto-Submitted': 'auto-generated' },
  });
}

/** Delivers one notice: local mailbox → INBOX directly, else the outbound queue. */
export async function deliverAttackNotice(recipient: string, notice: Notice): Promise<void> {
  const product = await productName();
  const from = { name: product, address: await senderAddress() };
  const mailboxId = await localMailboxIdOf(recipient);
  if (mailboxId) {
    await notifyMailboxInbox(mailboxId, {
      fromName: from.name, fromAddr: from.address, subject: notice.subject, bodyText: notice.text, bodyHtml: notice.html,
    });
    return;
  }
  const raw = await rawNotice(from, recipient, notice);
  const { getOutboundQueue } = await import('../routes/mail.js');
  const { getOutboundJobOptions } = await import('@coremail/storage/queue-options');
  await getOutboundQueue().add('send', {
    messageId: `attack-notice-${crypto.randomUUID()}`,
    from: from.address,
    to: [recipient],
    rawMessage: raw.toString('base64'),
  }, await getOutboundJobOptions());
}

async function productName(): Promise<string> {
  const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { orgName: true } });
  return brandDisplayName(await getProductName(), s?.orgName);
}

async function host(): Promise<string> {
  const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } });
  return s?.publicHostname || 'mail.local';
}

/** One flush with the production dependencies (exported for tests / manual runs). */
export async function flushAttackNoticesOnce(): ReturnType<typeof flushAttackNotifications> {
  return flushAttackNotifications({
    redis: getRedisClient() as unknown as NotifyRedis,
    settings: loadAttackProtectionSettings,
    recipients: attackNoticeRecipients,
    deliver: deliverAttackNotice,
    host,
    product: productName,
  });
}

let timer: NodeJS.Timeout | null = null;

/** Starts the notice flusher (60 s) and the hourly purge. Idempotent; returns a stop function. */
export function startAttackProtectionWorker(): () => void {
  if (timer) return () => undefined;
  let ticks = 0;
  timer = setInterval(() => {
    ticks++;
    void flushAttackNoticesOnce().catch((err: unknown) => log.warn({ err }, 'attack notice flush failed'));
    if (ticks % PURGE_EVERY_TICKS === 1) {
      void (async () => {
        const redis = getRedisClient();
        if ((await redis.set(PURGE_LOCK, '1', 'EX', 3000, 'NX')) !== 'OK') return;
        const r = await purgeAttackProtectionData();
        if (r.rules || r.events) log.info(r, 'attack protection data purged (expired block list entries, old attack events)');
      })().catch((err: unknown) => log.warn({ err }, 'attack protection purge failed'));
    }
  }, FLUSH_INTERVAL_MS);
  timer.unref();
  return () => { if (timer) clearInterval(timer); timer = null; };
}
