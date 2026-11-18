/**
 * 9.4: rules of the compose area — which fields show, attachment and inline
 * image limits, the schedule presets, the ribbon in plain-text format, the save
 * status line, where focus goes. Pure — unit-tested with `node --test`.
 */
import { rasterImageType } from './imageTypes.ts';
import { isReplyMode, type ComposeMode } from './composeQuote.ts';
import type { SaveStatus } from './draft-autosave.ts';

// ── Fields ──────────────────────────────────────────────────────────────────

export interface FieldVisibilityInput {
  /** Sender options of the compose mailbox (own address, send as, on behalf). */
  senderCount: number;
  showCc: boolean;
  showBcc: boolean;
  ccCount: number;
  bccCount: number;
}

export interface FieldVisibility {
  from: boolean;
  cc: boolean;
  bcc: boolean;
  /** "Cc" / "Bcc" buttons right of the An row (only while the row is hidden). */
  ccToggle: boolean;
  bccToggle: boolean;
}

/** Von only with a choice; Cc / Bcc when asked for or filled (Bcc hidden by default). */
export function composeFieldVisibility(i: FieldVisibilityInput): FieldVisibility {
  const cc = i.showCc || i.ccCount > 0;
  const bcc = i.showBcc || i.bccCount > 0;
  return { from: i.senderCount > 1, cc, bcc, ccToggle: !cc, bccToggle: !bcc };
}

/** Where the cursor goes when a compose opens: An while it is empty (new mail, forward), else the body. */
export function initialFocus(mode: ComposeMode | undefined, toCount: number): 'to' | 'body' {
  if (isReplyMode(mode)) return 'body';
  return toCount === 0 ? 'to' : 'body';
}

// ── Attachments ─────────────────────────────────────────────────────────────

/** Files per mail (api-gateway lib/send-limits.ts MAX_SEND_FILES). */
export const MAX_ATTACHMENTS = 10;

/** Adds files up to the limit; `rejected` = how many did not fit. */
export function addAttachments<T>(current: readonly T[], files: readonly T[], max = MAX_ATTACHMENTS): { list: T[]; rejected: number } {
  const room = Math.max(0, max - current.length);
  return { list: [...current, ...files.slice(0, room)], rejected: Math.max(0, files.length - room) };
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.max(0, Math.round(bytes))} B`;
}

/** Inline images become data: URLs in the body — kept small (same limit as signature images). */
export const MAX_INLINE_IMAGE_BYTES = 500 * 1024;

/** Why a file cannot be inserted as an inline image (raster images only: no SVG), or null. */
export function inlineImageProblem(file: { type: string; size: number }): 'type' | 'size' | null {
  if (!rasterImageType(file.type)) return 'type';
  if (file.size > MAX_INLINE_IMAGE_BYTES) return 'size';
  return null;
}

/** A drag carries files (not text or a mail from the list). */
export function dragHasFiles(types: readonly string[] | null | undefined): boolean {
  return !!types && Array.from(types).includes('Files');
}

// ── Schedule send ───────────────────────────────────────────────────────────

export type SchedulePresetId = 'tomorrowMorning' | 'tomorrowAfternoon' | 'nextMonday';
export interface SchedulePreset { id: SchedulePresetId; date: Date }

/** Tomorrow 8:00, tomorrow 13:00, next Monday 8:00 (local time). */
export function schedulePresets(now: Date): SchedulePreset[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(now.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const toMonday = (1 - now.getDay() + 7) % 7 || 7;
  return [
    { id: 'tomorrowMorning', date: at(1, 8) },
    { id: 'tomorrowAfternoon', date: at(1, 13) },
    { id: 'nextMonday', date: at(toMonday, 8) },
  ];
}

/** The server needs the scheduled time at least 30 s ahead. */
export const MIN_SCHEDULE_LEAD_MS = 30_000;

/** Start value of the date/time field: in an hour, on the full hour. */
export function defaultCustomSchedule(now: Date): Date {
  const d = new Date(now);
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
}

/** Problem of a chosen time (datetime-local value, local wall time), or null. */
export function scheduleProblem(value: string, now: Date): 'invalid' | 'tooSoon' | null {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) return 'invalid';
  if (d.getTime() < now.getTime() + MIN_SCHEDULE_LEAD_MS) return 'tooSoon';
  return null;
}

// ── Ribbon ──────────────────────────────────────────────────────────────────

export type RibbonTabId = 'message' | 'insert' | 'format';
export type InsertCommandId = 'file' | 'image' | 'link' | 'emoji' | 'signature' | 'datetime' | 'rule';

/** Plain-text format has nothing to format: only Einfügen remains. */
export function ribbonTabs(plain: boolean): RibbonTabId[] {
  return plain ? ['insert'] : ['message', 'insert', 'format'];
}

/** Einfügen commands; images, links and lines need HTML. */
export function insertCommands(plain: boolean, hasSignatures: boolean): InsertCommandId[] {
  const all: InsertCommandId[] = plain
    ? ['file', 'emoji', 'signature', 'datetime']
    : ['file', 'image', 'link', 'emoji', 'signature', 'datetime', 'rule'];
  return hasSignatures ? all : all.filter((c) => c !== 'signature');
}

/** The tab to show after the format changed (the chosen one if it still exists). */
export function visibleRibbonTab(current: RibbonTabId, plain: boolean): RibbonTabId {
  const tabs = ribbonTabs(plain);
  return tabs.includes(current) ? current : tabs[0]!;
}

// ── Status line / closing ───────────────────────────────────────────────────

export type DraftStatusText =
  | { kind: 'loading' } | { kind: 'saving' } | { kind: 'failed' } | { kind: 'locked' }
  | { kind: 'savedAt'; at: Date } | { kind: 'none' };

/** Text of the status line above the body ("Entwurf gespeichert um 10:15"). */
export function draftStatusText(status: SaveStatus, savedAt: string | undefined, loading: boolean): DraftStatusText {
  if (loading) return { kind: 'loading' };
  if (status === 'saving') return { kind: 'saving' };
  if (status === 'error') return { kind: 'failed' };
  if (status === 'locked') return { kind: 'locked' };
  // idle with a time: a reopened draft or a tab shown again (nothing changed since)
  if (savedAt && (status === 'saved' || status === 'dirty' || status === 'idle')) return { kind: 'savedAt', at: new Date(savedAt) };
  return { kind: 'none' };
}

/** Changes the saver still has to write (dirty, a running save, or a failed one). */
export function hasPendingChanges(status: SaveStatus): boolean {
  return status === 'dirty' || status === 'saving' || status === 'error';
}
