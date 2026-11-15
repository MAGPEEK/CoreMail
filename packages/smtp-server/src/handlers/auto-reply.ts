/**
 * Out-of-office auto-replies (RFC 3834), sent after a successful local store.
 *
 * Single source of truth: UserSettings.oof* — written by the MWA
 * (/api/v1/user/oof) and by JMAP VacationResponse/set.
 *
 * RFC 3834 rules implemented:
 *  - reply only to the envelope sender (§3.1.1), never to a null sender `<>`,
 *    never to the recipient's own address/aliases, never to typical automated
 *    senders (MAILER-DAEMON, *-request, owner-*, noreply …)
 *  - never answer automatically submitted mail (`Auto-Submitted` ≠ `no`, §2),
 *    mailing-list / bulk mail (`List-*`, `Precedence: bulk|list|junk`) and
 *    mail that suppresses OOF (`X-Auto-Response-Suppress: All|OOF`); never
 *    answer mail delivered to Junk; only answer mail that names one of the
 *    recipient's addresses in To/Cc/Bcc/Resent-* (§2 — not Bcc'd copies)
 *  - exactly one reply per sender per OOF period (Exchange semantics, §2 asks
 *    for at most one per 7 days — stricter is fine): Redis key with the period
 *    id (UserSettings.oofPeriodId, renewed when OOF is switched on or its
 *    texts/schedule change, see @coremail/storage oof.ts) plus a hash of the
 *    texts/schedule; it lives until the scheduled end (+1 day), for an
 *    open-ended OOF for OOF_REPLY_MEMORY_DAYS (default 366)
 *  - reply headers: `Auto-Submitted: auto-replied`, `In-Reply-To`,
 *    `References`, `Subject: Auto: …` (§3.1.5–3.1.7); envelope MAIL FROM is
 *    the null path (§3.3) so that a bounce cannot loop; DKIM-signed with the
 *    recipient domain's key; sent via the outbound queue
 *  - honours the time range (oofUseTimeRange/oofStart/oofEnd) and the
 *    internal/external split (oofExternalEnabled, oofExternalOnlyContacts)
 */
import { createHash, randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { createLogger, getRedisClient } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log = createLogger('smtp:auto-reply');

/** Legacy minimum (RFC 3834 §2): never more than one reply per sender per 7 days. */
export const AUTO_REPLY_WINDOW_SEC = 7 * 24 * 3600;

export interface OofSettings {
  oofEnabled: boolean;
  oofInternal: string;
  oofExternal: string;
  oofExternalEnabled: boolean;
  oofExternalOnlyContacts: boolean;
  oofUseTimeRange: boolean;
  oofStart: Date | null;
  oofEnd: Date | null;
  /** v8.1: current OOF period ('' for rows written before 8.1). */
  oofPeriodId?: string;
}

/**
 * Pure: how long the "already replied" marker for a sender lives — until the
 * end of a scheduled period (+1 day), else OOF_REPLY_MEMORY_DAYS (default 366).
 * Never shorter than the RFC 3834 7-day minimum.
 */
export function replyMemoryTtlSec(s: OofSettings, now: Date, env: Record<string, string | undefined> = process.env): number {
  if (s.oofUseTimeRange && s.oofEnd) {
    const sec = Math.ceil((s.oofEnd.getTime() - now.getTime()) / 1000) + 24 * 3600;
    return Math.max(AUTO_REPLY_WINDOW_SEC, sec);
  }
  const days = Number(env['OOF_REPLY_MEMORY_DAYS']);
  return Math.max(AUTO_REPLY_WINDOW_SEC, (Number.isFinite(days) && days > 0 ? days : 366) * 24 * 3600);
}

/** Lower-cased header name → values (unfolded). */
export type HeaderMap = Map<string, string[]>;

/** Pure: parse the header block of a raw RFC 5322 message. */
export function parseHeaderBlock(raw: Buffer | string): HeaderMap {
  const text = typeof raw === 'string' ? raw : raw.subarray(0, Math.min(raw.length, 256 * 1024)).toString('utf8');
  const end = text.search(/\r?\n\r?\n/);
  const block = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, ' ');
  const map: HeaderMap = new Map();
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const list = map.get(name) ?? [];
    list.push(line.slice(i + 1).trim());
    map.set(name, list);
  }
  return map;
}

