/**
 * Process-wide fan-out of Redis pub/sub events to SSE connections and Web Push.
 *
 * Before: every SSE connection opened its own Redis subscriber, Web Push for
 * new mail was sent from inside that per-connection handler — so no push
 * without an open tab, N pushes for N tabs, and events without a `userId`
 * were forwarded to every connected user.
 *
 * Now: one subscriber per api-gateway process. Routing rules:
 *  - mail:new / mail:update → only connections of `payload.userId`;
 *    events without a userId are dropped
 *  - user:<id>:events       → only connections of <id>
 *  - calendar:shares        → connections of every id in affectedUserIds
 *  - admin:attack           → admin connections only
 *  - Web Push for mail:new is sent once per (user, message) — independent of
 *    open tabs and, via a Redis SET NX claim, of the number of api-gateway
 *    instances.
 *  - 9.4: every user-routed event (mail, notifications, calendar shares) and
 *    the Web Push only while Webmail is on for that user — an admin account
 *    keeps its stream for the BCP, but no mailbox content reaches it, and the
 *    browsers of a user whose Webmail was switched off get no more pushes.
 *    Unreadable switch → not delivered (fails closed).
 */
import { createHash } from 'node:crypto';
import {
  getRedisClient,
  CHANNEL_MAIL_NEW,
  CHANNEL_MAIL_UPDATE,
  CHANNEL_ADMIN_ATTACK,
  CHANNEL_CALENDAR_SHARES,
  createLogger,
} from '@coremail/core';

const log = createLogger('api:sse-hub');

export const USER_EVENTS_PATTERN = 'user:*:events';
const USER_EVENTS_RE = /^user:([^:]+):events$/;
const PUSH_CLAIM_TTL_SEC = 3600;

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

  private sendToUser(userId: string, event: string, data: unknown): void {
    for (const c of this.byUser.get(userId) ?? []) {
      try { c.send(event, data); } catch (err) { log.debug({ err }, 'SSE write failed'); }
    }
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
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      payload = parsed as Record<string, unknown>;
    } catch {
      log.warn({ channel }, 'SSE message parse error');
      return;
    }

    if (channel === CHANNEL_ADMIN_ATTACK) {
      for (const c of this.admins) { try { c.send('security:attack', payload); } catch { /* closed */ } }
      return;
    }
    if (channel === CHANNEL_CALENDAR_SHARES) {
      const affected = payload['affectedUserIds'];
      if (Array.isArray(affected)) {
        const ids = [...new Set(affected.filter((x): x is string => typeof x === 'string'))];
        await Promise.all(ids.map((id) => this.deliver(id, 'calendar:shares', payload)));
      }
      return;
    }
    const userChannel = USER_EVENTS_RE.exec(channel);
    if (userChannel) {
      await this.deliver(userChannel[1]!, 'notification', payload);
      return;
    }

    const userId = typeof payload['userId'] === 'string' && payload['userId'] ? payload['userId'] : null;
    if (!userId) return; // never broadcast events without an owner

    if (channel === CHANNEL_MAIL_NEW) {
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
    } else if (channel === CHANNEL_MAIL_UPDATE) {
      await this.deliver(userId, 'mail:update', payload);
    }
  }
}

let hub: SseHub | null = null;
let started: Promise<void> | null = null;

/** The process hub (created on first use). */
export function getSseHub(): SseHub {
  if (!hub) {
    hub = new SseHub({
      pushMailNew: async (userId, payload) => {
        const { sendPushToUser } = await import('./push.js');
        await sendPushToUser(userId, 'mail.new', {
          title: `New message from ${String(payload['fromName'] || payload['fromAddr'] || 'Unknown')}`,
          body: String(payload['subject'] ?? '(No subject)'),
          tag: `mail-${String(payload['messageId'] ?? '')}`,
          url: '/owa/',
        });
      },
      claimPush: async (key) => (await getRedisClient().set(key, '1', 'EX', PUSH_CLAIM_TTL_SEC, 'NX')) === 'OK',
      webmailAllowed: async (userId) => (await import('@coremail/storage')).isProtocolAllowed(userId, 'webmail'),
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
    await sub.subscribe(CHANNEL_MAIL_NEW, CHANNEL_MAIL_UPDATE, CHANNEL_CALENDAR_SHARES, CHANNEL_ADMIN_ATTACK);
    await sub.psubscribe(USER_EVENTS_PATTERN);
    log.info('SSE/push hub subscribed');
  })().catch((err: unknown) => {
    started = null;
    log.error({ err }, 'SSE hub subscription failed');
  });
  return started;
}
