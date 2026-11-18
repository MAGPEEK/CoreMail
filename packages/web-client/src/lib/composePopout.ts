/**
 * 9.4: a draft in a window of its own ("In neuem Fenster öffnen"). The main
 * window saves the draft and opens `/compose/<draftId>`; the window loads the
 * server draft. It talks back to the window that opened it only (postMessage to
 * `window.opener`, never a broadcast — a second webmail tab must not send too):
 *   - `send`     → the main window sends the saved draft with the undo hold
 *   - `returned` → the window was closed without sending: the draft goes back
 *                  into the main window's tab strip
 * Pure — unit-tested with `node --test`.
 */

export const POPOUT_ROUTE = '/compose/:draftId';
export const POPOUT_FEATURES = 'popup,width=980,height=840';
const KIND = 'coremail-compose';

/** Server draft ids are cuids; anything else is refused before it reaches a URL or the API. */
export function isDraftId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

export function popoutUrl(draftId: string): string {
  return `/compose/${encodeURIComponent(draftId)}`;
}

/** Window name per draft tab: opening the same tab again reuses its window. */
export function popoutWindowName(tabKey: string): string {
  return `coremail-compose-${tabKey.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

export type PopoutMessage =
  | { kind: typeof KIND; type: 'send'; draftId: string; requestReceipt: boolean }
  | { kind: typeof KIND; type: 'returned'; draftId: string; subject: string };

export function sendMessage(draftId: string, requestReceipt: boolean): PopoutMessage {
  return { kind: KIND, type: 'send', draftId, requestReceipt };
}

export function returnedMessage(draftId: string, subject: string): PopoutMessage {
  return { kind: KIND, type: 'returned', draftId, subject: subject.slice(0, 500) };
}

/** Validated message from a compose window, or null (anything else on the channel). */
export function parsePopoutMessage(data: unknown): PopoutMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m['kind'] !== KIND || !isDraftId(m['draftId'])) return null;
  if (m['type'] === 'send') return sendMessage(m['draftId'], m['requestReceipt'] === true);
  if (m['type'] === 'returned') return returnedMessage(m['draftId'], typeof m['subject'] === 'string' ? m['subject'] : '');
  return null;
}

/** A message counts only from the own origin and from a window this tab opened. */
export function acceptsMessage(origin: string, ownOrigin: string, fromOwnPopout: boolean): boolean {
  return origin === ownOrigin && fromOwnPopout;
}
