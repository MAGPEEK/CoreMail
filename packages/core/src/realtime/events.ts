/**
 * Realtime change events (9.4) — the one vocabulary every writer publishes and
 * every live consumer (webmail SSE, IMAP IDLE, JMAP push) reads.
 *
 * Two channels, nothing else:
 *
 *   mailbox:changes   MailboxChangeEvent — messages, flags, counts or the folder
 *                     list of ONE mailbox changed. Published by the message store
 *                     after the transaction committed (every message writer goes
 *                     through it) and by folder writers. Consumers resolve who can
 *                     see the mailbox (owner, shared-mailbox members, delegates).
 *   user:<id>:events  UserEvent — calendar (incl. shares), tasks, contacts,
 *                     notes, settings or quota of one user changed. Reminders
 *                     are task/event fields and travel as tasks/calendar events.
 *
 * New-mail notifications (sender/subject for toasts and Web Push) stay on
 * `mail:new` (SMTP delivery). Pure module: no I/O, unit-tested.
 */

/** Channel of {@link MailboxChangeEvent}s. */
export const CHANNEL_MAILBOX_CHANGES = 'mailbox:changes';

/** Pattern matching every per-user channel. */
export const USER_EVENTS_PATTERN = 'user:*:events';

const USER_CHANNEL_RE = /^user:([^:\s]{1,128}):events$/;
const ID_RE = /^[^\s:]{1,128}$/;

/** Per-user channel of {@link UserEvent}s. */
export function userEventsChannel(userId: string): string {
  if (!ID_RE.test(userId)) throw new RangeError('userEventsChannel: invalid user id');
  return `user:${userId}:events`;
}

/** User id of a per-user channel, or null for any other channel. */
export function userIdOfChannel(channel: string): string | null {
  return USER_CHANNEL_RE.exec(channel)?.[1] ?? null;
}

// ── Mailbox changes ─────────────────────────────────────────────────────────

/**
 * What changed in a mailbox:
 *  - messages  messages were added, removed, moved or their metadata changed
 *              (folder counts and quota follow)
 *  - flags     only flags changed (folder unread counts follow)
 *  - folders   the folder list changed (create, rename, delete, subscribe)
 */
export type MailboxChangeKind = 'messages' | 'flags' | 'folders';
const MAILBOX_KINDS: readonly MailboxChangeKind[] = ['messages', 'flags', 'folders'];

export interface MailboxChangeEvent {
  mailboxId: string;
  kinds: MailboxChangeKind[];
  /** Folders whose content changed; absent = unknown (any folder of the mailbox). */
  folderIds?: string[];
  /** Highest modSeq written (decimal string), when the change allocated one. */
  modSeq?: string;
}

/** Upper bound of folder ids in one event; more → "any folder" (field dropped). */
export const MAX_EVENT_FOLDER_IDS = 50;

function uniqueIds(list: unknown, max: number): string[] | null {
  if (!Array.isArray(list)) return null;
  const out = [...new Set(list.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))];
  return out.length > max ? null : out;
}

/** Validates a mailbox change message; null when malformed. */
export function parseMailboxChange(raw: string): MailboxChangeEvent | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['mailboxId'] !== 'string' || !ID_RE.test(o['mailboxId'])) return null;
  const kinds = Array.isArray(o['kinds'])
    ? MAILBOX_KINDS.filter((k) => (o['kinds'] as unknown[]).includes(k))
    : [];
  if (kinds.length === 0) return null;
  const event: MailboxChangeEvent = { mailboxId: o['mailboxId'], kinds };
  const folderIds = o['folderIds'] === undefined ? null : uniqueIds(o['folderIds'], MAX_EVENT_FOLDER_IDS);
  if (folderIds && folderIds.length > 0) event.folderIds = folderIds;
  if (typeof o['modSeq'] === 'string' && /^\d{1,20}$/.test(o['modSeq'])) event.modSeq = o['modSeq'];
  return event;
}

/**
 * Merges changes of the same mailbox (one event per mailbox and transaction):
 * kinds and folder ids are united, the highest modSeq wins. A side without
 * folder ids means "any folder", so the merge has none either.
 */
export function mergeMailboxChange(a: MailboxChangeEvent, b: MailboxChangeEvent): MailboxChangeEvent {
  if (a.mailboxId !== b.mailboxId) throw new RangeError('mergeMailboxChange: different mailboxes');
  const kinds = MAILBOX_KINDS.filter((k) => a.kinds.includes(k) || b.kinds.includes(k));
  const out: MailboxChangeEvent = { mailboxId: a.mailboxId, kinds };
  if (a.folderIds && b.folderIds) {
    const ids = [...new Set([...a.folderIds, ...b.folderIds])];
    if (ids.length <= MAX_EVENT_FOLDER_IDS) out.folderIds = ids;
  }
  const modSeq = maxModSeq(a.modSeq, b.modSeq);
  if (modSeq !== undefined) out.modSeq = modSeq;
  return out;
}

function maxModSeq(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

// ── User events ─────────────────────────────────────────────────────────────

/** Data area of a user that changed. */
export type UserEventType = 'calendar' | 'tasks' | 'contacts' | 'notes' | 'settings' | 'quota';
export const USER_EVENT_TYPES: readonly UserEventType[] = ['calendar', 'tasks', 'contacts', 'notes', 'settings', 'quota'];

export type UserEventAction = 'create' | 'update' | 'delete';
const ACTIONS: readonly UserEventAction[] = ['create', 'update', 'delete'];

/** Settings areas the webmail caches separately (`settings` events; `policies` = webmail policy, 9.4). */
export type SettingsSection = 'profile' | 'preferences' | 'signature' | 'oof' | 'rules' | 'categories' | 'mailboxes' | 'policies';
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['profile', 'preferences', 'signature', 'oof', 'rules', 'categories', 'mailboxes', 'policies'];

export interface UserEvent {
  type: UserEventType;
  action?: UserEventAction;
  /** Ids of the changed items (event, task, contact …); absent = unknown/many. */
  ids?: string[];
  /** calendar: the calendar(s) concerned; `scope: 'shares'` = a share changed. */
  calendarIds?: string[];
  scope?: 'shares';
  /** settings: which area changed (absent = all). */
  section?: SettingsSection;
}

export const MAX_EVENT_IDS = 50;

/** Validates a user event message; null when malformed. Unknown fields are dropped. */
export function parseUserEvent(raw: string): UserEvent | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!USER_EVENT_TYPES.includes(o['type'] as UserEventType)) return null;
  const event: UserEvent = { type: o['type'] as UserEventType };
  if (ACTIONS.includes(o['action'] as UserEventAction)) event.action = o['action'] as UserEventAction;
  const ids = o['ids'] === undefined ? null : uniqueIds(o['ids'], MAX_EVENT_IDS);
  if (ids && ids.length > 0) event.ids = ids;
  const calendarIds = o['calendarIds'] === undefined ? null : uniqueIds(o['calendarIds'], MAX_EVENT_IDS);
  if (calendarIds && calendarIds.length > 0) event.calendarIds = calendarIds;
  if (o['scope'] === 'shares') event.scope = 'shares';
  if (SETTINGS_SECTIONS.includes(o['section'] as SettingsSection)) event.section = o['section'] as SettingsSection;
  return event;
}

/** Normalises an event for publishing (drops oversized id lists). */
export function normaliseUserEvent(event: UserEvent): UserEvent {
  return parseUserEvent(JSON.stringify(event)) ?? { type: event.type };
}
