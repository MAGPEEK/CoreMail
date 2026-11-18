import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/auth.js';
import { fetchEventTicket } from '../api/client.js';
import { refreshBranding } from './useBranding.js';
import { openReconnectingEventSource, eventStreamUrl } from '../lib/reconnectingEventSource.js';
import { startTabLeader, type AppMessage, type ChannelLike } from '../lib/tabLeader.js';
import { InvalidationBatch, REALTIME_EVENTS, parseEventData, realtimePlan } from '../lib/realtimeEvents.js';

const CHANNEL_NAME = 'coremail-realtime';

function tabId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The tabs' BroadcastChannel as lib/tabLeader.ts sees it (null when unavailable). */
function openChannel(): ChannelLike | null {
  let bc: BroadcastChannel;
  try {
    if (typeof BroadcastChannel !== 'function') return null;
    bc = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
  let handler: ChannelLike['onmessage'] = null;
  return {
    postMessage: (m) => bc.postMessage(m),
    close: () => bc.close(),
    get onmessage() { return handler; },
    set onmessage(fn) {
      handler = fn;
      bc.onmessage = fn ? (ev: MessageEvent) => fn({ data: ev.data }) : null;
    },
  };
}

/** This tab's part of a logout that happened elsewhere (other tab / session ended). */
function logoutHere(): void {
  useAuthStore.getState().logout();
  if (window.location.pathname !== '/login') window.location.href = '/login';
}

/**
 * 9.4 live updates of the webmail (lib/realtimeEvents.ts says which caches an
 * event makes stale):
 *
 *  - One SSE connection per browser: the open tabs elect a leader
 *    (lib/tabLeader.ts, BroadcastChannel); only the leader holds
 *    GET /api/v1/events and passes every event on to the other tabs. Without
 *    BroadcastChannel each tab connects itself.
 *  - EventSource cannot send Authorization headers: before every (re)connect a
 *    single-use ticket is requested (POST /api/v1/events/ticket) and the stream
 *    is opened with `?ticket=` — the token never goes into a URL.
 *  - Invalidations of a burst are coalesced (one refetch per query).
 *  - A logout in one tab, or the end of the session announced by the server
 *    (`session-ended`), logs out every tab.
 */
export function useRealtime() {
  const loggedIn = useAuthStore((s) => !!s.accessToken);
  const qc = useQueryClient();

  useEffect(() => {
    if (!loggedIn) return;

    const batch = new InvalidationBatch((keys) => {
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
    });
    const apply = (name: string, data: unknown) => {
      const plan = realtimePlan(name, data);
      batch.add(plan.invalidate);
      if (plan.refreshBranding) void refreshBranding(true);
      if (plan.hint && document.visibilityState === 'visible') {
        toast(plan.icon ? `${plan.icon} ${plan.hint}` : plan.hint, { duration: 4000 });
      }
    };

    let remoteLogout = false;
    let closeStream: (() => void) | null = null;
    const handlers: Record<string, (ev: { data?: unknown }) => void> = {};
    for (const name of REALTIME_EVENTS) {
      handlers[name] = (ev) => {
        const data = parseEventData(ev.data);
        apply(name, data);
        leader.broadcast({ t: 'event', name, data });
      };
    }
    handlers['session-ended'] = logoutHere;

    const onMessage = (m: AppMessage) => {
      if (m.t === 'event' && typeof m['name'] === 'string') apply(m['name'], m['data']);
      else if (m.t === 'logout') { remoteLogout = true; logoutHere(); }
    };
    const leader = startTabLeader({
      id: tabId(),
      channel: openChannel(),
      onMessage,
      onLeaderChange: (isLeader) => {
        closeStream?.();
        closeStream = isLeader
          ? openReconnectingEventSource({
              url: async () => {
                const ticket = await fetchEventTicket();
                return ticket ? eventStreamUrl(ticket) : null;
              },
              handlers,
            })
          : null;
      },
    });

    // A logout of this tab (button, expired session, session-ended) reaches the others
    // before this effect is torn down — zustand notifies synchronously.
    const unsubscribe = useAuthStore.subscribe((s, prev) => {
      if (prev.accessToken && !s.accessToken && !remoteLogout) leader.broadcast({ t: 'logout' });
    });
    // a page kept in the back/forward cache keeps its place (it resumes its heartbeats)
    const onUnload = (e: PageTransitionEvent) => { if (!e.persisted) leader.stop(); };
    window.addEventListener('pagehide', onUnload);

    return () => {
      window.removeEventListener('pagehide', onUnload);
      unsubscribe();
      leader.stop();
      closeStream?.();
      batch.dispose();
    };
  }, [loggedIn, qc]);
}
