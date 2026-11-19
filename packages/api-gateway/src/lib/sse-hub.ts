/**
 * Process-wide fan-out of Redis pub/sub events to SSE connections and Web Push.
 *
 * One subscriber per api-gateway process. Routing rules:
 *  - mailbox:changes   (9.4) → `mailbox` to every user who sees the mailbox (owner,
 *                      Shared Mailbox members, delegates — storage mailboxAudience),
 *                      tagged with that user's webmail mailbox key, so the client
 *                      refreshes exactly that folder list / message lists / quota
 *  - user:<id>:events  (9.4) → one typed event (`calendar`, `tasks`, `contacts`,
 *                      `notes`, `settings`, `quota`) to the connections of <id>
 *  - mail:new          → `mail:new` (toast) to the owner; Web Push once per
 *                      (user, message) — independent of open tabs and, via a Redis
 *                      SET NX claim, of the number of api-gateway instances
 *  - settings:reload   type `branding` → `branding` to every connection
 *  - admin:attack      → admin connections only
 *  - 9.4: every user-routed event and the Web Push only while Webmail is on for
 *    that user — an admin account keeps its stream for the BCP, but no mailbox
 *    content reaches it. Unreadable switch → not delivered (fails closed).
 *  Events without an owner are never broadcast.
 */
import { createHash } from 'node:crypto';
import {
  getRedisClient,
  CHANNEL_MAIL_NEW,
  CHANNEL_ADMIN_ATTACK,
  CHANNEL_SETTINGS_RELOAD,
  CHANNEL_MAILBOX_CHANGES,
  USER_EVENTS_PATTERN,
  parseMailboxChange,
  parseUserEvent,
  userIdOfChannel,
  onAuthInvalidation,
  createLogger,
} from '@coremail/core';
import type { AudienceMember } from '@coremail/storage';

const log = createLogger('api:sse-hub');

const PUSH_CLAIM_TTL_SEC = 3600;
const AUDIENCE_TTL_MS = 30_000;

export interface SseConnection {
  userId: string;
  isAdmin: boolean;
  send(event: string, data: unknown): void;
}

export interface SseHubDeps {
  /** Web Push for a new mail (fire-and-forget by the hub). */
  pushMailNew(userId: string, payload: Record<string, unknown>): Promise<void>;
  /** Cluster-wide "send once" claim; true when this process should push. */
  claimPush(key: string): Promise<boolean>;
  /** 9.4: may the user's mailbox events reach their sessions and devices (Webmail switch)? */
  webmailAllowed(userId: string): Promise<boolean>;
  /** 9.4: who sees a mailbox (owner, shared-mailbox members, delegates). */
  mailboxAudience(mailboxId: string): Promise<AudienceMember[]>;
}

/** Payload of the SSE `mailbox` event (webmail lib/realtimeEvents.ts). */
export interface MailboxSsePayload {
  mailbox: string;
  kinds: string[];
  folderIds?: string[];
  sharedMailboxId?: string;
}

/**
 * Pure (w3): the folder ids of a mailbox change a member may hear about. A
 * member limited to some folders (folder permissions) gets only those — a
 * change without folder ids becomes one about the member's folders; undefined
 * = no limit (forward as published).
 */
export function visibleFolderIds(changed: string[] | undefined, allowed: string[] | undefined): string[] | undefined {
  if (!allowed) return changed;
  if (!changed) return allowed;
  const set = new Set(allowed);
  return changed.filter((id) => set.has(id));
}

export class SseHub {
  private readonly byUser = new Map<string, Set<SseConnection>>();
  private readonly admins = new Set<SseConnection>();

  constructor(private readonly deps: SseHubDeps) {}

  add(conn: SseConnection): () => void {
    let set = this.byUser.get(conn.userId);
    if (!set) { set = new Set(); this.byUser.set(conn.userId, set); }
    set.add(conn);
    if (conn.isAdmin) this.admins.add(conn);
    return () => {
      const s = this.byUser.get(conn.userId);
      s?.delete(conn);
      if (s && s.size === 0) this.byUser.delete(conn.userId);
      this.admins.delete(conn);
    };
  }

  get connectionCount(): number {
    let n = 0;
    for (const s of this.byUser.values()) n += s.size;
    return n;
  }

  private static write(c: SseConnection, event: string, data: unknown): void {
    try { c.send(event, data); } catch (err) { log.debug({ err }, 'SSE write failed'); }
  }

  private sendToUser(userId: string, event: string, data: unknown): void {
    for (const c of this.byUser.get(userId) ?? []) SseHub.write(c, event, data);
  }

  private broadcast(event: string, data: unknown): void {
    for (const set of this.byUser.values()) for (const c of set) SseHub.write(c, event, data);
  }

  /** 9.4: the Webmail switch of a user-routed event; an unreadable switch withholds it. */
  private async mayDeliver(userId: string): Promise<boolean> {
    try {
      return await this.deps.webmailAllowed(userId);
    } catch (err) {
      log.warn({ err, userId }, 'Webmail switch not readable — event withheld');
      return false;
    }
  }

  /** Sends a user-routed event when Webmail is on for the user; returns whether it may reach them. */
  private async deliver(userId: string, event: string, data: unknown): Promise<boolean> {
    if (!(await this.mayDeliver(userId))) return false;
    this.sendToUser(userId, event, data);
    return true;
  }

