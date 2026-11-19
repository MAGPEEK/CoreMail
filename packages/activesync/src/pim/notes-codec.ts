/**
 * Notes class codec ([MS-ASNOTE], EAS 14.0+) — pure. A note is a subject, a plain-text body
 * (the webmail edits notes as text; an HTML body from a device is converted) and its
 * categories (9.5, notes:Categories — the same names the webmail sets, normalised and capped
 * like the REST API does). The note colour stays untouched by device changes.
 */
import { CONTACT_LIMITS, normalizeCategories } from '@coremail/storage/contact-card';
import { pel, CP, type WbxmlElement } from '../wbxml.js';
import { buildTextBody } from '../commands/body.js';
import { formatEasDate } from './dates.js';
import { changedBody, clears, itemData } from './codec.js';
import type { RenderContext, WriteContext } from './types.js';

const N = CP.Notes;
/** Subject of a note without one (the column default). */
export const DEFAULT_NOTE_SUBJECT = 'Notiz';

export interface NoteRow { id: string; subject: string; body: string; categories: string[]; updatedAt: Date }

/** notes:* properties of a stored note, in [MS-ASNOTE] order. */
export function renderNote(n: NoteRow, ctx: RenderContext): WbxmlElement[] {
  return [
    pel(N, 'Subject', n.subject),
    buildTextBody(ctx.bodyPref, { bodyText: n.body, bodyHtml: '' }, ctx.version),
    ...(n.categories.length > 0 ? [pel(N, 'Categories', n.categories.map((c) => pel(N, 'Category', c)))] : []),
    pel(N, 'MessageClass', 'IPM.StickyNote'),
    pel(N, 'LastModifiedDate', formatEasDate(n.updatedAt)),
  ];
}

export interface NoteColumns { subject?: string; body?: string; categories?: string[] }

/** The device's category names as the REST API would store them (trimmed, unique, capped). */
function deviceCategories(list: WbxmlElement): string[] {
  const names = (list.children ?? [])
    .filter((c): c is WbxmlElement => typeof c !== 'string' && c.name === 'Category')
    .map((c) => (c.text ?? '').trim().slice(0, CONTACT_LIMITS.category));
  return normalizeCategories(names).slice(0, CONTACT_LIMITS.categories);
}

/** Columns of a client Add (`stored` null) or Change (absent elements cleared unless ghosted). */
export function noteChange(appData: WbxmlElement, stored: Pick<NoteRow, 'body'> | null, ctx: WriteContext): NoteColumns {
  const d = itemData(appData);
  const clear = (name: string) => stored !== null && !d.present.has(name) && clears(ctx.supported, name);
  const out: NoteColumns = {};
  const subject = d.text('Subject');
  if (subject !== undefined || !stored) out.subject = subject?.trim() || DEFAULT_NOTE_SUBJECT;
  const body = d.body();
  if (body) out.body = changedBody(stored?.body ?? '', body.text, ctx.truncatedAt);
  else if (clear('Body')) out.body = '';
  const categories = d.child('Categories');
  if (categories) out.categories = deviceCategories(categories);
  else if (!stored || clear('Categories')) out.categories = [];
  return out;
}
