/**
 * 9.4: recipient fields of the compose area as pills (An / Cc / Bcc).
 * A field is the committed entries (pills) plus the text being typed. Entries
 * are kept as typed ("Name <a@b>" or "a@b") — the server parses them the same
 * way. Pure — unit-tested with `node --test`.
 */
import { splitRecipients } from './compose.ts';
import type { ComposeMode } from './composeQuote.ts';

export interface RecipientValue {
  /** Committed recipients (pills), as typed / picked. */
  entries: string[];
  /** Text in the input after the last pill. */
  text: string;
}

export const EMPTY_RECIPIENTS: RecipientValue = Object.freeze({ entries: [], text: '' }) as RecipientValue;

export interface ParsedRecipient {
  name: string;
  address: string;
  valid: boolean;
}

/** Same rule as the server (api-gateway lib/send-limits.ts recipientAddress). */
const ADDR = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}][\p{L}\p{N}-]{0,62}$/u;

export function isValidAddress(address: string): boolean {
  return address.length <= 254 && ADDR.test(address);
}

/** "Name <a@b>", "<a@b>", "a@b" → name + address (+ whether the address is valid). */
export function parseRecipient(raw: string): ParsedRecipient {
  const s = raw.trim();
  const m = /^(.*)<([^<>]+)>$/.exec(s);
  const address = (m ? m[2]! : s).trim();
  const name = m ? m[1]!.trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').trim() : '';
  return { name, address, valid: s.length <= 320 && !/[\r\n\0]/.test(s) && isValidAddress(address) };
}

/** Entry text for a contact: the display name quoted when it contains separators. */
export function formatRecipient(name: string, address: string): string {
  const n = name.trim();
  if (!n || n.toLowerCase() === address.toLowerCase()) return address;
  const quoted = /[",;<>@()[\]\\:]/.test(n) ? `"${n.replace(/["\\]/g, '\\$&')}"` : n;
  return `${quoted} <${address}>`;
}

/** Pill text: the name, else the address. */
export function pillLabel(r: ParsedRecipient): string {
  return r.name || r.address;
}

const addressKey = (entry: string) => parseRecipient(entry).address.toLowerCase();

/** Appends entries, dropping ones whose address is already in the list (case-insensitive). */
export function addEntries(entries: readonly string[], add: readonly string[]): string[] {
  const out = [...entries];
  const seen = new Set(out.map(addressKey));
  for (const e of add) {
    const t = e.trim();
    if (!t) continue;
    const k = addressKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Turns the typed text into pills (split at , ; and line breaks; quoted names stay together). */
export function commitText(v: RecipientValue): RecipientValue {
  if (!v.text.trim()) return v.text ? { entries: v.entries, text: '' } : v;
  return { entries: addEntries(v.entries, splitRecipients(v.text.replace(/\r?\n/g, ','))), text: '' };
}

/** Typing: a separator at the end (or a pasted list) commits what came before it. */
export function typeText(v: RecipientValue, text: string): RecipientValue {
  if (!/[,;\n]/.test(text)) return { entries: v.entries, text };
  const normalized = text.replace(/\r?\n/g, ',');
  // A probe character after the text shows whether it ends with a separator outside quotes
  const probe = splitRecipients(`${normalized}\u0001`);
  if (probe[probe.length - 1] === '\u0001') return { entries: addEntries(v.entries, probe.slice(0, -1)), text: '' };
  const parts = splitRecipients(normalized);
  // An unfinished quoted name ("Doe, J) is still one entry: keep typing
  if (parts.length <= 1) return { entries: v.entries, text };
  return { entries: addEntries(v.entries, parts.slice(0, -1)), text: parts[parts.length - 1]! };
}

/** Keys that turn the typed text into a pill (Tab/Enter only while there is text). */
export function commitsOnKey(key: string, text: string): boolean {
  if (key === ',' || key === ';') return true;
  return (key === 'Enter' || key === 'Tab') && text.trim().length > 0;
}

export function removeEntry(v: RecipientValue, index: number): RecipientValue {
  return { entries: v.entries.filter((_, i) => i !== index), text: v.text };
}

/** Backspace in the empty input removes the last pill. */
export function backspace(v: RecipientValue): { value: RecipientValue; removed: string | null } {
  if (v.text || v.entries.length === 0) return { value: v, removed: null };
  return { value: { entries: v.entries.slice(0, -1), text: '' }, removed: v.entries[v.entries.length - 1]! };
}

/** All recipients of a field incl. the text still being typed. */
export function recipientList(v: RecipientValue): string[] {
  return commitText(v).entries;
}

export function fromList(list: readonly string[]): RecipientValue {
  return { entries: addEntries([], list), text: '' };
}

export interface SendBlockers {
  /** No recipient in An (the server requires one). */
  missingTo: boolean;
  /** Entries whose address is invalid (any field). */
  invalid: string[];
}

export function sendBlockers(fields: { to: RecipientValue; cc: RecipientValue; bcc: RecipientValue }): SendBlockers {
  const lists = [fields.to, fields.cc, fields.bcc].map(recipientList);
  return {
    missingTo: lists[0]!.length === 0,
    invalid: lists.flat().filter((e) => !parseRecipient(e).valid),
  };
}

export interface OriginalAddresses {
  fromAddr: string;
  toAddrs?: readonly string[];
  ccAddrs?: readonly string[];
}

/**
 * Reply all: An = the sender + the original An, Cc = the original Cc — without
 * the user's own addresses (own mailbox, the shared mailbox composed in) and
 * without duplicates. A reply to an own sent mail goes to its recipients.
 */
export function replyAllRecipients(orig: OriginalAddresses, ownAddresses: readonly string[]): { to: string[]; cc: string[] } {
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  const notOwn = (e: string) => !own.has(addressKey(e));
  const from = orig.fromAddr ? [orig.fromAddr] : [];
  const fromIsOwn = from.length > 0 && !notOwn(from[0]!);
  const to = addEntries([], [...(fromIsOwn ? [] : from), ...(orig.toAddrs ?? [])].filter(notOwn));
  const toKeys = new Set(to.map(addressKey));
  const cc = addEntries([], (orig.ccAddrs ?? []).filter((e) => notOwn(e) && !toKeys.has(addressKey(e))));
  return { to, cc };
}

/** Reply: the sender (an own sent mail: its recipients). */
export function replyRecipients(orig: OriginalAddresses, ownAddresses: readonly string[]): string[] {
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  if (orig.fromAddr && own.has(addressKey(orig.fromAddr)) && orig.toAddrs?.length) return addEntries([], orig.toAddrs);
  return orig.fromAddr ? [orig.fromAddr] : [];
}

/** An / Cc a compose starts with: reply, reply all, forward (empty) or a new mail with given recipients. */
export function initialRecipients(
  mode: ComposeMode,
  orig: Partial<OriginalAddresses>,
  ownAddresses: readonly string[],
): { to: string[]; cc: string[] } {
  const src = { fromAddr: orig.fromAddr ?? '', toAddrs: orig.toAddrs ?? [], ccAddrs: orig.ccAddrs ?? [] };
  if (mode === 'reply') return { to: replyRecipients(src, ownAddresses), cc: [] };
  if (mode === 'replyAll') return replyAllRecipients(src, ownAddresses);
  if (mode === 'forward') return { to: [], cc: [] };
  return { to: addEntries([], src.toAddrs), cc: addEntries([], src.ccAddrs) };
}