  /** Route one pub/sub message. Returns a promise that settles when a push (if any) was handed off. */
  async dispatch(channel: string, message: string): Promise<void> {
    if (channel === CHANNEL_MAILBOX_CHANGES) return this.dispatchMailboxChange(message);
    const eventUser = userIdOfChannel(channel);
    if (eventUser) return this.dispatchUserEvent(eventUser, message);
    if (channel === CHANNEL_SETTINGS_RELOAD) return this.dispatchSettingsReload(message);

    const payload = parseObject(message);
    if (!payload) { log.warn({ channel }, 'SSE message parse error'); return; }

    if (channel === CHANNEL_ADMIN_ATTACK) {
      for (const c of this.admins) SseHub.write(c, 'security:attack', payload);
      return;
    }
    if (channel === CHANNEL_MAIL_NEW) await this.dispatchMailNew(payload, message);
  }

  private async dispatchMailboxChange(message: string): Promise<void> {
    const change = parseMailboxChange(message);
    if (!change) { log.warn('Malformed mailbox change ignored'); return; }
    if (this.byUser.size === 0) return; // nobody connected to this process
    let audience: AudienceMember[];
    try {
      audience = await this.deps.mailboxAudience(change.mailboxId);
    } catch (err) {
      log.warn({ err, mailboxId: change.mailboxId }, 'Mailbox audience not readable — change withheld');
      return;
    }
    await Promise.all(audience.filter((m) => this.byUser.has(m.userId)).map((m) => {
      const folderIds = visibleFolderIds(change.folderIds, m.folderIds);
      if (folderIds && folderIds.length === 0) return undefined; // only folders the member may not read
      const payload: MailboxSsePayload = {
        mailbox: m.mailboxKey,
        kinds: change.kinds,
        ...(folderIds ? { folderIds } : {}),
        ...(m.sharedMailboxId ? { sharedMailboxId: m.sharedMailboxId } : {}),
      };
      return this.deliver(m.userId, 'mailbox', payload);
    }));
  }

  private async dispatchUserEvent(userId: string, message: string): Promise<void> {
    const event = parseUserEvent(message);
    if (!event) { log.warn('Malformed user event ignored'); return; }
    if (!this.byUser.has(userId)) return;
    await this.deliver(userId, event.type, event);
  }

  private dispatchSettingsReload(message: string): void {
    // Other publishers send plain strings on this channel — only the branding JSON matters here.
    if (parseObject(message)?.['type'] === 'branding') this.broadcast('branding', {});
  }

  private async dispatchMailNew(payload: Record<string, unknown>, message: string): Promise<void> {
    const userId = typeof payload['userId'] === 'string' && payload['userId'] ? payload['userId'] : null;
    if (!userId) return; // never broadcast events without an owner
    if (!(await this.deliver(userId, 'mail:new', payload))) return; // 9.4: no Web Push either
    const ref = typeof payload['messageId'] === 'string' && payload['messageId']
      ? payload['messageId']
      : createHash('sha256').update(message).digest('hex').slice(0, 32);
    try {
      if (await this.deps.claimPush(`push:sent:mail.new:${userId}:${ref}`)) {
        await this.deps.pushMailNew(userId, payload);
      }
    } catch (err) {
      log.warn({ err, userId }, 'Web Push for new mail failed');
    }
  }
}

function parseObject(message: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(message) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Mailbox audience lookups, cached briefly per process (several changes of
 * one mailbox in a burst cost one query). A permission change drops the cache.
 */
export function cachedAudience(
  load: (mailboxId: string) => Promise<AudienceMember[]>,
  ttlMs = AUDIENCE_TTL_MS,
  now: () => number = Date.now,
): { get: (mailboxId: string) => Promise<AudienceMember[]>; clear: () => void } {
  const cache = new Map<string, { at: number; members: Promise<AudienceMember[]> }>();
  return {
    get(mailboxId) {
      const hit = cache.get(mailboxId);
      if (hit && now() - hit.at < ttlMs) return hit.members;
      const members = load(mailboxId);
      cache.set(mailboxId, { at: now(), members });
      members.catch(() => cache.delete(mailboxId));
      return members;
    },
    clear: () => cache.clear(),
  };
}

let hub: SseHub | null = null;
let started: Promise<void> | null = null;

/** The process hub (created on first use). */
export function getSseHub(): SseHub {
  if (!hub) {
    const audience = cachedAudience(async (mailboxId) => {
      const { prisma, mailboxAudience } = await import('@coremail/storage');
      return mailboxAudience(prisma as never, mailboxId);
    });
    onAuthInvalidation((e) => { if (e.reason === 'permission-change' || e.reason === 'deactivated' || e.reason === 'deleted') audience.clear(); });
    hub = new SseHub({
      pushMailNew: async (userId, payload) => {
        const { sendMailNotification } = await import('./push.js');
        await sendMailNotification(userId, payload);
      },
      claimPush: async (key) => (await getRedisClient().set(key, '1', 'EX', PUSH_CLAIM_TTL_SEC, 'NX')) === 'OK',
      webmailAllowed: async (userId) => (await import('@coremail/storage')).isProtocolAllowed(userId, 'webmail'),
      mailboxAudience: audience.get,
    });
  }
  return hub;
}

/** Start the single Redis subscriber (idempotent). Call once at startup. */
export function startSseHub(): Promise<void> {
  if (started) return started;
  started = (async () => {
    const h = getSseHub();
    const sub = getRedisClient().duplicate();
    sub.on('message', (channel: string, message: string) => { void h.dispatch(channel, message); });
    sub.on('pmessage', (_pattern: string, channel: string, message: string) => { void h.dispatch(channel, message); });
    await sub.subscribe(CHANNEL_MAIL_NEW, CHANNEL_MAILBOX_CHANGES, CHANNEL_SETTINGS_RELOAD, CHANNEL_ADMIN_ATTACK);
    await sub.psubscribe(USER_EVENTS_PATTERN);
    log.info('SSE/push hub subscribed');
  })().catch((err: unknown) => {
    started = null;
    log.error({ err }, 'SSE hub subscription failed');
  });
  return started;
}
