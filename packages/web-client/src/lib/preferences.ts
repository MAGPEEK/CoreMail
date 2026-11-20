/**
 * 9.4: roaming webmail preferences — client side of GET/PATCH /user/preferences
 * (server: api-gateway lib/user-preferences.ts, same shape and defaults).
 *
 * The server copy is the source of truth; the browser keeps it as an offline
 * cache. Values the webmail kept in localStorage before 9.4 (view, theme,
 * language) are imported once (`localToPatch`) — afterwards the server wins.
 * No imports — unit-tested with `node --test`.
 */

export type Density = 'compact' | 'normal' | 'comfortable';
export type ReadingPane = 'right' | 'bottom' | 'off';
export type SortField = 'date' | 'from' | 'subject' | 'size';
export type SortDir = 'desc' | 'asc';
export type ConversationOrder = 'newestFirst' | 'oldestFirst';
export type NewMailNotification = 'toast' | 'sound' | 'none';
export type ThemeMode = 'light' | 'dark' | 'system';
export type Language = 'de' | 'en' | 'es' | 'it';
export type DateFormat = 'dd.MM.yyyy' | 'yyyy-MM-dd' | 'MM/dd/yyyy' | 'd. MMM yyyy';
export type TimeFormat = '24h' | '12h';
export type MarkReadMode = 'immediately' | 'delay' | 'manual';
export type ReceiptPolicy = 'never' | 'ask' | 'always';
export type ComposeFormat = 'html' | 'plain';
export type WeekStart = 0 | 1 | 6;

export interface SignatureDefaults { newId: string | null; replyId: string | null }

export interface UserPreferences {
  version: number;
  migratedAt: string | null;
  view: {
    density: Density; readingPane: ReadingPane; groupByConversation: boolean;
    sortBy: SortField; sortDir: SortDir; conversationOrder: ConversationOrder;
    shortcutsEnabled: boolean; shortcutSet: 'coremail' | 'gmail'; sendDelaySec: 0 | 5 | 10 | 20 | 30;
    newMailNotification: NewMailNotification;
  };
  theme: { mode: ThemeMode; accentRgb: string | null };
  regional: { language: Language; timeZone: string; dateFormat: DateFormat; timeFormat: TimeFormat };
  reading: {
    markRead: MarkReadMode; markReadDelaySec: number;
    requestReceipts: ReceiptPolicy; answerReceipts: ReceiptPolicy; emptyTrashOnLogout: boolean;
  };
  compose: { format: ComposeFormat; fontFamily: string; fontSize: string; attachmentReminder: boolean; composeFormatBar: boolean };
  calendar: {
    workDays: number[]; workStart: string; workEnd: string; weekStart: WeekStart;
    defaultReminderMinutes: number | null; slotMinutes: 5 | 10 | 15 | 30 | 60; defaultEventMinutes: number;
    showWeekNumbers: boolean; hiddenCalendarIds: string[];
  };
  signatures: { defaults: Record<string, SignatureDefaults> };
  /** 10.1: webmail background — none | custom | builtin:<id>; null = the organisation default (lib/backgroundPrefs.ts) */
  appearance: { background: string | null };
  /** 10.1: the ribbon above the mail view */
  ribbon: { collapsed: boolean };
  /** 10.1: favourite folders of the own mailbox — folder ids or default-folder names (lib/folderLists.ts) */
  folders: { favorites: string[] };
}

export type SectionName = Exclude<keyof UserPreferences, 'version' | 'migratedAt'>;
export type PreferencesPatch = { [S in SectionName]?: Partial<UserPreferences[S]> };

export const SECTIONS: readonly SectionName[] = ['view', 'theme', 'regional', 'reading', 'compose', 'calendar', 'signatures', 'appearance', 'ribbon', 'folders'];

