/**
 * Contacts class codec ([MS-ASCNTC]; code pages 1 Contacts and 12 Contacts2) — pure.
 * Rendering and reading go through the ActiveSync view of a contact (contacts-view.ts):
 * names, "file as", company / department / job title / office location, nickname,
 * Email1–3Address, the phone and address slots, web page, IM addresses, birthday /
 * anniversary, categories, the notes as airsyncbase:Body and the picture.
 *
 * Dates: Birthday / Anniversary are sent as the local midnight of the date in the user's
 * Settings → Region zone (UTC midnight without one); a date without year (`--MM-DD`) as year
 * 1604. A device date is the UTC date when it is a UTC midnight, the date in the user's zone
 * when it is a local midnight there, else the date of the nearest midnight.
 *
 * Picture: only an inline JPEG / PNG / GIF photo of at most PICTURE_MAX_BYTES is sent; a
 * larger one (or a photo by URL) stays on the server untouched by device changes. A device
 * picture over the bound or not an image is refused (the stored one stays, the device gets it back).
 */
import {
  CONTACT_LIMITS, emptyContactCard, finalizeContactCard, normalizeContactDate, photoMediaType,
} from '@coremail/storage/contact-card';
import { utcToWallClockMs, wallClockToUtcMs } from '@coremail/core/calendar';
import { pel, CP, resolveToken, type WbxmlElement } from '../wbxml.js';
import { buildTextBody } from '../commands/body.js';
import { formatEasDate, parseEasDate } from './dates.js';
import { changedBody, clears, deviceCategories, itemData } from './codec.js';
import {
  LIST_SLOTS, NAME_ELEMENT_NAMES, VIEW_ELEMENTS, buildContact, contactView, differsFromDevice, type ContactItem, type DesiredContact,
} from './contacts-view.js';
import type { RenderContext, WriteContext } from './types.js';

/** Largest photo sent to and accepted from a device (decoded bytes). */
export const PICTURE_MAX_BYTES = 48 * 1024;
/** Year of a date without year ([MS-ASCNTC] dates always carry one). */
const NO_YEAR = '1604';
const DAY_MS = 86_400_000;

/** Elements of code page 12 (Contacts2); every other contact element is on page 1. */
const CONTACTS2 = new Set(['NickName', 'CompanyMainPhone', 'IMAddress', 'IMAddress2', 'IMAddress3']);
const pageOf = (element: string): number => (CONTACTS2.has(element) ? CP.Contacts2 : CP.Contacts);
const DATE_ELEMENTS = new Set(['Birthday', 'Anniversary']);

export const EMPTY_CONTACT: ContactItem = { card: finalizeContactCard(emptyContactCard()), officeLocation: '', picture: '', phoneKinds: [] };

// ─── Values ──────────────────────────────────────────────────────────────────

/** A single-line device value: control characters blanked, trimmed, capped. */
// eslint-disable-next-line no-control-regex
const line = (s: string, max: number): string => s.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);

/** The bare address of `"Name" <address>` (devices send either form). */
export function emailOf(s: string): string {
  const angle = /<([^<>]*)>\s*$/.exec(s);
  return line(angle ? angle[1]! : s, CONTACT_LIMITS.text);
}

