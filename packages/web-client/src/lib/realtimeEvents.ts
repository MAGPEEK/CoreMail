/**
 * 9.4: what a live event (GET /api/v1/events, lib/sse-hub.ts in the gateway)
 * means for the webmail — which cached queries are stale, and whether a short
 * hint is shown. Pure; unit-tested with `node --test`.
 *
 * Events:
 *   mailbox    { mailbox: "own"|"shared:<id>"|"delegated:<id>", kinds, folderIds?, sharedMailboxId? }
 *   calendar | tasks | contacts | notes | settings | quota   typed user events
 *   mail:new   new mail (hint only — the `mailbox` event refreshes the lists)
 *   branding   the branding changed (refetched by the branding store)
 */
import { foldersQueryKey, parseMailboxKey } from './mailboxContext.ts';
import { quotaQueryKey } from './quota.ts';
import { recoverableQueryKey } from './recoverable.ts';
import { PHOTO_LOOKUP_KEY } from './photoDirectory.ts';

export type QueryKey = readonly unknown[];

export interface RealtimePlan {
  /** Query key prefixes to invalidate. */
  invalidate: QueryKey[];
  /** Short hint for the user (German UI text), if any, with its leading symbol. */
  hint?: string;
  icon?: string;
  /** Re-read the public branding. */
  refreshBranding?: boolean;
  /** Re-read the roaming preferences (hooks/usePreferencesSync.ts — not a query). */
  refreshPreferences?: boolean;
}

/**
 * Safety refetch of caches that live events keep current (lost events, a
 * dropped connection, a Redis outage). Never shorter than 15 minutes.
 */
export const SAFETY_REFETCH_MS = 15 * 60_000;

/** SSE event names the webmail listens to. */
export const REALTIME_EVENTS = [
  'mailbox', 'mail:new', 'calendar', 'tasks', 'contacts', 'notes', 'settings', 'quota', 'branding',
] as const;
export type RealtimeEventName = typeof REALTIME_EVENTS[number];

/** Same key as hooks/useActiveMailbox.ts ACCESSIBLE_MAILBOXES_KEY (kept import-free here). */
const ACCESSIBLE_MAILBOXES_KEY: QueryKey = ['accessible-mailboxes'];

type Obj = Record<string, unknown>;

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function mailboxPlan(d: Obj): RealtimePlan {
  const ref = parseMailboxKey(typeof d['mailbox'] === 'string' ? d['mailbox'] : null);
  const kinds = strings(d['kinds']);
  const folderIds = strings(d['folderIds']);
  const invalidate: QueryKey[] = [foldersQueryKey(ref)];
  if (kinds.includes('messages') || kinds.includes('flags')) {
    // lists of the changed folders (all lists when unknown) and every search result
    if (folderIds.length) {
      for (const id of folderIds) invalidate.push(['messages', id]);
      invalidate.push(['messages', 'search']);
    } else {
      invalidate.push(['messages']);
    }
    invalidate.push(['message']);
  }
  if (kinds.includes('messages')) {
    const shared = ref.kind === 'shared' ? ref.id : null;
    invalidate.push(quotaQueryKey(shared));
    if (ref.kind === 'own') invalidate.push(['user-storage'], recoverableQueryKey());
  }
  return { invalidate };
}

const SETTINGS_KEYS: Record<string, QueryKey[]> = {
  // 9.5: a new / removed profile photo changes the version the lookups return
  profile: [['user-profile'], ['user', 'profile'], [PHOTO_LOOKUP_KEY]],
  // 10.1: the uploaded webmail background (hooks/useAppBackground.ts) changes with the preferences
  preferences: [['user-preferences'], ['user-background']],
  signature: [['user-signature'], ['user', 'signature'], ['user', 'signatures']],
  oof: [['user-oof']],
  rules: [['rules']],
  categories: [['categories']],
  // w3 review: a grant change can add or take away single folders of a mailbox that stays
  // listed — its folder pane and message lists are re-read too, not after the safety refetch
  mailboxes: [['user-shared-mailboxes'], ACCESSIBLE_MAILBOXES_KEY, ['folders'], ['messages'], ['message']],
  // Settings → Sicherheit (components/settings/SecurityPanels.tsx): sessions list + S/MIME options
  security: [['user-sessions'], ['smime-settings']],
  // 9.4 webmail policies (lib/webmailFeatures.ts FEATURES_QUERY_KEY) + trusted image senders;
  // the open message re-reads its external-image decision
  policies: [['webmail-features'], ['trusted-senders'], ['message']],
};

