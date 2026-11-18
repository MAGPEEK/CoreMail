/**
 * NotificationWait (MS-OXCMAPIHTTP 2.2.4.4, 3.2.5.5): the response is held
 * until an event is pending for the session or the 5-minute notification
 * timer expires; the session stays alive meanwhile.
 *
 * Extension point: this package answers when the timer expires or the session
 * ends (EventPending = 0). Event delivery for RopRegisterNotification
 * subscriptions plugs in as another NotificationSource.
 */
import type { MapiSession } from '../session/session.js';

export const NOTIFICATION_WAIT_MS = 5 * 60_000;

export interface NotificationSource {
  /** Resolves true when an event is pending, false when the wait ended without one. */
  wait(session: MapiSession, signal: AbortSignal): Promise<boolean>;
}

/** Waits for the timer, the session's end or the client going away. */
export function timerNotificationSource(waitMs = NOTIFICATION_WAIT_MS, pollMs = 1000): NotificationSource {
  return {
    wait(session, signal) {
      return new Promise((resolve) => {
        const deadline = Date.now() + waitMs;
        const tick = setInterval(() => {
          if (session.closed || signal.aborted || Date.now() >= deadline) {
            clearInterval(tick);
            resolve(false);
          }
        }, Math.min(pollMs, waitMs));
      });
    },
  };
}