/** A card date (`YYYY-MM-DD` / `--MM-DD`) as an [MS-ASDTYPE] DateTime. */
export function formatContactDate(date: string, timeZone: string | null): string {
  const m = /^(\d{4}|--)-?(\d{2})-(\d{2})$/.exec(date);
  if (!m) return '';
  const wall = Date.UTC(Number(m[1] === '--' ? NO_YEAR : m[1]), Number(m[2]) - 1, Number(m[3]));
  return formatEasDate(new Date(timeZone ? wallClockToUtcMs(wall, timeZone) : wall));
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A device DateTime as a card date; undefined when malformed. */
export function parseContactDate(s: string, timeZone: string | null): string | undefined {
  const d = parseEasDate(s);
  if (!d) return undefined;
  const ms = d.getTime();
  const local = timeZone ? utcToWallClockMs(ms, timeZone) : null;
  const day = ms % DAY_MS === 0 ? isoDay(ms)
    : local !== null && local % DAY_MS === 0 ? isoDay(local)
      : isoDay(ms + DAY_MS / 2);
  return normalizeContactDate(day.startsWith(`${NO_YEAR}-`) ? `--${day.slice(5)}` : day);
}

/** Canonical base64 of a device picture; undefined when it is not an image within the bound. */
export function parsePicture(s: string): string | undefined {
  const clean = s.replace(/\s+/g, '');
  if (clean === '') return '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return undefined;
  const data = Buffer.from(clean, 'base64');
  return data.length <= PICTURE_MAX_BYTES && photoMediaType(data) ? data.toString('base64') : undefined;
}

const PHONE_ELEMENTS = new Set(LIST_SLOTS.filter((s) => s.list === 'phones').map((s) => s.element));
const URI_ELEMENTS = new Set(LIST_SLOTS.filter((s) => s.list === 'urls' || s.list === 'ims').map((s) => s.element));
const EMAIL_ELEMENTS = new Set(LIST_SLOTS.filter((s) => s.list === 'emails').map((s) => s.element));
const NAME_ELEMENTS = new Set(NAME_ELEMENT_NAMES);

/** The view value of a device element (undefined = unusable, the stored value stays). */
function parseElement(element: string, text: string, ctx: WriteContext): string | undefined {
  if (DATE_ELEMENTS.has(element)) return parseContactDate(text, ctx.user.timeZone);
  if (element === 'Picture') return parsePicture(text);
  if (EMAIL_ELEMENTS.has(element)) return emailOf(text);
  if (PHONE_ELEMENTS.has(element)) return line(text, CONTACT_LIMITS.phone);
  if (URI_ELEMENTS.has(element)) return line(text, CONTACT_LIMITS.uri);
  if (NAME_ELEMENTS.has(element)) return line(text, CONTACT_LIMITS.namePart);
  return line(text, CONTACT_LIMITS.text);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const tokenOf = (element: string): number => resolveToken(element, pageOf(element))?.[1] ?? 0;
/** Sort key: page 1 by token (Body after Birthday), then page 12. */
const orderOf = (page: number, token: number): number => (page === CP.Contacts2 ? 0x100 : 0) + token;

/** contacts:* / contacts2:* properties of a stored contact (non-empty ones), in token order. */
export function renderContact(item: ContactItem, ctx: RenderContext): WbxmlElement[] {
  const view = contactView(item);
  const out: Array<[number, WbxmlElement]> = [];
  for (const e of VIEW_ELEMENTS) {
    const value = view[e];
    if (!value) continue;
    const text = DATE_ELEMENTS.has(e) ? formatContactDate(value, ctx.user.timeZone) : value;
    if (text) out.push([orderOf(pageOf(e), tokenOf(e)), pel(pageOf(e), e, text)]);
  }
  out.push([orderOf(CP.Contacts, tokenOf('Birthday')) + 0.5, buildTextBody(ctx.bodyPref, { bodyText: item.card.notes, bodyHtml: '' }, ctx.version)]);
  const categories = item.card.categories;
  if (categories.length > 0) {
    out.push([orderOf(CP.Contacts, tokenOf('Categories')), pel(CP.Contacts, 'Categories', categories.map((c) => pel(CP.Contacts, 'Category', c)))]);
  }
  return out.sort((a, b) => a[0] - b[0]).map(([, e]) => e);
}

// ─── Device changes ──────────────────────────────────────────────────────────

/**
 * What the device's ApplicationData asks for. Add (`stored` null): the elements it sent.
 * Change: the stored view with the sent elements replaced; an absent element is cleared
 * unless the device ghosts it (airsync:Supported).
 */
export function desiredContact(appData: WbxmlElement, stored: ContactItem | null, ctx: WriteContext): DesiredContact {
  const d = itemData(appData);
  const base = stored ?? EMPTY_CONTACT;
  const clear = (name: string) => stored !== null && !d.present.has(name) && clears(ctx.supported, name);
  const view = contactView(base);
  let refused = false;
  for (const e of VIEW_ELEMENTS) {
    const text = d.text(e);
    const value = text === undefined ? undefined : parseElement(e, text, ctx);
    if (value !== undefined) view[e] = value;
    else if (text !== undefined) refused = true;
    else if (clear(e)) view[e] = '';
  }
  const categories = d.child('Categories');
  const body = d.body();
  return {
    view,
    refused,
    categories: categories ? deviceCategories(categories) : clear('Categories') ? [] : base.card.categories,
    notes: body ? changedBody(base.card.notes, body.text, ctx.truncatedAt) : clear('Body') ? '' : base.card.notes,
  };
}

/** The contact after a device Add / Change, and whether it differs from what the device sent. */
export function contactChange(appData: WbxmlElement, stored: ContactItem | null, ctx: WriteContext): { item: ContactItem; normalized: boolean } {
  const desired = desiredContact(appData, stored, ctx);
  const item = buildContact(stored ?? EMPTY_CONTACT, desired);
  return { item, normalized: differsFromDevice(item, desired) };
}