export const DEFAULT_PREFERENCES: UserPreferences = {
  version: 1,
  migratedAt: null,
  view: {
    density: 'normal', readingPane: 'right', groupByConversation: false,
    sortBy: 'date', sortDir: 'desc', conversationOrder: 'newestFirst',
    shortcutsEnabled: true, shortcutSet: 'coremail', sendDelaySec: 10, newMailNotification: 'toast',
  },
  theme: { mode: 'system', accentRgb: null },
  regional: { language: 'de', timeZone: '', dateFormat: 'dd.MM.yyyy', timeFormat: '24h' },
  reading: {
    markRead: 'immediately', markReadDelaySec: 5,
    requestReceipts: 'never', answerReceipts: 'ask', emptyTrashOnLogout: false,
  },
  compose: { format: 'html', fontFamily: '', fontSize: '', attachmentReminder: true, composeFormatBar: true },
  calendar: {
    workDays: [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '17:00', weekStart: 1,
    defaultReminderMinutes: 15, slotMinutes: 30, defaultEventMinutes: 30,
    showWeekNumbers: true, hiddenCalendarIds: [],
  },
  signatures: { defaults: {} },
  appearance: { background: null },
  ribbon: { collapsed: false },
  folders: { favorites: ['INBOX', 'Sent', 'Drafts', 'Trash'] },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** A value fits a default when both have the same JSON kind (null fits a nullable default). */
function fits(value: unknown, def: unknown): boolean {
  if (value === null) return def === null || typeof def === 'number' || typeof def === 'string';
  if (Array.isArray(def)) return Array.isArray(value);
  if (def === null) return typeof value === 'string' || typeof value === 'number';
  return typeof value === typeof def;
}

/**
 * Server or cached JSON → complete preferences (the server already validated;
 * this only guards against a stale cache or an older server).
 */
export function normalizePreferences(raw: unknown): UserPreferences {
  const out = clone(DEFAULT_PREFERENCES);
  if (!isRecord(raw)) return out;
  out.migratedAt = typeof raw['migratedAt'] === 'string' ? raw['migratedAt'] : null;
  for (const s of SECTIONS) {
    const src = raw[s];
    if (!isRecord(src)) continue;
    const target = out[s] as unknown as Record<string, unknown>;
    for (const [k, def] of Object.entries(target)) {
      if (k in src && fits(src[k], def)) target[k] = clone(src[k]);
    }
  }
  return out;
}

/** Applies a patch like the server: fields replace, signature defaults merge per identity. */
export function applyPatch(prefs: UserPreferences, patch: PreferencesPatch): UserPreferences {
  const next = clone(prefs);
  for (const s of SECTIONS) {
    const sp = patch[s] as Record<string, unknown> | undefined;
    if (!sp) continue;
    const target = next[s] as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(sp)) {
      if (v === undefined) continue;
      if (s === 'signatures' && k === 'defaults') {
        const merged = { ...next.signatures.defaults, ...(v as Record<string, SignatureDefaults>) };
        for (const [id, d] of Object.entries(merged)) if (!d.newId && !d.replyId) delete merged[id];
        next.signatures.defaults = merged;
      } else {
        target[k] = clone(v);
      }
    }
  }
  return next;
}

/** Combines two pending patches (later fields win; signature defaults merge). */
export function mergePatches(a: PreferencesPatch, b: PreferencesPatch): PreferencesPatch {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of SECTIONS) {
    const pa = a[s] as Record<string, unknown> | undefined;
    const pb = b[s] as Record<string, unknown> | undefined;
    if (!pa && !pb) continue;
    const merged = { ...(pa ?? {}), ...(pb ?? {}) };
    if (s === 'signatures' && pa?.['defaults'] && pb?.['defaults']) {
      merged['defaults'] = { ...(pa['defaults'] as object), ...(pb['defaults'] as object) };
    }
    out[s] = merged;
  }
  return out as PreferencesPatch;
}

export function isEmptyPatch(p: PreferencesPatch): boolean {
  return SECTIONS.every((s) => !p[s] || Object.keys(p[s] as object).length === 0);
}

// ── Bridge to the pre-9.4 stores (store/ui.ts, store/language.ts) ──────────────

/** Roaming values that the older stores still hold for their many readers. */
export interface BridgedValues {
  density: Density;
  readingPane: ReadingPane;
  groupByConversation: boolean;
  shortcutsEnabled: boolean;
  shortcutSet: 'coremail' | 'gmail';
  sendDelaySec: 0 | 5 | 10 | 20 | 30;
  calendarShowWeekNumbers: boolean;
  hiddenCalendarIds: string[];
  theme: ThemeMode;
  accentRgb: string | null;
  lang: Language;
}

