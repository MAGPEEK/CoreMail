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
        for (const id of new Set(affected.filter((x): x is string => typeof x === 'string'))) this.sendToUser(id, 'calendar:shares', payload);
      }
      return;
    }
    const userChannel = USER_EVENTS_RE.exec(channel);
    if (userChannel) {
      this.sendToUser(userChannel[1]!, 'notification', payload);
      return;
    }

    const userId = typeof payload['userId'] === 'string' && payload['userId'] ? payload['userId'] : null;
    if (!userId) return; // never broadcast events without an owner

    if (channel === CHANNEL_MAIL_NEW) {
      this.sendToUser(userId, 'mail:new', payload);
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
      this.sendToUser(userId, 'mail:update', payload);
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
