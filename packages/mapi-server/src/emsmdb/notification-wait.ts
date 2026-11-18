/**
 * NotificationWait (MS-OXCMAPIHTTP 2.2.4.4, 3.2.5.5): the response is held
 * until an event is pending for the session or the 5-minute notification
 * timer expires; the session stays alive meanwhile. Events are queued on the
 * session (MapiSession.notifications) by the change bus (notify/bus.ts); the
 * client then fetches them with an Execute, whose response carries them as
 * RopNotify.
 */
import type { MapiSession } from '../session/session.js';

export const NOTIFICATION_WAIT_MS = 5 * 60_000;

export interface NotificationSource {
  /** Resolves true when an event is pending, false when the wait ended without one. */
  wait(session: MapiSession, signal: AbortSignal): Promise<boolean>;
}

/**
 * Waits for the session's notification queue: true at once when something is
 * queued, else when something arrives; false when the timer expires, the
 * session ends or the signal fires (client gone, session ended).
 */
export function queueNotificationSource(waitMs = NOTIFICATION_WAIT_MS): NotificationSource {
  return {
    wait(session, signal) {
      if (session.notifications.pending) return Promise.resolve(true);
      if (signal.aborted || session.closed) return Promise.resolve(false);
      return new Promise((resolve) => {
        const finish = (pending: boolean): void => {
          clearTimeout(timer);
          cancel();
          signal.removeEventListener('abort', onAbort);
          resolve(pending);
        };
        const onAbort = (): void => finish(false);
        const cancel = session.notifications.onPending(() => finish(true));
        const timer = setTimeout(() => finish(false), waitMs);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
