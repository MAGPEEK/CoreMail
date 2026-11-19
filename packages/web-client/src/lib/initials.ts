/**
 * 9.5: initials of an avatar (components/Avatar.tsx) — pure, unit-tested.
 *
 *   display name   first letter of the first word + first letter of the last word
 *                  ("Jörg Müller" → "JM", "Müller, Jörg" → "JM",
 *                  "Max (Vertrieb) Muster" → "MM"); one word → its first letter
 *   no name        first letter of the email local part (a digit or other
 *                  character when it has no letter) — never "?" when there is an
 *                  address
 *   nothing        "?"
 *
 * Words without a letter ("&", "-", "2.") are skipped; parenthesised and
 * bracketed parts are ignored; "Last, First" is read as "First Last".
 */

const LETTER = /\p{L}/u;

/** First letter of a word in upper case, or null when the word has none. */
function firstLetter(word: string): string | null {
  const ch = Array.from(word).find((c) => LETTER.test(c));
  if (!ch) return null;
  const upper = ch.toLocaleUpperCase('de');
  return Array.from(upper).length === 1 ? upper : ch;
}

/** Name without parenthesised / bracketed parts, "Last, First" turned around (pure). */
export function normalizeDisplayName(name: string): string {
  const plain = name.replace(/\([^)]*\)|\[[^\]]*\]|<[^>]*>/g, ' ').replace(/["“”„]/g, ' ');
  const comma = plain.indexOf(',');
  if (comma < 0) return plain.trim();
  return `${plain.slice(comma + 1)} ${plain.slice(0, comma)}`.replace(/,/g, ' ').trim();
}

/** Initials from a display name, or '' when it has no usable word (pure). */
export function nameInitials(name: string): string {
  if (name.includes('@')) return '';
  const letters = normalizeDisplayName(name).split(/\s+/).map(firstLetter).filter((l): l is string => l !== null);
  if (letters.length === 0) return '';
  return letters.length === 1 ? letters[0] : letters[0] + letters[letters.length - 1];
}

/** Initial from an email address: first letter of the local part, else its first character (pure). */
export function emailInitial(email: string): string {
  const local = (email.split('@')[0] ?? '').trim();
  if (!local) return '';
  return firstLetter(local) ?? Array.from(local)[0].toLocaleUpperCase('de');
}

/** Avatar initials for a display name and/or an address (pure). */
export function getInitials(name: string | null | undefined, email?: string | null): string {
  const fromName = nameInitials(name ?? '');
  if (fromName) return fromName;
  const fromEmail = emailInitial(email ?? '') || emailInitial(name?.includes('@') ? name : '');
  return fromEmail || '?';
}
