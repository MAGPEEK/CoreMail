/**
 * 9.4: roaming webmail preferences (UserSettings.preferences, JSON).
 *
 * One field table drives both schemas:
 *  - reading a stored value is tolerant: every field falls back to its default
 *    when missing or invalid, unknown keys are dropped (older/newer webmails and
 *    hand-edited rows never break a login),
 *  - a PATCH is strict: unknown sections/fields or invalid values → 400.
 *
 * Stored shape: `{ version, migratedAt, <section>: { … } }`. `migratedAt` is set
 * by the first write — afterwards the server copy wins over browser values.
 * Pure module (zod only), unit-tested.
 */
import { z } from 'zod';

export const PREFERENCES_VERSION = 1;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const RGB = /^(25[0-5]|2[0-4]\d|1?\d?\d) (25[0-5]|2[0-4]\d|1?\d?\d) (25[0-5]|2[0-4]\d|1?\d?\d)$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Signature identity: own mailbox or a shared mailbox the user can send from. */
const IDENTITY_KEY = /^(own|shared:[A-Za-z0-9_-]{1,64})$/;
export const MAX_HIDDEN_CALENDARS = 200;
export const MAX_SIGNATURE_IDENTITIES = 50;
export const MAX_FAVORITE_FOLDERS = 50;
/**
 * 10.1: built-in webmail backgrounds (KEEP IN STEP with storage
 * BUILTIN_BACKGROUND_IDS and web-client lib/backgrounds.ts — the test checks both).
 */
export const BUILTIN_BACKGROUNDS = ['lake', 'dawn', 'forest', 'coast', 'dunes', 'waves', 'aurora', 'neutral'] as const;
/** none | custom (the uploaded image) | builtin:<id>; null = the organisation default (branding). */
const BACKGROUND = new RegExp(`^(none|custom|builtin:(${BUILTIN_BACKGROUNDS.join('|')}))$`);
/** Favourite folder: a folder id or the name of a default folder (INBOX, Sent, …). */
const FOLDER_REF = ID;

/** IANA time zone known to this runtime, or '' (= the browser's zone). */
export function isTimeZone(tz: string): boolean {
  if (tz === '') return true;
  if (tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const signatureDefault = z.object({
  newId: z.string().regex(ID).nullable(),
  replyId: z.string().regex(ID).nullable(),
}).strict();

const FIELDS = {
  view: {
    density: z.enum(['compact', 'normal', 'comfortable']),
    readingPane: z.enum(['right', 'bottom', 'off']),
    groupByConversation: z.boolean(),
    sortBy: z.enum(['date', 'from', 'subject', 'size']),
    sortDir: z.enum(['desc', 'asc']),
    conversationOrder: z.enum(['newestFirst', 'oldestFirst']),
    shortcutsEnabled: z.boolean(),
    shortcutSet: z.enum(['coremail', 'gmail']),
    sendDelaySec: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(20), z.literal(30)]),
    newMailNotification: z.enum(['toast', 'sound', 'none']),
  },
  theme: {
    mode: z.enum(['light', 'dark', 'system']),
    accentRgb: z.string().regex(RGB).nullable(),
  },
  regional: {
    language: z.enum(['de', 'en', 'es', 'it']),
    timeZone: z.string().refine(isTimeZone, 'unknown time zone'),
    dateFormat: z.enum(['dd.MM.yyyy', 'yyyy-MM-dd', 'MM/dd/yyyy', 'd. MMM yyyy']),
    timeFormat: z.enum(['24h', '12h']),
  },
  reading: {
    markRead: z.enum(['immediately', 'delay', 'manual']),
    markReadDelaySec: z.number().int().min(1).max(120),
    requestReceipts: z.enum(['never', 'ask', 'always']),
    answerReceipts: z.enum(['never', 'ask', 'always']),
    emptyTrashOnLogout: z.boolean(),
  },
  compose: {
    format: z.enum(['html', 'plain']),
    fontFamily: z.enum(['', 'Arial', 'Calibri', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS']),
    fontSize: z.enum(['', '10px', '12px', '14px', '16px', '18px']),
    attachmentReminder: z.boolean(),
    composeFormatBar: z.boolean(),
  },
  calendar: {
    workDays: z.array(z.number().int().min(0).max(6)).max(7).refine((d) => new Set(d).size === d.length, 'duplicate day'),
    workStart: z.string().regex(HHMM),
    workEnd: z.string().regex(HHMM),
    weekStart: z.union([z.literal(0), z.literal(1), z.literal(6)]),
    defaultReminderMinutes: z.number().int().min(0).max(40320).nullable(),
    slotMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]),
    defaultEventMinutes: z.number().int().min(5).max(1440),
    showWeekNumbers: z.boolean(),
    hiddenCalendarIds: z.array(z.string().regex(ID)).max(MAX_HIDDEN_CALENDARS),
  },
  signatures: {
    defaults: z.record(z.string().regex(IDENTITY_KEY), signatureDefault)
      .refine((r) => Object.keys(r).length <= MAX_SIGNATURE_IDENTITIES, 'too many identities'),
  },
  // 10.1: webmail layout
  appearance: {
    background: z.string().regex(BACKGROUND).nullable(),
  },
  ribbon: {
    collapsed: z.boolean(),
    layout: z.enum(['simplified', 'classic']),
  },
  folders: {
    favorites: z.array(z.string().regex(FOLDER_REF)).max(MAX_FAVORITE_FOLDERS)
      .refine((f) => new Set(f).size === f.length, 'duplicate folder'),
  },
} as const;