const AUTOMATED_LOCALPART = /^(mailer-daemon|listserv|majordomo|no-?reply|do-?not-?reply|bounces?|owner-.+|.+-request|.+-owner|.+-bounces?)$/i;

export function bareAddress(v: string): string {
  const m = /<([^>]*)>/.exec(v);
  return (m ? m[1]! : v).trim().toLowerCase();
}

const RECIPIENT_FIELDS = ['to', 'cc', 'bcc', 'resent-to', 'resent-cc', 'resent-bcc'];

/** RFC 3834 §2: one of `ownAddresses` appears in To/Cc/Bcc/Resent-To/-Cc/-Bcc. */
export function isExplicitRecipient(headers: HeaderMap, ownAddresses: readonly string[]): boolean {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  for (const name of RECIPIENT_FIELDS) {
    for (const value of headers.get(name) ?? []) {
      for (const m of value.matchAll(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g)) {
        if (own.has(m[0].toLowerCase())) return true;
      }
    }
  }
  return false;
}

export interface AutoReplyInput {
  settings: OofSettings | null;
  envelopeFrom: string;
  /** Own addresses of the recipient (primary + aliases), lower-case. */
  ownAddresses: readonly string[];
  headers: HeaderMap;
  deliveredToJunk: boolean;
  senderIsInternal: boolean;
  senderIsContact: boolean;
  now: Date;
}

export type AutoReplyDecision =
  | { send: true; body: string; audience: 'internal' | 'external' }
  | { send: false; reason: string };

/** Pure RFC 3834 decision (without the per-sender rate limit). */
export function decideAutoReply(i: AutoReplyInput): AutoReplyDecision {
  const s = i.settings;
  if (!s || !s.oofEnabled) return { send: false, reason: 'oof disabled' };
  if (s.oofUseTimeRange) {
    if (s.oofStart && i.now < s.oofStart) return { send: false, reason: 'before oof period' };
    if (s.oofEnd && i.now > s.oofEnd) return { send: false, reason: 'after oof period' };
  }
  const sender = bareAddress(i.envelopeFrom);
  if (!sender || !sender.includes('@')) return { send: false, reason: 'null sender' };
  if (i.ownAddresses.includes(sender)) return { send: false, reason: 'own address' };
  if (AUTOMATED_LOCALPART.test(sender.slice(0, sender.lastIndexOf('@')))) return { send: false, reason: 'automated sender' };
  if (i.deliveredToJunk) return { send: false, reason: 'junk' };

  const h = (n: string) => i.headers.get(n) ?? [];
  const autoSubmitted = h('auto-submitted').map((v) => v.split(';')[0]!.trim().toLowerCase());
  if (autoSubmitted.some((v) => v !== 'no')) return { send: false, reason: 'auto-submitted' };
  if (h('precedence').some((v) => /^(bulk|list|junk)$/i.test(v.trim()))) return { send: false, reason: 'precedence' };
  for (const name of ['list-id', 'list-unsubscribe', 'list-post', 'list-help', 'list-subscribe', 'list-owner', 'list-archive']) {
    if (h(name).length > 0) return { send: false, reason: 'mailing list' };
  }
  if (h('x-auto-response-suppress').some((v) => /\b(all|oof)\b/i.test(v))) return { send: false, reason: 'suppressed' };
  // §2: no personal response unless one of the recipient's addresses is
  // explicitly listed in a recipient field (Bcc'd copies, list exploders
  // without List-* headers).
  if (!isExplicitRecipient(i.headers, i.ownAddresses)) return { send: false, reason: 'not addressed explicitly' };

  if (i.senderIsInternal) {
    return s.oofInternal.trim() ? { send: true, body: s.oofInternal, audience: 'internal' } : { send: false, reason: 'no internal text' };
  }
  if (!s.oofExternalEnabled) return { send: false, reason: 'external replies disabled' };
  if (s.oofExternalOnlyContacts && !i.senderIsContact) return { send: false, reason: 'sender not a contact' };
  return s.oofExternal.trim() ? { send: true, body: s.oofExternal, audience: 'external' } : { send: false, reason: 'no external text' };
}

