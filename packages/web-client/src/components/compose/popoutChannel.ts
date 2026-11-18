/**
 * 9.4: the browser side of lib/composePopout.ts — which windows this window
 * opened, messages between a compose window and its main window (postMessage,
 * same origin, with an acknowledgement for a handed-off send) and the presence
 * question "is this draft open in a compose window?" (BroadcastChannel).
 */
import {
  HANDOFF_ACK_MS, PRESENCE_CHANNEL, PRESENCE_TIMEOUT_MS, acceptsMessage, holdsDraft, parsePopoutMessage,
  parsePresenceMessage, presenceQuery, presenceReply, type PopoutMessage,
} from '../../lib/composePopout.js';

const popouts = new Set<Window>();

export function trackPopout(win: Window): void {
  popouts.add(win);
}

export function forgetPopout(win: Window): void {
  popouts.delete(win);
}

/** A window this window opened — tracked, or (after a reload here) one whose opener is this window. */
export function isOwnPopout(source: MessageEventSource | null): source is Window {
  if (!source || !('closed' in source)) return false;
  if (popouts.has(source)) return true;
  try {
    return source.opener === window;
  } catch {
    return false;
  }
}

/** The window that opened this compose window is still there. */
export function hasLiveOpener(): boolean {
  const opener = window.opener as Window | null;
  return !!opener && !opener.closed;
}

/** Posts to the opening window only (same origin; nothing happens without one). */
export function postToOpener(msg: PopoutMessage): boolean {
  if (!hasLiveOpener()) return false;
  (window.opener as Window).postMessage(msg, window.location.origin);
  return true;
}

/**
 * Hands a message to the opening window and waits for its `accepted` for this
 * draft; false when there is no opener or no answer within `ms`.
 */
export function postToOpenerAndWait(msg: PopoutMessage, ms = HANDOFF_ACK_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const opener = hasLiveOpener() ? (window.opener as Window) : null;
    if (!opener) { resolve(false); return; }
    const done = (ok: boolean) => { clearTimeout(timer); window.removeEventListener('message', onMessage); resolve(ok); };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== opener || !acceptsMessage(e.origin, window.location.origin, true)) return;
      const reply = parsePopoutMessage(e.data);
      if (reply?.type === 'accepted' && reply.draftId === msg.draftId) done(true);
    };
    const timer = setTimeout(() => done(false), ms);
    window.addEventListener('message', onMessage);
    opener.postMessage(msg, window.location.origin);
  });
}

const newNonce = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

/**
 * Main window: is one of these draft ids open in a compose window? That window
 * comes to the front itself. Resolves false without BroadcastChannel or answer.
 */
export function askDraftWindow(draftIds: ReadonlyArray<string | null | undefined>, ms = PRESENCE_TIMEOUT_MS): Promise<boolean> {
  const query = presenceQuery(newNonce(), draftIds);
  if (typeof BroadcastChannel === 'undefined' || query.type !== 'presence?' || query.draftIds.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(PRESENCE_CHANNEL);
    const done = (found: boolean) => { clearTimeout(timer); channel.close(); resolve(found); };
    channel.onmessage = (e: MessageEvent) => {
      const reply = parsePresenceMessage(e.data);
      if (reply?.type === 'presence!' && reply.nonce === query.nonce) done(true);
    };
    const timer = setTimeout(() => done(false), ms);
    channel.postMessage(query);
  });
}

/** Compose window: answers presence questions for the ids it holds and comes to the front. */
export function serveDraftPresence(heldIds: () => ReadonlySet<string>): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(PRESENCE_CHANNEL);
  channel.onmessage = (e: MessageEvent) => {
    const query = parsePresenceMessage(e.data);
    if (!query || !holdsDraft(query, heldIds())) return;
    channel.postMessage(presenceReply(query.nonce));
    window.focus();
  };
  return () => channel.close();
}