type Fields = typeof FIELDS;
export type SectionName = keyof Fields;
export type UserPreferences = {
  version: number;
  migratedAt: string | null;
} & { -readonly [S in SectionName]: { -readonly [F in keyof Fields[S]]: z.infer<Fields[S][F]> } };

export const DEFAULT_PREFERENCES: UserPreferences = Object.freeze({
  version: PREFERENCES_VERSION,
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
  ribbon: { collapsed: false, layout: 'simplified' },
  folders: { favorites: ['INBOX', 'Sent', 'Drafts', 'Trash'] },
}) as UserPreferences;

const SECTIONS = Object.keys(FIELDS) as SectionName[];

function sectionShape(section: SectionName, mode: 'stored' | 'patch'): z.ZodRawShape {
  const defaults = DEFAULT_PREFERENCES[section] as Record<string, unknown>;
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(FIELDS[section]) as [string, z.ZodType][]) {
    shape[name] = mode === 'stored' ? field.catch(() => structuredClone(defaults[name])) : field.optional();
  }
  return shape;
}

const storedSections = Object.fromEntries(
  SECTIONS.map((s) => [s, z.object(sectionShape(s, 'stored')).catch(() => structuredClone(DEFAULT_PREFERENCES[s]))]),
) as unknown as Record<SectionName, z.ZodType>;

/** PATCH body `preferences`: any subset of sections and fields, nothing unknown. */
export type PreferencesPatch = { [S in SectionName]?: Partial<UserPreferences[S]> };
export const PreferencesPatchSchema = z.object(
  Object.fromEntries(SECTIONS.map((s) => [s, z.object(sectionShape(s, 'patch')).strict().optional()])),
).strict() as unknown as z.ZodType<PreferencesPatch>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Stored JSON → complete preferences. Missing/invalid fields get their default;
 * '{}' (never written) yields the defaults with `migratedAt: null`.
 */
export function readPreferences(stored: unknown): UserPreferences {
  const src = isRecord(stored) ? stored : {};
  const out: Record<string, unknown> = {
    version: PREFERENCES_VERSION,
    migratedAt: typeof src['migratedAt'] === 'string' ? src['migratedAt'] : null,
  };
  for (const s of SECTIONS) out[s] = storedSections[s].parse(src[s] ?? {});
  return out as UserPreferences;
}

/**
 * Applies a validated patch: fields replace their stored value; signature
 * defaults merge per identity (an entry with both ids null is removed).
 * Marks the preferences as written (`migratedAt`).
 */
export function applyPreferencesPatch(current: UserPreferences, patch: PreferencesPatch, now: Date = new Date()): UserPreferences {
  const next = structuredClone(current);
  const sections = next as unknown as Record<SectionName, Record<string, unknown>>;
  for (const s of SECTIONS) {
    const sp = patch[s] as Record<string, unknown> | undefined;
    if (!sp) continue;
    for (const [field, value] of Object.entries(sp)) {
      if (value === undefined) continue;
      if (s === 'signatures' && field === 'defaults') {
        const merged = { ...next.signatures.defaults, ...(value as UserPreferences['signatures']['defaults']) };
        for (const [k, v] of Object.entries(merged)) if (!v.newId && !v.replyId) delete merged[k];
        next.signatures.defaults = merged;
      } else {
        sections[s][field] = value;
      }
    }
  }
  next.migratedAt = current.migratedAt ?? now.toISOString();
  return next;
}

/** Ids of signatures referenced as defaults — used to clear them when a signature is deleted. */
export function withoutSignature(prefs: UserPreferences, signatureId: string): PreferencesPatch | null {
  const defaults: Record<string, { newId: string | null; replyId: string | null }> = {};
  for (const [identity, d] of Object.entries(prefs.signatures.defaults)) {
    if (d.newId === signatureId || d.replyId === signatureId) {
      defaults[identity] = { newId: d.newId === signatureId ? null : d.newId, replyId: d.replyId === signatureId ? null : d.replyId };
    }
  }
  return Object.keys(defaults).length > 0 ? { signatures: { defaults } } : null;
}
