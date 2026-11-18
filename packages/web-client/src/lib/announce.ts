/**
 * Screen-reader announcements outside toasts (selection, opened folder, moved
 * focus). `announce()` publishes to the one polite live region of the app
 * (components/LiveRegion.tsx). The same text twice in a row is re-announced.
 * No imports — unit-tested with `node --test`.
 */

export interface Announcement {
  text: string;
  /** Increments per call so an identical text is read again. */
  seq: number;
}

type Listener = (a: Announcement) => void;

const listeners = new Set<Listener>();
let seq = 0;

export function announce(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  seq += 1;
  const a: Announcement = { text: trimmed, seq };
  for (const l of listeners) l(a);
}

export function subscribeAnnouncements(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** German selection summary for the live region. */
export function selectionAnnouncement(count: number, subject?: string): string {
  if (count <= 0) return 'Auswahl aufgehoben';
  if (count === 1) return subject ? `Ausgewählt: ${subject}` : '1 Nachricht ausgewählt';
  return `${count} Nachrichten ausgewählt`;
}
