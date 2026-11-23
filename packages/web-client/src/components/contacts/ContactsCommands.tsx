/**
 * 10.7: the contacts commands in their cards (lib/contactsCommands.ts; no ribbon):
 *  - `ContactsNewButton` — "Neu" split button at the top of the folder card
 *    (Neuer Kontakt / Neue Kontaktliste);
 *  - `ContactsSortButton` — the sort order (Vorname / Nachname) in the list header;
 *  - `ContactDetailActions` — the action row of the details card: Bearbeiten,
 *    E-Mail, Anrufen, Kategorisieren, Löschen (shared command bar: roving
 *    focus, disabled commands explain why, overflow "…").
 */
import { ArrowDownAZ, Mail, Pencil, Phone, Tag, Trash2, UserPlus, type LucideIcon } from 'lucide-react';
import { CommandBar, type CommandItem } from '../CommandBar.js';
import type { ContextMenuItem } from '../ContextMenu.js';
import { SplitButton } from '../SplitButton.js';
import {
  NEW_MENU, commandsIn, type ContactsAction, type ContactsCommand, type ContactsIcon, type ContactsSelection,
} from '../../lib/contactsCommands.js';
import type { ContactSortKey } from '../../lib/contactsList.js';
import { useT } from '../../i18n/useT.js';

const ICONS: Record<ContactsIcon, LucideIcon> = { UserPlus, Pencil, Trash2, Mail, Phone, Tag, ArrowDownAZ };

type Handlers = Record<ContactsAction, () => void>;

export function ContactsNewButton({ handlers }: { handlers: Handlers }) {
  const t = useT();
  return (
    <SplitButton
      label={t('contacts_new')}
      icon={<UserPlus size={16} />}
      tooltip={t('contacts_new_tip')}
      onClick={handlers.newContact}
      menu={() => NEW_MENU.map((m): ContextMenuItem => ({ label: m.label, onClick: handlers[m.action] }))}
    />
  );
}

export function ContactsSortButton({ sort, handlers }: { sort: ContactSortKey; handlers: Handlers }) {
  const t = useT();
  const item: CommandItem = {
    id: 'sort', label: t('contacts_sort'), icon: <ArrowDownAZ size={15} />, iconOnly: true,
    menu: () => commandsIn('list').map((c): ContextMenuItem => ({
      label: c.label, checked: (c.action === 'sortGiven') === (sort === 'given'), onClick: handlers[c.action],
    })),
  };
  return <CommandBar label={t('contacts_sort')} groups={[{ id: 'sort', items: [item] }]} dividers={false} className="shrink-0" />;
}

export function ContactDetailActions({ selection, handlers, categoryMenu }: {
  selection: ContactsSelection;
  handlers: Handlers;
  /** Entries of the "Kategorisieren" menu (built by the page from the user's categories). */
  categoryMenu: () => ContextMenuItem[];
}) {
  const t = useT();
  const toItem = (cmd: ContactsCommand): CommandItem => {
    const state = cmd.enabled(selection);
    const Icon = ICONS[cmd.icon];
    const item: CommandItem = {
      id: cmd.id,
      label: cmd.label,
      icon: <Icon size={16} aria-hidden="true" />,
      tooltip: state.enabled ? cmd.label : `${cmd.label} – ${state.reason}`,
      ...(state.enabled ? {} : { disabled: true }),
      ...(cmd.action === 'delete' ? { tone: 'danger' as const } : {}),
    };
    if (cmd.action === 'categorize') return { ...item, menu: categoryMenu };
    return { ...item, onClick: handlers[cmd.action] };
  };
  return (
    <CommandBar
      label={t('contacts_detail_actions')}
      groups={[{ id: 'detail', items: commandsIn('detail').map(toItem) }]}
      dividers={false}
      className="px-2 py-1.5 border-b border-line shrink-0"
    />
  );
}
