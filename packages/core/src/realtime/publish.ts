/**
 * Publishing realtime change events (9.4) — the only way writers announce a
 * change (see events.ts for the vocabulary). Never throws: a Redis failure is
 * logged and the live consumers fall back to their long safety refresh.
 *
 * Redis client and logger are loaded on first publish, so importing this module
 * (e.g. through the message store) does not validate the environment.
 *
 * Transport seam for tests: `globalThis.__realtimeRedis` (a client with
 * `publish`, or null = publish nothing); default the shared Redis client.
 */
import {
  CHANNEL_MAILBOX_CHANGES, normaliseUserEvent, userEventsChannel,
  type MailboxChangeEvent, type UserEvent,
} from './events.js';

export interface RealtimePublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __realtimeRedis: RealtimePublisher | null | undefined;
}

async function publisher(): Promise<RealtimePublisher | null> {
  if (globalThis.__realtimeRedis !== undefined) return globalThis.__realtimeRedis;
  const { getRedisClient } = await import('../redis/index.js');
  return getRedisClient() as unknown as RealtimePublisher;
}

async function warn(obj: Record<string, unknown>, msg: string): Promise<void> {
  const { createLogger } = await import('../logger/index.js');
  createLogger('realtime').warn(obj, msg);
}

async function publishRaw(channel: string, message: string): Promise<void> {
  try {
    const client = await publisher();
    if (client) await client.publish(channel, message);
  } catch (err) {
    await warn({ err, channel }, 'Could not publish a realtime event — clients refresh on their safety interval');
  }
}

/** Announces a mailbox change (messages, flags or folder list). */
export async function publishMailboxChange(event: MailboxChangeEvent): Promise<void> {
  await publishRaw(CHANNEL_MAILBOX_CHANGES, JSON.stringify(event));
}

/** Announces a change of a user's calendar/tasks/contacts/notes/settings/quota to each given user. */
export async function publishUserEvent(userIds: string | Iterable<string>, event: UserEvent): Promise<void> {
  const ids = typeof userIds === 'string' ? [userIds] : [...new Set(userIds)];
  if (ids.length === 0) return;
  const message = JSON.stringify(normaliseUserEvent(event));
  await Promise.all(ids.map(async (id) => {
    let channel: string;
    try { channel = userEventsChannel(id); } catch { await warn({}, 'Realtime event for an invalid user id dropped'); return; }
    await publishRaw(channel, message);
  }));
}
