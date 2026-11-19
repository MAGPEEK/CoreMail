/**
 * 9.5: categories on contacts and notes. Items store category NAMES (as a
 * CardDAV client writes them); the colour comes from the user's category list
 * (Settings → Kategorien, the same list mail uses). Pure.
 */

export interface CategoryDef { name: string; color: string }
export interface CategoryOption { name: string; color: string | null }

const norm = (s: string): string => s.trim().toLowerCase();

/** Select / deselect `name` (case-insensitive), order kept. */
export function toggleCategory(selected: readonly string[], name: string): string[] {
  const k = norm(name);
  return selected.some((s) => norm(s) === k) ? selected.filter((s) => norm(s) !== k) : [...selected, name.trim()];
}

export function isSelected(selected: readonly string[], name: string): boolean {
  return selected.some((s) => norm(s) === norm(name));
}

/** Colour of a category name from the user's list (null = not in the list). */
export function categoryColor(name: string, defs: readonly CategoryDef[]): string | null {
  return defs.find((d) => norm(d.name) === norm(name))?.color ?? null;
}

/**
 * What the picker offers: the user's categories, then names an item carries
 * that are not in the list (written by another client) — never lost on save.
 */
export function categoryOptions(defs: readonly CategoryDef[], selected: readonly string[]): CategoryOption[] {
  const out: CategoryOption[] = defs.map((d) => ({ name: d.name, color: d.color }));
  for (const s of selected) if (!out.some((o) => norm(o.name) === norm(s))) out.push({ name: s, color: null });
  return out;
}

/**
 * The list after toggling `name`, computed on the newest known list of the item
 * (`newest`, e.g. the cache that a pending save already updated) and only falling
 * back to the list the menu was drawn with — so toggles that follow each other
 * faster than a save returns merge instead of replacing one another.
 */
export function categoriesAfterToggle(newest: readonly string[] | null | undefined, drawn: readonly string[], name: string): string[] {
  return toggleCategory(newest ?? drawn, name);
}