/** Rate-limit key: one reply per (user, sender, OOF period id + texts/schedule). */
export function rateLimitKey(userId: string, sender: string, s: OofSettings): string {
  const version = createHash('sha256')
    .update(`${s.oofPeriodId ?? ''}\0${s.oofInternal}\0${s.oofExternal}\0${s.oofUseTimeRange ? 1 : 0}\0${s.oofStart?.toISOString() ?? ''}\0${s.oofEnd?.toISOString() ?? ''}`)
    .digest('hex').slice(0, 16);
  const who = createHash('sha256').update(sender.toLowerCase()).digest('hex').slice(0, 24);
  return `oof:sent:${userId}:${version}:${who}`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Pure-ish: build the RFC 3834 reply message. */
export async function buildAutoReply(opts: {
  fromAddress: string;
  fromName?: string;
  to: string;
  originalHeaders: HeaderMap;
  body: string;
  hostname: string;
}): Promise<Buffer> {
  const first = (n: string) => opts.originalHeaders.get(n)?.[0];
  const origSubject = (first('subject') ?? '').replace(/[\r\n]+/g, ' ').trim();
  const msgId = first('message-id')?.trim();
  const refs = [...(first('references')?.split(/\s+/).filter(Boolean) ?? []), ...(msgId ? [msgId] : [])];
  const isHtml = /<[a-z][\s\S]*>/i.test(opts.body);
  const composer = new MailComposer({
    from: opts.fromName ? { name: opts.fromName, address: opts.fromAddress } : opts.fromAddress,
    to: opts.to,
    subject: `Auto: ${origSubject || '(no subject)'}`,
    messageId: `<${randomUUID()}@${opts.hostname}>`,
    date: new Date(),
    ...(msgId ? { inReplyTo: msgId } : {}),
    ...(refs.length ? { references: refs.slice(-20) } : {}),
    headers: {
      'Auto-Submitted': 'auto-replied',
      'X-Auto-Response-Suppress': 'All',
    },
    ...(isHtml ? { html: opts.body, text: htmlToText(opts.body) } : { text: opts.body }),
  });
  return composer.compile().build();
}

export interface AutoReplyDeps {
  loadSettings(userId: string): Promise<OofSettings | null>;
  ownAddresses(userId: string, email: string): Promise<string[]>;
  isLocalDomain(domain: string): Promise<boolean>;
  isContact(userId: string, sender: string): Promise<boolean>;
  /** SET NX with TTL; true when this call may send. */
  acquire(key: string, ttlSec: number): Promise<boolean>;
  hostname(): Promise<string>;
  displayName(userId: string): Promise<string | undefined>;
  enqueue(job: { from: string; to: string; raw: Buffer }): Promise<void>;
}

export interface AutoReplyContext {
  userId: string;
  userEmail: string;
  envelopeFrom: string;
  raw: Buffer;
  deliveredToJunk: boolean;
  now?: Date;
}

/** Decide + rate-limit + send. Returns the decision reason (for logs/tests). Never throws. */
export async function sendAutoReplyIfNeeded(ctx: AutoReplyContext, deps: AutoReplyDeps = defaultDeps): Promise<string> {
  try {
    const settings = await deps.loadSettings(ctx.userId);
    if (!settings?.oofEnabled) return 'oof disabled';
    const sender = bareAddress(ctx.envelopeFrom);
    const senderDomain = sender.includes('@') ? sender.slice(sender.lastIndexOf('@') + 1) : '';
    const headers = parseHeaderBlock(ctx.raw);
    const senderIsInternal = senderDomain ? await deps.isLocalDomain(senderDomain) : false;
    const decision = decideAutoReply({
      settings,
      envelopeFrom: ctx.envelopeFrom,
      ownAddresses: await deps.ownAddresses(ctx.userId, ctx.userEmail),
      headers,
      deliveredToJunk: ctx.deliveredToJunk,
      senderIsInternal,
      senderIsContact: !senderIsInternal && settings.oofExternalOnlyContacts ? await deps.isContact(ctx.userId, sender) : false,
      now: ctx.now ?? new Date(),
    });
    if (!decision.send) return decision.reason;
    const now = ctx.now ?? new Date();
    if (!(await deps.acquire(rateLimitKey(ctx.userId, sender, settings), replyMemoryTtlSec(settings, now)))) return 'rate limited';

    const name = await deps.displayName(ctx.userId);
    const raw = await buildAutoReply({
      fromAddress: ctx.userEmail,
      ...(name ? { fromName: name } : {}),
      to: sender,
      originalHeaders: headers,
      body: decision.body,
      hostname: await deps.hostname(),
    });
    await deps.enqueue({ from: ctx.userEmail, to: sender, raw });
    log.info({ userId: ctx.userId, to: sender, audience: decision.audience }, 'Out-of-office reply enqueued');
    return 'sent';
  } catch (err) {
    log.warn({ err, userId: ctx.userId }, 'Out-of-office reply failed');
    return 'error';
  }
}

const defaultDeps: AutoReplyDeps = {
  loadSettings: (userId) => prisma.userSettings.findUnique({
    where: { userId },
    select: {
      oofEnabled: true, oofInternal: true, oofExternal: true, oofExternalEnabled: true,
      oofExternalOnlyContacts: true, oofUseTimeRange: true, oofStart: true, oofEnd: true, oofPeriodId: true,
    },
  }),
  ownAddresses: async (userId, email) => [
    email.toLowerCase(),
    ...(await prisma.emailAlias.findMany({ where: { targetUserId: userId }, select: { address: true } }))
      .map((a) => a.address.toLowerCase()),
  ],
  isLocalDomain: async (domain) => !!(await prisma.domain.findFirst({ where: { name: domain, active: true }, select: { id: true } })),
  isContact: async (userId, sender) => !!(await prisma.contact.findFirst({
    where: { userId, OR: [{ email: { equals: sender, mode: 'insensitive' } }, { email2: { equals: sender, mode: 'insensitive' } }] },
    select: { id: true },
  })),
  acquire: async (key, ttl) => (await getRedisClient().set(key, '1', 'EX', ttl, 'NX')) === 'OK',
  hostname: async () => (await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } }))?.publicHostname ?? 'mail.local',
  displayName: async (userId) => (await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } }))?.displayName || undefined,
  enqueue: async ({ from, to, raw }) => {
    const domainName = from.slice(from.lastIndexOf('@') + 1).toLowerCase();
    const domain = await prisma.domain.findUnique({ where: { name: domainName }, select: { name: true, dkimSelector: true, dkimPrivateKey: true } });
    const { enqueueOutbound } = await import('../outbound/queue.js');
    await enqueueOutbound({
      messageId:  `oof-${randomUUID()}`,
      from:       '',                 // null return path (RFC 3834 §3.3)
      to:         [to],
      ...(domain?.dkimPrivateKey ? { dkimDomain: domain.name, dkimSelector: domain.dkimSelector, dkimPrivateKey: domain.dkimPrivateKey } : {}),
      rawMessage: raw.toString('base64'),
    });
  },
};
