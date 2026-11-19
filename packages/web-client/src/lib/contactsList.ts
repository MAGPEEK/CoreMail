/**
 * Presentation helpers of the contacts page: sorting, category filter and
 * counts, the primary phone, the "Kontaktinformationen" column and the sidebar
 * views. Pure — unit-tested with `node --test`.
 */

export type ContactSortKey = 'given' | 'family';

export interface ListContact {
  id: string;
  displayName: string;
  email: string;
  phone?: string | undefined;
  mobile?: string | undefined;
  categories?: string[] | undefined;
}

/** Given and family name of a display name ("Müller, Jörg" and "Jörg Müller" both work). */
export function nameParts(displayName: string): { given: string; family: string } {
  const name = displayName.trim();
  const comma = name.indexOf(',');
  if (comma > 0) return { given: name.slice(comma + 1).trim(), family: name.slice(0, comma).trim() };
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length < 2) return { given: name, family: '' };
  return { given: words.slice(0, -1).join(' '), family: words[words.length - 1]! };
}

const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

/** Sorted copy (presentation only): by given name or family name, ties by display name. */
export function sortContacts<T extends { displayName: string }>(list: readonly T[], key: ContactSortKey): T[] {
  const first = (c: T) => { const p = nameParts(c.displayName); return key === 'given' ? p.given : (p.family || p.given); };
  return [...list].sort((a, b) => collator.compare(first(a), first(b)) || collator.compare(a.displayName, b.displayName));
}

/** A contact of the user's own list (a search also returns address-list entries and lists). */
export function isOwnContact(c: { id: string }): boolean {
  return !c.id.startsWith('gal-') && !c.id.startsWith('group-');
}

export function primaryPhone(c: {
  phone?: string | undefined; mobile?: string | undefined; phones?: ReadonlyArray<{ value: string }> | undefined;
}): string | null {
  return c.phones?.find((p) => p.value.trim())?.value.trim() || c.mobile?.trim() || c.phone?.trim() || null;
}

/** `tel:` target: digits and a leading plus only. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** Primary e-mail and phone for the "Kontaktinformationen" column. */
export function contactInfoLines(c: ListContact): string[] {
  return [c.email?.trim(), primaryPhone(c)].filter((v): v is string => !!v);
}

export interface CategoryCount { name: string; count: number }

/** Category names with their number of contacts, alphabetical (case-insensitive, first spelling kept). */
export function categoryCounts(contacts: readonly ListContact[]): CategoryCount[] {
  const map = new Map<string, CategoryCount>();
  for (const c of contacts) {
    for (const raw of c.categories ?? []) {
      const name = raw.trim();
      if (!name) continue;
      const entry = map.get(name.toLowerCase()) ?? { name, count: 0 };
      entry.count += 1;
      map.set(name.toLowerCase(), entry);
    }
  }
  return [...map.values()].sort((a, b) => collator.compare(a.name, b.name));
}

/** Contacts carrying the category (null = no filter). */
export function filterByCategory<T extends ListContact>(contacts: readonly T[], category: string | null): T[] {
  if (!category) return [...contacts];
  const k = category.trim().toLowerCase();
  return contacts.filter((c) => (c.categories ?? []).some((n) => n.trim().toLowerCase() === k));
}

/** What the sidebar filters the middle list by. */
export type SidebarView =
  | { kind: 'contacts'; category: string | null }
  | { kind: 'groups' }
  | { kind: 'directory' };

export const ALL_CONTACTS_VIEW: SidebarView = { kind: 'contacts', category: null };

export function sameView(a: SidebarView, b: SidebarView): boolean {
  if (a.kind === 'contacts' && b.kind === 'contacts') return a.category === b.category;
  return a.kind === b.kind;
}

export interface DirectoryEntry { id: string; displayName: string; email: string; domain?: string }

/** Plural-aware counter text of the sidebar ("1 Kontakt", "3 Kontakte"). */
export function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