function settingsPlan(d: Obj): RealtimePlan {
  const section = typeof d['section'] === 'string' ? d['section'] : null;
  const known = section !== null && SETTINGS_KEYS[section] !== undefined;
  const keys = known ? SETTINGS_KEYS[section]! : Object.values(SETTINGS_KEYS).flat();
  // policies: the design (Designs module) comes with the preferences
  const refresh = !known || section === 'preferences' || section === 'policies';
  return { invalidate: [...keys], ...(refresh ? { refreshPreferences: true } : {}) };
}

function calendarPlan(d: Obj): RealtimePlan {
  const invalidate: QueryKey[] = [['calendars'], ['calendar-events'], ['event'], ['calendar-shares']];
  if (d['scope'] !== 'shares') return { invalidate };
  if (d['action'] === 'create') return { invalidate, hint: 'Ein Kalender wurde mit dir geteilt', icon: '🗓️' };
  if (d['action'] === 'delete') return { invalidate, hint: 'Eine Kalender-Freigabe wurde entfernt', icon: '🗓️' };
  return { invalidate };
}

function newMailHint(d: Obj): string {
  const from = [d['fromName'], d['fromAddr']].find((v): v is string => typeof v === 'string' && v.trim() !== '') ?? 'Unbekannt';
  const subject = typeof d['subject'] === 'string' && d['subject'].trim() ? d['subject'] : '(Kein Betreff)';
  return `${from}: ${subject}`;
}

/** The plan for one event; unknown events and malformed data change nothing. */
export function realtimePlan(name: string, data: unknown): RealtimePlan {
  const d: Obj = data && typeof data === 'object' && !Array.isArray(data) ? data as Obj : {};
  switch (name) {
    case 'mailbox': return mailboxPlan(d);
    case 'mail:new': return { invalidate: [], hint: newMailHint(d), icon: '📧' };
    case 'calendar': return calendarPlan(d);
    // tasks with a due date show in the calendar as well
    case 'tasks': return { invalidate: [['tasks'], ['calendar-events']] };
    case 'contacts': return { invalidate: [['contacts']] };
    case 'notes': return { invalidate: [['notes'], ['note-detail']] };
    case 'settings': return settingsPlan(d);
    case 'quota': return { invalidate: [['user-quota'], ['user-storage'], ['shared-mailbox-quota']] };
    case 'branding': return { invalidate: [], refreshBranding: true };
    default: return { invalidate: [] };
  }
}

/** Parses the `data` of an SSE message (JSON); null when unreadable. */
export function parseEventData(raw: unknown): unknown {
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

/**
 * Collects invalidations for a short time and hands them over once (several
 * events of one write — e.g. message store + folder counters — cost one refetch).
 */
export class InvalidationBatch {
  private readonly pending = new Map<string, QueryKey>();
  private timer: unknown = null;
  private readonly flush: (keys: QueryKey[]) => void;
  private readonly delayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(
    flush: (keys: QueryKey[]) => void,
    delayMs = 250,
    setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {
    this.flush = flush;
    this.delayMs = delayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  add(keys: QueryKey[]): void {
    for (const k of keys) this.pending.set(JSON.stringify(k), k);
    if (this.pending.size > 0 && this.timer === null) this.timer = this.setTimer(() => this.run(), this.delayMs);
  }

  private run(): void {
    this.timer = null;
    const keys = [...this.pending.values()];
    this.pending.clear();
    if (keys.length) this.flush(keys);
  }

  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}

/** Settings → Lesen "new-mail notification" (lib/preferences.ts NewMailNotification). */
export type NewMailStyle = 'toast' | 'sound' | 'none';

/**
 * How this tab presents the hint of an event (pure):
 *  - `mail:new` follows the user's new-mail notification setting — `none` shows
 *    nothing, `sound` plays the chime once per browser (in the tab that holds the
 *    live connection), `toast` shows the hint;
 *  - every other hint (calendar shares) is a toast;
 *  - a toast is shown only in a visible tab.
 */
export function hintPresentation(
  name: string,
  plan: RealtimePlan,
  opts: { style: NewMailStyle; visible: boolean; fromStream: boolean },
): 'toast' | 'sound' | null {
  if (!plan.hint) return null;
  const style: NewMailStyle = name === 'mail:new' ? opts.style : 'toast';
  if (style === 'none') return null;
  if (style === 'sound') return opts.fromStream ? 'sound' : null;
  return opts.visible ? 'toast' : null;
}
