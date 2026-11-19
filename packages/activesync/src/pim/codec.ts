/**
 * Reading a client's airsync:ApplicationData of a PIM item (pure). Children are matched by
 * name (the decoder resolves names per code page), so `Subject` of calendar (4), tasks (9)
 * and notes (23) reads the same way.
 */
import { getChild, type WbxmlElement } from '../wbxml.js';
import { htmlToText } from '../commands/body.js';

/** The ApplicationData as a lookup of its child elements. */
export interface ItemData {
  /** Element names the client sent. */
  readonly present: ReadonlySet<string>;
  /** Text of a child; undefined when absent. */
  text(name: string): string | undefined;
  child(name: string): WbxmlElement | undefined;
  /** The airsyncbase:Body as text (HTML converted); undefined when absent. */
  body(): BodyInput | undefined;
}

export interface BodyInput {
  text: string;
  /** The HTML the client sent (Type 2), else ''. */
  html: string;
}

export function itemData(appData: WbxmlElement): ItemData {
  const children = (appData.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string');
  const present = new Set(children.map((c) => c.name));
  const child = (name: string) => children.find((c) => c.name === name);
  return {
    present,
    child,
    text: (name) => { const c = child(name); return c ? c.text ?? '' : undefined; },
    body: () => readBody(child('Body')),
  };
}

/** airsyncbase:Body (Type + Data) → text; a Type 2 body is converted (and kept as HTML). */
export function readBody(body: WbxmlElement | undefined): BodyInput | undefined {
  if (!body) return undefined;
  const data = getChild(body, 'Data')?.text ?? body.text ?? '';
  const type = getChild(body, 'Type')?.text ?? '1';
  return type === '2' ? { text: htmlToText(data), html: data } : { text: data.replace(/\r\n/g, '\n'), html: '' };
}

/**
 * Should an element missing from a client Change be cleared? Yes, unless the client
 * ghosts it ([MS-ASCMD] 2.2.3.172 Supported: elements it did not list keep their value).
 */
export function clears(supported: ReadonlySet<string> | null, name: string): boolean {
  return supported === null || supported.has(name);
}

/**
 * The body text to store for a client change: the stored one when the client sent back the
 * truncated copy it got (a strict prefix of a stored body longer than `truncatedAt` bytes).
 */
export function changedBody(stored: string, incoming: string, truncatedAt: number | undefined): string {
  const truncatedCopy = truncatedAt !== undefined && Buffer.byteLength(stored, 'utf8') > truncatedAt
    && incoming.length < stored.length && stored.startsWith(incoming);
  return truncatedCopy ? stored : incoming;
}

/** Integer text inside [min, max]; undefined otherwise. */
export function intIn(s: string | undefined, min: number, max: number): number | undefined {
  if (s === undefined || !/^-?\d{1,10}$/.test(s.trim())) return undefined;
  const n = Number(s.trim());
  return n >= min && n <= max ? n : undefined;
}
