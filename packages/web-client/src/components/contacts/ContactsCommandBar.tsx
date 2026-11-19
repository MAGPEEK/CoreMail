/**
 * THE adapter between the contacts ribbon data (lib/contactsRibbon.ts) and the
 * existing command bar (components/CommandBar.tsx): a small tab strip (Start /
 * Ansicht / Hilfe) above one CommandBar per tab. When the shared tabbed ribbon
 * lands, replace this file's body with that component fed from the same data;
 * the page only talks to this component's props.
 */
import { useId, useState } from 'react';
import { ArrowDownAZ, Info, Keyboard, Mail, Pencil, Phone, Tag, Trash2, UserPlus, type LucideIcon } from 'lucide-react';
import { CommandBar, type CommandGroup, type CommandItem } from '../CommandBar.js';
import type { ContextMenuItem } from '../ContextMenu.js';
import {
  NEW_MENU, RIBBON_TABS, commandsOf, type ContactsAction, type ContactsIcon, type ContactsSelection, type RibbonCommand, type RibbonTabId,
} from '../../lib/contactsRibbon.js';
import type { ContactSortKey } from '../../lib/contactsList.js';

const ICONS: Record<ContactsIcon, LucideIcon> = {
  UserPlus, Pencil, Trash2, Mail, Phone, Tag, ArrowDownAZ, Keyboard, Info,
};

interface Props {
  selection: ContactsSelection;
  handlers: Record<ContactsAction, () => void>;
  sort: ContactSortKey;
  /** Entries of the "Kategorie zuweisen" menu (built by the page from the user's categories). */
  categoryMenu: () => ContextMenuItem[];
}

export function ContactsCommandBar({ selection, handlers, sort, categoryMenu }: Props) {
  const [tabId, setTabId] = useState<RibbonTabId>('start');
  const base = useId();
  const tab = RIBBON_TABS.find((t) => t.id === tabId) ?? RIBBON_TABS[0]!;

  const toItem = (cmd: RibbonCommand): CommandItem => {
    const state = cmd.enabled(selection);
    const Icon = ICONS[cmd.icon];
    const item: CommandItem = {
      id: cmd.id,
      label: cmd.label,
      icon: <Icon size={20} className={cmd.id === 'new' ? 'text-accent-fg' : ''} aria-hidden="true" />,
      tooltip: state.enabled ? cmd.label : `${cmd.label} – ${state.reason}`,
      ...(state.enabled ? {} : { disabled: true }),
    };
    if (cmd.action === 'newContact') {
      return {
        ...item, placement: 'pinned', onClick: handlers.newContact,
        menu: () => NEW_MENU.map((m) => ({ label: m.label, onClick: handlers[m.action] })),
      };
    }
    if (cmd.action === 'categorize') return { ...item, menu: categoryMenu };
    if (cmd.action === 'sortGiven' || cmd.action === 'sortFamily') {
      return { ...item, pressed: (cmd.action === 'sortGiven') === (sort === 'given'), onClick: handlers[cmd.action] };
    }
    return { ...item, onClick: handlers[cmd.action] };
  };

  const groups: CommandGroup[] = tab.groups.map((g) => ({ id: g.id, title: g.title, items: commandsOf(g).map(toItem) }));

  return (
    <div className="flex flex-col flex-1 min-w-0">
      <div role="tablist" aria-label="Kontakte-Menüband" className="flex gap-1 px-1">
        {RIBBON_TABS.map((t) => (
          <button
            key={t.id} type="button" role="tab" id={`${base}-tab-${t.id}`} aria-selected={t.id === tabId} aria-controls={`${base}-panel`}
            tabIndex={t.id === tabId ? 0 : -1}
            onClick={() => setTabId(t.id)}
            onKeyDown={(e) => {
              const i = RIBBON_TABS.findIndex((x) => x.id === tabId);
              const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
              if (next === null) return;
              const target = RIBBON_TABS[(next + RIBBON_TABS.length) % RIBBON_TABS.length]!;
              setTabId(target.id);
              requestAnimationFrame(() => document.getElementById(`${base}-tab-${target.id}`)?.focus());
            }}
            className={`px-3 py-1 text-sm font-medium border-b-2 transition-colors ${
              t.id === tabId ? 'border-accent-fg text-fg' : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${tabId}`}>
        <CommandBar label="Kontakt-Befehle" variant="ribbon" groups={groups} />
      </div>
    </div>
  );
}
