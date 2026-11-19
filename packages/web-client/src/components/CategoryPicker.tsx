/**
 * 9.5: categories on contacts and notes — chips (display) and a toggle list
 * (edit). Colours come from the user's category list (Settings → Kategorien);
 * names an item carries that are not in the list stay selectable.
 * Rules: lib/itemCategories.ts.
 */
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api } from '../api/client.js';
import type { Category } from '../api/types.js';
import { useWebmailFeatures } from '../hooks/useWebmailFeatures.js';
import { categoryColor, categoryOptions, isSelected, toggleCategory } from '../lib/itemCategories.js';

function useCategoryDefs(): Category[] {
  const enabled = useWebmailFeatures().features.categories;
  const { data = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/categories'),
    enabled,
    staleTime: 60_000,
  });
  return data;
}

function Dot({ color }: { color: string | null }) {
  return color
    ? <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden="true" />
    : <span className="w-2 h-2 rounded-full shrink-0 border border-line-strong" aria-hidden="true" />;
}

/** Read-only category chips. */
export function CategoryChips({ names }: { names: readonly string[] }) {
  const defs = useCategoryDefs();
  if (names.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Kategorien">
      {names.map((n) => (
        <li key={n} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-line bg-surface-2 text-[11px] font-medium text-fg">
          <Dot color={categoryColor(n, defs)} />
          {n}
        </li>
      ))}
    </ul>
  );
}

/** Toggle list of the user's categories (hidden while the category module is off). */
export function CategoryPicker({ value, onChange }: { value: readonly string[]; onChange: (next: string[]) => void }) {
  const enabled = useWebmailFeatures().features.categories;
  const defs = useCategoryDefs();
  const options = categoryOptions(defs, value);
  if (!enabled && value.length === 0) return null;
  return (
    <fieldset>
      <legend className="block text-sm font-medium text-fg-muted mb-1">Kategorien</legend>
      {options.length === 0 ? (
        <p className="text-xs text-fg-subtle">Noch keine Kategorien – unter Einstellungen → Kategorien anlegen.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => {
            const on = isSelected(value, o.name);
            return (
              <button
                key={o.name}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(toggleCategory(value, o.name))}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
                  on ? 'border-accent-fg bg-accent/10 text-fg' : 'border-line text-fg-muted hover:bg-surface-2'
                }`}
              >
                {on ? <Check size={12} aria-hidden="true" /> : <Dot color={o.color} />}
                {o.name}
              </button>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
