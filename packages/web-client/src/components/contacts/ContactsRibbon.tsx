/**
 * Contacts ribbon: the pure ribbon data (lib/contactsRibbon.ts — tabs Start /
 * Ansicht / Hilfe) on the shared ribbon (components/Ribbon.tsx). Maps icon names
 * to lucide icons and actions to the page's handlers.
 */
import { useState } from 'react';
import { ArrowDownAZ, Info, Keyboard, Mail, Pencil, Phone, Tag, Trash2, UserPlus, type LucideIcon } from 'lucide-react';
import type { CommandGroup, CommandItem } from '../CommandBar.js';
import type { ContextMenuItem } from '../ContextMenu.js';
import { Ribbon } from '../Ribbon.js';
import {
  NEW_MENU, RIBBON_TABS, commandsOf, type ContactsAction, type ContactsIcon, type ContactsSelection, type RibbonCommand, type RibbonTabId,
} from '../../lib/contactsRibbon.js';
import type { ContactSortKey } from '../../lib/contactsList.js';
import { useT } from '../../i18n/useT.js';

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

export function ContactsRibbon({ selection, handlers, sort, categoryMenu }: Props) {
  const t = useT();
  const [tabId, setTabId] = useState<RibbonTabId>('start');
  const tab = RIBBON_TABS.find((x) => x.id === tabId) ?? RIBBON_TABS[0]!;

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

  return <Ribbon label={t('ribbon_label')} tabs={RIBBON_TABS} active={tab.id} onSelect={setTabId} groups={groups} />;
}