export function bridgedFromPrefs(p: UserPreferences): BridgedValues {
  return {
    density: p.view.density,
    readingPane: p.view.readingPane,
    groupByConversation: p.view.groupByConversation,
    shortcutsEnabled: p.view.shortcutsEnabled,
    shortcutSet: p.view.shortcutSet,
    sendDelaySec: p.view.sendDelaySec,
    calendarShowWeekNumbers: p.calendar.showWeekNumbers,
    hiddenCalendarIds: [...p.calendar.hiddenCalendarIds],
    theme: p.theme.mode,
    accentRgb: p.theme.accentRgb,
    lang: p.regional.language,
  };
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Patch for the bridged values that changed between two snapshots. */
export function bridgedDiff(prev: BridgedValues, next: BridgedValues): PreferencesPatch {
  const changed = <K extends keyof BridgedValues>(k: K): BridgedValues[K] | undefined =>
    (sameValue(prev[k], next[k]) ? undefined : next[k]);
  const patch: PreferencesPatch = {
    view: defined({
      density: changed('density'),
      readingPane: changed('readingPane'),
      groupByConversation: changed('groupByConversation'),
      shortcutsEnabled: changed('shortcutsEnabled'),
      shortcutSet: changed('shortcutSet'),
      sendDelaySec: changed('sendDelaySec'),
    }),
    calendar: defined({ showWeekNumbers: changed('calendarShowWeekNumbers'), hiddenCalendarIds: changed('hiddenCalendarIds') }),
    theme: defined({ mode: changed('theme'), accentRgb: changed('accentRgb') }),
    regional: defined({ language: changed('lang') }),
  };
  for (const s of SECTIONS) if (patch[s] && Object.keys(patch[s] as object).length === 0) delete patch[s];
  return patch;
}

// ── Pre-9.4 browser values (zustand persist JSON in localStorage) ──────────────

/** `{ state: {...} }` of a zustand persist entry, or {}. */
export function persistedState(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) && isRecord(parsed['state']) ? parsed['state'] : {};
  } catch {
    return {};
  }
}

const pick = <T>(value: unknown, allowed: readonly T[]): T | undefined =>
  (allowed as readonly unknown[]).includes(value) ? (value as T) : undefined;

const RGB = /^(25[0-5]|2[0-4]\d|1?\d?\d) (25[0-5]|2[0-4]\d|1?\d?\d) (25[0-5]|2[0-4]\d|1?\d?\d)$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Patch from the pre-9.4 stores `coremail-ui-prefs`, `coremail-theme`,
 * `coremail-owa-lang` — only values that pass the server's validation.
 */
export function localToPatch(ui: Record<string, unknown>, theme: Record<string, unknown>, lang: Record<string, unknown>): PreferencesPatch {
  const accent = theme['accentRgb'];
  const hiddenRaw = ui['hiddenCalendarIds'];
  const hidden = Array.isArray(hiddenRaw)
    ? hiddenRaw.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 200)
    : undefined;
  const patch: PreferencesPatch = {
    view: defined({
      density: pick<Density>(ui['density'], ['compact', 'normal', 'comfortable']),
      readingPane: pick<ReadingPane>(ui['readingPane'], ['right', 'bottom', 'off']),
      groupByConversation: typeof ui['groupByConversation'] === 'boolean' ? ui['groupByConversation'] : undefined,
      shortcutsEnabled: typeof ui['shortcutsEnabled'] === 'boolean' ? ui['shortcutsEnabled'] : undefined,
      shortcutSet: pick<'coremail' | 'gmail'>(ui['shortcutSet'], ['coremail', 'gmail']),
      sendDelaySec: pick<0 | 5 | 10 | 20 | 30>(ui['sendDelaySec'], [0, 5, 10, 20, 30]),
    }),
    theme: defined({
      mode: pick<ThemeMode>(theme['theme'], ['light', 'dark', 'system']),
      accentRgb: accent === null ? null : typeof accent === 'string' && RGB.test(accent.trim()) ? accent.trim() : undefined,
    }),
    regional: defined({ language: pick<Language>(lang['lang'], ['de', 'en', 'es', 'it']) }),
    calendar: defined({
      showWeekNumbers: typeof ui['calendarShowWeekNumbers'] === 'boolean' ? ui['calendarShowWeekNumbers'] : undefined,
      hiddenCalendarIds: hidden,
    }),
  };
  for (const s of SECTIONS) if (patch[s] && Object.keys(patch[s] as object).length === 0) delete patch[s];
  return patch;
}

/** JWT subject without verifying (only to tell accounts apart in this browser); base64url-safe. */
export function jwtSubject(token: string | null | undefined): string | null {
  try {
    const seg = (token ?? '').split('.')[1] ?? '';
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const sub = (JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}
