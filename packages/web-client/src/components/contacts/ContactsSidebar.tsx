/**
 * Navigation of the contacts page under the user's address: "Ihre Kontakte",
 * "Ihre Kontaktlisten", "Kategorien" (collapsible, filters the contact list) and
 * "Globales Adressbuch". All counts come from data the page already loads.
 */
import { useState, type ReactNode } from 'react';
import { BookUser, ChevronDown, ChevronRight, Contact as ContactIcon, Tag, Users } from 'lucide-react';
import { categoryColor } from '../../lib/itemCategories.js';
import { ALL_CONTACTS_VIEW, countLabel, sameView, type CategoryCount, type SidebarView } from '../../lib/contactsList.js';
import { useCategoryDefs } from '../CategoryPicker.js';

interface Props {
  address: string;
  view: SidebarView;
  onView: (view: SidebarView) => void;
  contactCount: number;
  groupCount: number;
  categories: readonly CategoryCount[];
}

function NavButton({ active, onClick, icon, label, count, indent = false }: {
  active: boolean; onClick: () => void; icon: ReactNode; label: string; count?: string | undefined; indent?: boolean;
}) {
  return (
    <button
      type="button" onClick={onClick} aria-current={active ? 'true' : undefined}
      className={`w-full flex items-center gap-2.5 rounded-md py-1.5 text-sm text-left transition-colors ${indent ? 'pl-8 pr-2' : 'px-2'} ${
        active ? 'bg-accent/10 text-accent-fg font-medium' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
      }`}
    >
      <span className="shrink-0" aria-hidden="true">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {count && <span className="text-xs text-fg-subtle shrink-0">{count}</span>}
    </button>
  );
}

export function ContactsSidebar({ address, view, onView, contactCount, groupCount, categories }: Props) {
  const [categoriesOpen, setCategoriesOpen] = useState(true);
  const defs = useCategoryDefs();
  return (
    <nav aria-label="Kontaktordner" className="flex flex-col flex-1 min-h-0 overflow-y-auto p-2 gap-0.5">
      <p className="px-2 py-1.5 text-xs font-semibold text-fg-subtle truncate" title={address}>{address}</p>
      <NavButton
        active={sameView(view, ALL_CONTACTS_VIEW)} onClick={() => onView(ALL_CONTACTS_VIEW)}
        icon={<ContactIcon size={16} />} label="Ihre Kontakte" count={String(contactCount)}
      />
      <NavButton
        active={view.kind === 'groups'} onClick={() => onView({ kind: 'groups' })}
        icon={<Users size={16} />} label="Ihre Kontaktlisten" count={String(groupCount)}
      />
      {categories.length > 0 && (
        <>
          <button
            type="button" aria-expanded={categoriesOpen} onClick={() => setCategoriesOpen((o) => !o)}
            className="w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-left text-fg-muted hover:bg-surface-2 hover:text-fg transition-colors"
          >
            {categoriesOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            <span className="flex-1">Kategorien</span>
          </button>
          {categoriesOpen && categories.map((c) => {
            const color = categoryColor(c.name, defs);
            return (
              <NavButton
                key={c.name} indent
                active={view.kind === 'contacts' && view.category?.toLowerCase() === c.name.toLowerCase()}
                onClick={() => onView({ kind: 'contacts', category: c.name })}
                icon={color
                  ? <span className="block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                  : <Tag size={13} />}
                label={c.name} count={countLabel(c.count, 'Kontakt', 'Kontakte')}
              />
            );
          })}
        </>
      )}
      <div className="my-1 border-t border-line" role="separator" />
      <NavButton
        active={view.kind === 'directory'} onClick={() => onView({ kind: 'directory' })}
        icon={<BookUser size={16} />} label="Globales Adressbuch"
      />
    </nav>
  );
}
