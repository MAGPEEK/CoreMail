import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/auth.js';
import { fetchEventTicket } from '../api/client.js';
import { refreshBranding } from './useBranding.js';
import { openReconnectingEventSource, eventStreamUrl } from '../lib/reconnectingEventSource.js';
import { startTabLeader, type AppMessage, type ChannelLike } from '../lib/tabLeader.js';
import { InvalidationBatch, REALTIME_EVENTS, hintPresentation, parseEventData, realtimePlan } from '../lib/realtimeEvents.js';
import { playChime } from '../lib/chime.js';
import { currentPreferences } from '../store/preferences.js';
import { refreshPreferencesFromServer } from './usePreferencesSync.js';
import { tabRole } from '../lib/tabRole.js';
import { hintNotification, mailNotification } from '../lib/notifications.js';
import { useNotifications } from '../store/notifications.js';
import { translate } from '../i18n/useT.js';

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
 *  - The election is shared with one-tab-per-browser features (lib/tabRole.ts:
 *    task reminders); their messages travel over the same channel.
 */
export function useRealtime() {
  const loggedIn = useAuthStore((s) => !!s.accessToken);
  const qc = useQueryClient();

  useEffect(() => {
    if (!loggedIn) return;

    const batch = new InvalidationBatch((keys) => {
      for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
    });
    // fromStream: this tab holds the live connection (leader, or no BroadcastChannel)
    const apply = (name: string, data: unknown, fromStream: boolean) => {
      const plan = realtimePlan(name, data);
      batch.add(plan.invalidate);
      if (plan.refreshBranding) void refreshBranding(true);
      if (plan.refreshPreferences) refreshPreferencesFromServer();
      // new-mail notification style (Settings → Lesen): toast, sound or none
      const how = hintPresentation(name, plan, {
        style: currentPreferences().view.newMailNotification,
        visible: document.visibilityState === 'visible',
        fromStream,
      });
      if (how === 'sound') playChime();
      else if (how === 'toast' && plan.hint) {
        toast(plan.icon ? `${plan.icon} ${plan.hint}` : plan.hint, { duration: 4000 });
      }
      // 10.7: the bell panel of the rail lists what arrived this session (every tab keeps its own list)
      const now = Date.now();
      if (name === 'mail:new') {
        const entry = mailNotification(data, now, {
          unknownSender: translate('notifications_unknown_sender'), noSubject: translate('notifications_no_subject'),
        });
        if (entry) useNotifications.getState().add(entry);
      } else if (name === 'calendar' && plan.hint) {
        useNotifications.getState().add(hintNotification('calendar', `${now}`, plan.hint, now, '/calendar'));
      }
    };

    let remoteLogout = false;
    let closeStream: (() => void) | null = null;
    const handlers: Record<string, (ev: { data?: unknown }) => void> = {};
    for (const name of REALTIME_EVENTS) {
      handlers[name] = (ev) => {
        const data = parseEventData(ev.data);
        apply(name, data, true);
        leader.broadcast({ t: 'event', name, data });
      };
    }
    handlers['session-ended'] = logoutHere;

    const onMessage = (m: AppMessage) => {
      if (m.t === 'event' && typeof m['name'] === 'string') apply(m['name'], m['data'], false);
      else if (m.t === 'logout') { remoteLogout = true; logoutHere(); }
      else tabRole.received(m);
    };
    const leader = startTabLeader({
      id: tabId(),
      channel: openChannel(),
      onMessage,
      onLeaderChange: (isLeader) => {
        tabRole.leaderChanged(isLeader);
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

    tabRole.attach(leader);

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
      tabRole.attach(null);
      leader.stop();
      closeStream?.();
      batch.dispose();
    };
  }, [loggedIn, qc]);
}
