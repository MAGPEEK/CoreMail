/**
 * 10.7: the contacts commands as pure data with their enablement rules. No
 * ribbon any more — each command lives in the card it acts on:
 *  - the folder card: the "Neu" split button (Kontakt / Kontaktliste);
 *  - the list card header: search and the sort order (Vorname / Nachname);
 *  - the details card: the action row Bearbeiten, E-Mail, Anrufen,
 *    Kategorisieren, Löschen.
 * Keyboard help and "Über CoreMail" are in the avatar menu of the rail.
 * Components map `icon` names to lucide icons and `action` keys to handlers
 * (components/contacts/ContactsCommands.tsx). No React, no I/O — unit-tested
 * with `node --test`.
 */

export type ContactsAction =
  | 'newContact' | 'newGroup' | 'edit' | 'delete' | 'mail' | 'call' | 'categorize'
  | 'sortGiven' | 'sortFamily';
/** Names of the lucide icons the adapter resolves. */
export type ContactsIcon = 'UserPlus' | 'Pencil' | 'Trash2' | 'Mail' | 'Phone' | 'Tag' | 'ArrowDownAZ';
export type ContactsSelectionKind = 'none' | 'contact' | 'group' | 'directory';
/** Card the command is shown in. */
export type ContactsPlace = 'sidebar' | 'list' | 'detail';

/** What the commands know about the current selection. */
export interface ContactsSelection {
  kind: ContactsSelectionKind;
  /** An editor (new / edit) is open: item commands wait until it is closed. */
  editing: boolean;
  /** The selected contact / directory entry has an e-mail address, or the list has members. */
  hasRecipients: boolean;
  /** Primary phone number of the selected contact, null when none. */
  phone: string | null;
  /** The category module is on for this user. */
  categoriesAvailable: boolean;
}

export type Enablement = { enabled: true } | { enabled: false; reason: string };

export interface ContactsCommand {
  id: string;
  label: string;
  icon: ContactsIcon;
  place: ContactsPlace;
  action: ContactsAction;
  enabled: (sel: ContactsSelection) => Enablement;
}

const ON: Enablement = { enabled: true };
const off = (reason: string): Enablement => ({ enabled: false, reason });

const CLOSE_EDITOR = 'Zuerst die Bearbeitung beenden';
const PICK_ENTRY = 'Zuerst einen Eintrag auswählen';

/** Edit / delete act on an own contact or list; categorize on a contact only. */
function needsOwn(sel: ContactsSelection, allowGroup: boolean): Enablement {
  if (sel.editing) return off(CLOSE_EDITOR);
  if (sel.kind === 'none') return off(PICK_ENTRY);
  if (sel.kind === 'directory') return off('Einträge des globalen Adressbuchs sind schreibgeschützt');
  if (sel.kind === 'group' && !allowGroup) return off('Nur für Kontakte verfügbar');
  return ON;
}

/** Every command, in display order per card. */
export const CONTACT_COMMANDS: readonly ContactsCommand[] = [
  { id: 'new', label: 'Neu', icon: 'UserPlus', place: 'sidebar', action: 'newContact', enabled: () => ON },
  { id: 'sort-given', label: 'Nach Vorname', icon: 'ArrowDownAZ', place: 'list', action: 'sortGiven', enabled: () => ON },
  { id: 'sort-family', label: 'Nach Nachname', icon: 'ArrowDownAZ', place: 'list', action: 'sortFamily', enabled: () => ON },
  { id: 'edit', label: 'Bearbeiten', icon: 'Pencil', place: 'detail', action: 'edit', enabled: (s) => needsOwn(s, true) },
  {
    id: 'mail', label: 'E-Mail', icon: 'Mail', place: 'detail', action: 'mail',
    enabled: (s) => {
      if (s.editing) return off(CLOSE_EDITOR);
      if (s.kind === 'none') return off(PICK_ENTRY);
      return s.hasRecipients ? ON : off('Keine E-Mail-Adresse hinterlegt');
    },
  },
  {
    id: 'call', label: 'Anrufen', icon: 'Phone', place: 'detail', action: 'call',
    enabled: (s) => {
      if (s.editing) return off(CLOSE_EDITOR);
      if (s.kind !== 'contact') return off('Zuerst einen Kontakt auswählen');
      return s.phone ? ON : off('Keine Telefonnummer hinterlegt');
    },
  },
  {
    id: 'categorize', label: 'Kategorisieren', icon: 'Tag', place: 'detail', action: 'categorize',
    enabled: (s) => (s.categoriesAvailable ? needsOwn(s, false) : off('Kategorien sind nicht verfügbar')),
  },
  { id: 'delete', label: 'Löschen', icon: 'Trash2', place: 'detail', action: 'delete', enabled: (s) => needsOwn(s, true) },
];

/** Entries of the "Neu" split button menu. */
export const NEW_MENU: ReadonlyArray<{ label: string; action: 'newContact' | 'newGroup' }> = [
  { label: 'Neuer Kontakt', action: 'newContact' },
  { label: 'Neue Kontaktliste', action: 'newGroup' },
];

export function commandById(id: string): ContactsCommand {
  const c = CONTACT_COMMANDS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown contacts command: ${id}`);
  return c;
}

/** Commands of one card, in order. */
export function commandsIn(place: ContactsPlace): ContactsCommand[] {
  return CONTACT_COMMANDS.filter((c) => c.place === place);
}

/** Selection facts with defaults. */
export function selectionFacts(input: Partial<ContactsSelection>): ContactsSelection {
  return { kind: 'none', editing: false, hasRecipients: false, phone: null, categoriesAvailable: false, ...input };
}
