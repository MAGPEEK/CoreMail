/**
 * 9.4: the browser side of lib/composePopout.ts — which windows this tab opened,
 * and messages from a compose window to the window that opened it.
 */
import type { PopoutMessage } from '../../lib/composePopout.js';

const popouts = new Set<Window>();

export function trackPopout(win: Window): void {
  popouts.add(win);
}

export function forgetPopout(win: Window): void {
  popouts.delete(win);
}

export function isOwnPopout(source: MessageEventSource | null): source is Window {
  return !!source && popouts.has(source as Window);
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
