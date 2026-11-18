/**
 * 9.4: a draft in a window of its own ("In neuem Fenster öffnen"). The main
 * window saves the draft and opens `/compose/<draftId>`; the window loads the
 * server draft. Two channels, both same-origin only:
 *
 * postMessage between the window and the window that opened it (never a
 * broadcast — a second webmail tab must not send too):
 *   - `send`     → the main window sends the saved draft with the undo hold
 *                  and answers `accepted`; without an answer in time the
 *                  window sends itself (the main window may have been reloaded)
 *   - `returned` → the window was closed without sending: the draft goes back
 *                  into the main window's tab strip
 *
 * BroadcastChannel presence: before a draft is opened inline, the webmail asks
 * whether a compose window holds it (`presence?` with the draft's ids — a save
 * gives the draft a new id, so a window answers for every id it had); a window
 * that holds it answers and comes to the front, the inline compose is not
 * opened. No answer within PRESENCE_TIMEOUT_MS → inline as usual.
 *
 * Pure — unit-tested with `node --test`.
 */

export const POPOUT_ROUTE = '/compose/:draftId';
export const POPOUT_FEATURES = 'popup,width=980,height=840';
export const PRESENCE_CHANNEL = 'coremail-compose-presence';
export const PRESENCE_TIMEOUT_MS = 300;
/** How long a compose window waits for the main window to take over a send. */
export const HANDOFF_ACK_MS = 1500;
const KIND = 'coremail-compose';
const MAX_IDS = 50;

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

export interface SendFlags { requestReceipt: boolean; requestDeliveryReceipt: boolean }

export type PopoutMessage =
  | { kind: typeof KIND; type: 'send'; draftId: string } & SendFlags
  | { kind: typeof KIND; type: 'accepted'; draftId: string }
  | { kind: typeof KIND; type: 'returned'; draftId: string; subject: string };

export function sendMessage(draftId: string, flags: SendFlags): PopoutMessage {
  return { kind: KIND, type: 'send', draftId, requestReceipt: flags.requestReceipt, requestDeliveryReceipt: flags.requestDeliveryReceipt };
}

export function acceptedMessage(draftId: string): PopoutMessage {
  return { kind: KIND, type: 'accepted', draftId };
}

export function returnedMessage(draftId: string, subject: string): PopoutMessage {
  return { kind: KIND, type: 'returned', draftId, subject: subject.slice(0, 500) };
}

/** Validated message between a compose window and its main window, or null (anything else). */
export function parsePopoutMessage(data: unknown): PopoutMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m['kind'] !== KIND || !isDraftId(m['draftId'])) return null;
  if (m['type'] === 'send') {
    return sendMessage(m['draftId'], { requestReceipt: m['requestReceipt'] === true, requestDeliveryReceipt: m['requestDeliveryReceipt'] === true });
  }
  if (m['type'] === 'accepted') return acceptedMessage(m['draftId']);
  if (m['type'] === 'returned') return returnedMessage(m['draftId'], typeof m['subject'] === 'string' ? m['subject'] : '');
  return null;
}

/**
 * A message counts only from the own origin and from a window this window
 * opened (tracked, or — after a reload of the main window — whose opener it is).
 */
export function acceptsMessage(origin: string, ownOrigin: string, fromOwnPopout: boolean): boolean {
  return origin === ownOrigin && fromOwnPopout;
}

// ── Presence (BroadcastChannel) ─────────────────────────────────────────────

export type PresenceMessage =
  | { kind: typeof KIND; type: 'presence?'; nonce: string; draftIds: string[] }
  | { kind: typeof KIND; type: 'presence!'; nonce: string };

/** The known ids of a draft (current + older versions), validated and de-duplicated. */
export function draftIdSet(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter(isDraftId))].slice(0, MAX_IDS);
}

export function presenceQuery(nonce: string, draftIds: ReadonlyArray<string | null | undefined>): PresenceMessage {
  return { kind: KIND, type: 'presence?', nonce, draftIds: draftIdSet(draftIds) };
}

export function presenceReply(nonce: string): PresenceMessage {
  return { kind: KIND, type: 'presence!', nonce };
}

const isNonce = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);

export function parsePresenceMessage(data: unknown): PresenceMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m['kind'] !== KIND || !isNonce(m['nonce'])) return null;
  if (m['type'] === 'presence!') return presenceReply(m['nonce']);
  if (m['type'] === 'presence?' && Array.isArray(m['draftIds'])) {
    const ids = draftIdSet(m['draftIds'] as string[]);
    return ids.length ? presenceQuery(m['nonce'], ids) : null;
  }
  return null;
}

/** A compose window answers a query when it holds any of the asked ids. */
export function holdsDraft(query: PresenceMessage, heldIds: ReadonlySet<string>): boolean {
  return query.type === 'presence?' && query.draftIds.some((id) => heldIds.has(id));
}
