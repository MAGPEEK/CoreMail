/**
 * Internal (received) date of a restored message (9.5) — what IMAP shows as
 * INTERNALDATE and the webmail as "received". A restore keeps the original
 * instead of the restore time. Order (first usable wins):
 *   1. the date stored in the archive: ZIP manifest `internalDate` (9.5+
 *      exports), the mbox "From " separator line (CoreMail exports write the
 *      internal date there since 9.5; other mbox writers their delivery time);
 *   2. the date of the topmost Received header (the last hop = delivery);
 *   3. the Date header;
 *   4. the restore time.
 * A date before 1970-01-02 or more than one day in the future is not usable. Pure.
 */
import { findBodyStart, parseHeaderFields } from '@coremail/storage';

/** Only this much of the message is scanned for the header section. */
const MAX_HEADER_SCAN = 256 * 1024;
const MIN_DATE_MS = Date.UTC(1970, 0, 2);
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

function usable(d: Date | null, now: Date): d is Date {
  return !!d && !Number.isNaN(d.getTime()) && d.getTime() >= MIN_DATE_MS && d.getTime() <= now.getTime() + FUTURE_SLACK_MS;
}

/** A header date value ("Tue, 3 Nov 2026 10:00:00 +0100 (CET)"); comments removed. */
export function parseHeaderDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const text = value.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Received and Date header dates of a raw message. */
export function headerDates(raw: Buffer): { received: Date | null; date: Date | null } {
  const head = raw.subarray(0, MAX_HEADER_SCAN).toString('latin1');
  const fields = parseHeaderFields(head, 0, findBodyStart(head, 0, head.length));
  const received = fields.find((f) => f.name.toLowerCase() === 'received');
  const semicolon = received ? received.value.lastIndexOf(';') : -1;
  const date = fields.find((f) => f.name.toLowerCase() === 'date');
  return {
    received: semicolon >= 0 ? parseHeaderDate(received!.value.slice(semicolon + 1)) : null,
    date: parseHeaderDate(date?.value),
  };
}

/** Internal date of a restored message (see the module comment for the order). */
export function restoredInternalDate(archiveDate: Date | null, raw: Buffer, now: Date = new Date()): Date {
  if (usable(archiveDate, now)) return archiveDate;
  const h = headerDates(raw);
  if (usable(h.received, now)) return h.received;
  if (usable(h.date, now)) return h.date;
  return now;
}
