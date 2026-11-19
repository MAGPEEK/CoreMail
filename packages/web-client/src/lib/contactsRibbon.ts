/**
 * Contacts ribbon as pure data: tabs, groups and commands with their
 * enablement rules. Components map `icon` names to lucide icons and `action`
 * keys to handlers (components/contacts/ContactsCommandBar.tsx is the one
 * adapter onto the command bar). No React, no I/O — unit-tested with `node --test`.
 */

export type RibbonTabId = 'start' | 'view' | 'help';
export type ContactsAction =
  | 'newContact' | 'newGroup' | 'edit' | 'delete' | 'mail' | 'call' | 'categorize'
  | 'sortGiven' | 'sortFamily' | 'shortcuts' | 'about';
/** Names of the lucide icons the adapter resolves. */
export type ContactsIcon = 'UserPlus' | 'Pencil' | 'Trash2' | 'Mail' | 'Phone' | 'Tag' | 'ArrowDownAZ' | 'Keyboard' | 'Info';
export type ContactsSelectionKind = 'none' | 'contact' | 'group' | 'directory';

/** What the ribbon knows about the current selection. */
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

export interface RibbonCommand {
  id: string;
  label: string;
  icon: ContactsIcon;
  group: string;
  action: ContactsAction;
  enabled: (sel: ContactsSelection) => Enablement;
}

export interface RibbonGroup { id: string; title: string; commandIds: string[] }
export interface RibbonTab { id: RibbonTabId; label: string; groups: RibbonGroup[] }

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

export const RIBBON_COMMANDS: readonly RibbonCommand[] = [
  { id: 'new', label: 'Neuer Kontakt', icon: 'UserPlus', group: 'new', action: 'newContact', enabled: () => ON },
  { id: 'edit', label: 'Bearbeiten', icon: 'Pencil', group: 'manage', action: 'edit', enabled: (s) => needsOwn(s, true) },
  { id: 'delete', label: 'Löschen', icon: 'Trash2', group: 'manage', action: 'delete', enabled: (s) => needsOwn(s, true) },
  {
    id: 'mail', label: 'E-Mail', icon: 'Mail', group: 'contact', action: 'mail',
    enabled: (s) => {
      if (s.editing) return off(CLOSE_EDITOR);
      if (s.kind === 'none') return off(PICK_ENTRY);
      return s.hasRecipients ? ON : off('Keine E-Mail-Adresse hinterlegt');
    },
  },
  {
    id: 'call', label: 'Anrufen', icon: 'Phone', group: 'contact', action: 'call',
    enabled: (s) => {
      if (s.editing) return off(CLOSE_EDITOR);
      if (s.kind !== 'contact') return off('Zuerst einen Kontakt auswählen');
      return s.phone ? ON : off('Keine Telefonnummer hinterlegt');
    },
  },
  {
    id: 'categorize', label: 'Kategorie zuweisen', icon: 'Tag', group: 'contact', action: 'categorize',
    enabled: (s) => (s.categoriesAvailable ? needsOwn(s, false) : off('Kategorien sind nicht verfügbar')),
  },
  { id: 'sort-given', label: 'Nach Vorname', icon: 'ArrowDownAZ', group: 'sort', action: 'sortGiven', enabled: () => ON },
  { id: 'sort-family', label: 'Nach Nachname', icon: 'ArrowDownAZ', group: 'sort', action: 'sortFamily', enabled: () => ON },
  { id: 'shortcuts', label: 'Tastenkürzel', icon: 'Keyboard', group: 'help', action: 'shortcuts', enabled: () => ON },
  { id: 'about', label: 'Über CoreMail', icon: 'Info', group: 'help', action: 'about', enabled: () => ON },
];

export const RIBBON_TABS: readonly RibbonTab[] = [
  {
    id: 'start', label: 'Start',
    groups: [
      { id: 'new', title: 'Neu', commandIds: ['new'] },
      { id: 'manage', title: 'Verwalten', commandIds: ['edit', 'delete'] },
      { id: 'contact', title: 'Kontakt', commandIds: ['mail', 'call', 'categorize'] },
    ],
  },
  { id: 'view', label: 'Ansicht', groups: [{ id: 'sort', title: 'Sortieren', commandIds: ['sort-given', 'sort-family'] }] },
  { id: 'help', label: 'Hilfe', groups: [{ id: 'help', title: 'Hilfe', commandIds: ['shortcuts', 'about'] }] },
];

/** Entries of the "Neuer Kontakt" split button menu. */
export const NEW_MENU: ReadonlyArray<{ label: string; action: 'newContact' | 'newGroup' }> = [
  { label: 'Neuer Kontakt', action: 'newContact' },
  { label: 'Neue Kontaktliste', action: 'newGroup' },
];

export function commandById(id: string): RibbonCommand {
  const c = RIBBON_COMMANDS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown contacts command: ${id}`);
  return c;
}

/** The commands of a group, in order. */
export function commandsOf(group: RibbonGroup): RibbonCommand[] {
  return group.commandIds.map(commandById);
}

/** Selection facts with defaults. */
export function selectionFacts(input: Partial<ContactsSelection>): ContactsSelection {
  return { kind: 'none', editing: false, hasRecipients: false, phone: null, categoriesAvailable: false, ...input };
}
