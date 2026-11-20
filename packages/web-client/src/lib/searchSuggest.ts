/**
 * 10.2: suggestions of the mail search fields (message list + header) — what the
 * dropdown shows and how the keyboard moves through it. The server part is
 * GET <mail base>/search/suggest?q= (api-gateway lib/search-suggest.ts).
 *
 *  - field empty (focused):   "Letzte Suchen" (lib/recentSearches.ts)
 *  - 2+ characters, no operator syntax: "Personen" + "Nachrichten" from the server
 *  - otherwise (1 character, from:/is:/"…"/-word): nothing — operators keep the
 *    plain full search
 * Keyboard (combobox with aria-activedescendant): ↓/↑ move (wrapping), Enter on a
 * highlighted entry selects it, Enter without one runs the full search, Escape
 * closes, Delete removes a highlighted recent search.
 * No imports — unit-tested with `node --test`.
 */

export const SUGGEST_MIN_CHARS = 2;
export const SUGGEST_DEBOUNCE_MS = 150;

export interface PersonSuggestion { name: string; address: string }
export interface MessageSuggestion {
  id: string;
  folderId: string;
  folderName: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  date: string;
}
export interface SuggestResponse { people: PersonSuggestion[]; messages: MessageSuggestion[] }

export type SuggestItem =
  | { kind: 'recent'; key: string; term: string }
  | { kind: 'person'; key: string; person: PersonSuggestion }
  | { kind: 'message'; key: string; message: MessageSuggestion };

export type SuggestGroupKey = 'recent' | 'people' | 'messages';
export interface SuggestGroup { key: SuggestGroupKey; items: SuggestItem[] }

/** True when the query uses search operators / quotes / negation (no suggestions then). */
export function hasOperatorSyntax(q: string): boolean {
  return /(^|\s)-\S|"|\b[a-z_]+:/i.test(q);
}

/** The term sent to the server (whitespace collapsed), or '' when it gets no suggestions. */
export function suggestTerm(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return [...t].length >= SUGGEST_MIN_CHARS && !hasOperatorSyntax(t) ? t : '';
}

/** The search a picked person runs. */
export function personSearch(address: string): string {
  return `from:${address}`;
}

/**
 * The groups of the dropdown (empty groups left out) for the field text, the
 * server answer (possibly the previous one while the next loads) and the recent
 * searches. `flat` is the keyboard order.
 */
export function suggestGroups(text: string, data: SuggestResponse | undefined, recent: readonly string[]): { groups: SuggestGroup[]; flat: SuggestItem[] } {
  const groups: SuggestGroup[] = [];
  if (text.trim() === '') {
    if (recent.length > 0) groups.push({ key: 'recent', items: recent.map((term) => ({ kind: 'recent', key: `r:${term}`, term })) });
  } else if (suggestTerm(text) && data) {
    const people: SuggestItem[] = data.people.map((person) => ({ kind: 'person', key: `p:${person.address.toLowerCase()}`, person }));
    const messages: SuggestItem[] = data.messages.map((message) => ({ kind: 'message', key: `m:${message.id}`, message }));
    if (people.length > 0) groups.push({ key: 'people', items: people });
    if (messages.length > 0) groups.push({ key: 'messages', items: messages });
  }
  return { groups, flat: groups.flatMap((g) => g.items) };
}

export type ComboAction =
  | { type: 'move'; index: number }
  | { type: 'select'; index: number }
  | { type: 'remove'; index: number }
  | { type: 'submit' }
  | { type: 'close' };

/**
 * What a key does in the search field. `open` = the dropdown shows, `count` its
 * entries, `active` the highlighted one (-1 = none), `kindAt` the kind of an
 * entry. null = not handled (the field's own behaviour applies).
 */
export function comboKey(
  key: string,
  state: { open: boolean; count: number; active: number; kindAt?: (index: number) => SuggestItem['kind'] | undefined },
): ComboAction | null {
  const { open, count, active } = state;
  switch (key) {
    case 'ArrowDown':
      if (count === 0) return null;
      return { type: 'move', index: !open || active < 0 || active >= count - 1 ? 0 : active + 1 };
    case 'ArrowUp':
      if (count === 0) return null;
      return { type: 'move', index: !open || active <= 0 ? count - 1 : active - 1 };
    case 'Enter':
      return open && active >= 0 && active < count ? { type: 'select', index: active } : { type: 'submit' };
    case 'Escape':
      return open ? { type: 'close' } : null;
    case 'Delete':
      return open && active >= 0 && state.kindAt?.(active) === 'recent' ? { type: 'remove', index: active } : null;
    default:
      return null;
  }
}

/** The highlight after the list changed (kept on the same entry, else none). */
export function keepActive(prevKey: string | null, flat: readonly SuggestItem[]): number {
  return prevKey === null ? -1 : flat.findIndex((i) => i.key === prevKey);
}
