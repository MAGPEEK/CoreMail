/**
 * The ActiveSync view of a contact ([MS-ASCNTC]) — pure. ActiveSync has fixed slots
 * (Email1–3Address, twelve phone kinds, three addresses, one web page, three IM addresses);
 * a CoreMail contact has typed lists of any length. The view is the slot → value table a
 * device gets; every slot points at the list entry it shows (`assignSlots`).
 *
 * A device change is applied slot by slot to the entry the slot showed: its value changes,
 * its type, group and vCard parameters stay; an emptied slot removes its entry; a value in a
 * slot that showed nothing appends an entry of the slot's type. Entries no slot showed (a
 * fourth e-mail address, a third work phone, an address part ActiveSync has no element for)
 * are never touched — the device could not see them, so it cannot have meant to delete them.
 *
 * Slot assignment (the first unassigned entry the slot accepts, in this order):
 *   Email1–3Address   the first three e-mail addresses (any type)
 *   Business(2)Phone  the first two `work` phones      Home(2)Phone  the first two `home` phones
 *   MobilePhone       the first `mobile` phone         Business/HomeFax  `fax` phones (below)
 *   Pager             the first `pager` phone
 *   CompanyMainPhone, CarPhone, RadioPhone, AssistantPhone — `other` phones; Business/HomeFax —
 *     `fax` phones. The card has no type for these kinds; the vCard keeps the kind of a number
 *     (storage ContactPhoneKind, e.g. TEL;TYPE=CAR, TYPE=WORK,FAX). A slot first shows the
 *     first number of its kind; a slot still free then shows the next number of its card type
 *     no slot shows yet (e.g. an `other` / `fax` number a CardDAV client stored without a kind). A number a
 *     device puts into an empty slot is stored with the slot's kind and comes back there.
 *   Business/Home/OtherAddress  the first `work` / `home` / `other` address
 *   WebPage           the first web page              IMAddress1–3  the first three chat addresses
 */
import {
  ADDRESS_FIELDS, applyContactPatch, displayNameFromParts, emptyAddress, fileAsOf,
  type ContactAddress, type ContactAddressType, type ContactCard, type ContactName,
} from '@coremail/storage/contact-card';
import type { ContactPhoneKind } from '@coremail/storage';

/** A contact as ActiveSync sees it: the card plus the vCard properties outside it. */
export interface ContactItem {
  card: ContactCard;
  /** OfficeLocation (a vCard property of its own). */
  officeLocation: string;
  /** Base64 of the inline photo when it is within the picture bound, else '' (no or hidden photo). */
  picture: string;
  /** The kind of each `card.phones` entry (same order; missing = none) — vcardPhoneKinds(). */
  phoneKinds: readonly ContactPhoneKind[];
}

/** Element name → value (text, dates as the card spells them, e-mail as the bare address). */
export type ContactView = Record<string, string>;

type ListName = 'emails' | 'phones' | 'urls' | 'ims';

export interface ListSlot {
  element: string;
  list: ListName;
  /** Entry types the slot shows (undefined = any). */
  type?: string;
  /** Type of an entry a device creates through the slot. */
  newType: string;
  /** Phone kind the slot stands for (its numbers are stored with it). */
  kind?: ContactPhoneKind;
}

const slot = (element: string, list: ListName, newType: string, type?: string, kind?: ContactPhoneKind): ListSlot =>
  ({ element, list, newType, ...(type ? { type } : {}), ...(kind ? { kind } : {}) });

export const LIST_SLOTS: readonly ListSlot[] = [
  slot('Email1Address', 'emails', 'other'), slot('Email2Address', 'emails', 'other'), slot('Email3Address', 'emails', 'other'),
  slot('BusinessPhoneNumber', 'phones', 'work', 'work'), slot('Business2PhoneNumber', 'phones', 'work', 'work'),
  slot('HomePhoneNumber', 'phones', 'home', 'home'), slot('Home2PhoneNumber', 'phones', 'home', 'home'),
  slot('MobilePhoneNumber', 'phones', 'mobile', 'mobile'),
  slot('BusinessFaxNumber', 'phones', 'fax', 'fax', 'work-fax'), slot('HomeFaxNumber', 'phones', 'fax', 'fax', 'home-fax'),
  slot('PagerNumber', 'phones', 'pager', 'pager'),
  slot('CompanyMainPhone', 'phones', 'other', 'other', 'company-main'), slot('CarPhoneNumber', 'phones', 'other', 'other', 'car'),
  slot('RadioPhoneNumber', 'phones', 'other', 'other', 'radio'), slot('AssistantPhoneNumber', 'phones', 'other', 'other', 'assistant'),
  slot('WebPage', 'urls', 'other'),
  slot('IMAddress', 'ims', 'other'), slot('IMAddress2', 'ims', 'other'), slot('IMAddress3', 'ims', 'other'),
];

const ADDRESS_SLOTS: ReadonlyArray<{ prefix: string; type: ContactAddressType }> = [
  { prefix: 'Business', type: 'work' }, { prefix: 'Home', type: 'home' }, { prefix: 'Other', type: 'other' },
];

/** Address element suffix → card field (PO box and extended address have no element). */
const ADDRESS_PARTS = [
  ['Street', 'street'], ['City', 'city'], ['State', 'region'], ['PostalCode', 'postalCode'], ['Country', 'country'],
] as const satisfies ReadonlyArray<readonly [string, (typeof ADDRESS_FIELDS)[number]]>;

/** Single-value elements → card field. */
const NAME_ELEMENTS = [
  ['FirstName', 'given'], ['MiddleName', 'middle'], ['LastName', 'family'], ['Title', 'prefix'], ['Suffix', 'suffix'],
] as const satisfies ReadonlyArray<readonly [string, keyof ContactName]>;
const CARD_ELEMENTS = [
  ['NickName', 'nickname'], ['CompanyName', 'company'], ['Department', 'department'], ['JobTitle', 'jobTitle'],
  ['Birthday', 'birthday'], ['Anniversary', 'anniversary'],
] as const satisfies ReadonlyArray<readonly [string, keyof ContactCard]>;

export const NAME_ELEMENT_NAMES: readonly string[] = NAME_ELEMENTS.map(([e]) => e);
const CARD_ELEMENT_NAMES: readonly string[] = CARD_ELEMENTS.map(([e]) => e);

const addressElements = (prefix: string): string[] => ADDRESS_PARTS.map(([suffix]) => `${prefix}Address${suffix}`);

/** Every element of the view. */
export const VIEW_ELEMENTS: readonly string[] = [
  ...NAME_ELEMENT_NAMES, ...CARD_ELEMENT_NAMES, 'FileAs', 'OfficeLocation', 'Picture',
  ...LIST_SLOTS.map((s) => s.element), ...ADDRESS_SLOTS.flatMap((a) => addressElements(a.prefix)),
];

/** Which list entry / address each slot shows. */
interface SlotAssignment {
  lists: Map<string, number>;
  addresses: Map<string, number>;
}

/** The kind of list entry `n` (only phones have kinds). */
const kindOf = (item: ContactItem, list: ListName, n: number): ContactPhoneKind => (list === 'phones' ? item.phoneKinds[n] ?? '' : '');

function assignSlots(item: ContactItem): SlotAssignment {
  const { card } = item;
  const used: Record<ListName, Set<number>> = { emails: new Set(), phones: new Set(), urls: new Set(), ims: new Set() };
  const lists = new Map<string, number>();
  const take = (s: ListSlot, ofKind: boolean): void => {
    const i = card[s.list].findIndex((e, n) => !used[s.list].has(n) && (s.type === undefined || e.type === s.type)
      && (!ofKind || kindOf(item, s.list, n) === s.kind));
    if (i >= 0) { used[s.list].add(i); lists.set(s.element, i); }
  };
  // a kind slot shows a number of its kind first; a slot still free then any number of its type
  for (const s of LIST_SLOTS) take(s, s.kind !== undefined);
  for (const s of LIST_SLOTS) if (s.kind !== undefined && !lists.has(s.element)) take(s, false);
  const addresses = new Map<string, number>();
  for (const a of ADDRESS_SLOTS) {
    const i = card.addresses.findIndex((x) => x.type === a.type);
    if (i >= 0) addresses.set(a.prefix, i);
  }
  return { lists, addresses };
}

export function contactView(item: ContactItem): ContactView {
  const { card } = item;
  const view: ContactView = { FileAs: fileAsOf(card), OfficeLocation: item.officeLocation, Picture: item.picture };
  for (const [e, f] of NAME_ELEMENTS) view[e] = card.name[f];
  for (const [e, f] of CARD_ELEMENTS) view[e] = card[f];
  const slots = assignSlots(item);
  for (const s of LIST_SLOTS) {
    const i = slots.lists.get(s.element);
    view[s.element] = i === undefined ? '' : card[s.list][i]!.value;
  }
  for (const a of ADDRESS_SLOTS) {
    const i = slots.addresses.get(a.prefix);
    const address = i === undefined ? undefined : card.addresses[i];
    for (const [suffix, field] of ADDRESS_PARTS) view[`${a.prefix}Address${suffix}`] = address?.[field] ?? '';
  }
  return view;
}

/** What a device wants the contact to be: the stored view overlaid with its values. */
export interface DesiredContact {
  view: ContactView;
  categories: string[];
  notes: string;
  /** The device sent a value CoreMail cannot store (a picture over the bound, a malformed date). */
  refused: boolean;
}

/** Display name a card derives (name parts, else "file as", company, first e-mail, first phone). */
function derivedDisplayName(card: ContactCard): string {
  return displayNameFromParts(card.name) || card.fileAs.trim() || card.company.trim()
    || (card.emails[0]?.value ?? '') || (card.phones[0]?.value ?? '');
}

type Entry = { type: string; value: string };
type KindedEntry = { entry: Entry; kind: ContactPhoneKind };

/**
 * The list after the device's slot values: changed in place (type and kind kept), emptied ones
 * removed, new ones appended with the slot's type and kind.
 */
function applyListSlots(item: ContactItem, name: ListName, slots: SlotAssignment, view: ContactView): KindedEntry[] {
  const out: Array<KindedEntry | null> = (item.card[name] as readonly Entry[]).map((e, n) => ({ entry: { ...e }, kind: kindOf(item, name, n) }));
  for (const s of LIST_SLOTS.filter((x) => x.list === name)) {
    const value = view[s.element] ?? '';
    const i = slots.lists.get(s.element);
    if (i !== undefined) out[i] = value ? { ...out[i]!, entry: { ...out[i]!.entry, value } } : null;
    else if (value) out.push({ entry: { type: s.newType, value }, kind: s.kind ?? '' });
  }
  return out.filter((e): e is KindedEntry => e !== null);
}

const entries = (list: readonly KindedEntry[]): Entry[] => list.map((e) => e.entry);

function applyAddressSlots(list: readonly ContactAddress[], slots: SlotAssignment, view: ContactView): ContactAddress[] {
  const out = list.map((a) => ({ ...a }));
  for (const a of ADDRESS_SLOTS) {
    const i = slots.addresses.get(a.prefix);
    const target = i === undefined ? emptyAddress(a.type) : out[i]!;
    for (const [suffix, field] of ADDRESS_PARTS) target[field] = view[`${a.prefix}Address${suffix}`] ?? '';
    // an address keeps its PO box / extended part; an emptied one is dropped by the card rules
    if (i === undefined) out.push(target);
  }
  return out;
}

/**
 * The stored "file as" for the device's FileAs: unchanged → as stored (explicit or derived);
 * empty or the value the new card derives anyway → derived (''); anything else → explicit.
 */
function fileAsFromDevice(old: ContactCard, next: ContactCard, fileAs: string): string {
  if (fileAs === fileAsOf(old)) return old.fileAs;
  return fileAs === '' || fileAs === fileAsOf({ ...next, fileAs: '' }) ? '' : fileAs;
}

/**
 * The contact a device change asks for (`stored` = the empty contact for an Add). The display
 * name follows the name parts unless it was set apart from them; "file as" stays derived while
 * the device sends back the derived value.
 */
export function buildContact(stored: ContactItem, desired: DesiredContact): ContactItem {
  const old = stored.card;
  const slots = assignSlots(stored);
  const v = desired.view;
  const name = { ...old.name };
  for (const [e, f] of NAME_ELEMENTS) name[f] = v[e] ?? '';
  const scalars = Object.fromEntries(CARD_ELEMENTS.map(([e, f]) => [f, v[e] ?? ''])) as Partial<ContactCard>;
  const phones = applyListSlots(stored, 'phones', slots, v);
  const lists = {
    emails: entries(applyListSlots(stored, 'emails', slots, v)) as ContactCard['emails'],
    phones: entries(phones) as ContactCard['phones'],
    urls: entries(applyListSlots(stored, 'urls', slots, v)) as ContactCard['urls'],
    ims: entries(applyListSlots(stored, 'ims', slots, v)) as ContactCard['ims'],
    addresses: applyAddressSlots(old.addresses, slots, v),
  };
  const base: ContactCard = { ...old, ...scalars, ...lists, name, fileAs: '', categories: desired.categories, notes: desired.notes };
  const withFileAs: ContactCard = { ...base, fileAs: fileAsFromDevice(old, base, v['FileAs'] ?? '') };
  const nameSetApart = old.displayName.trim() !== '' && old.displayName.trim() !== derivedDisplayName(old);
  const displayName = nameSetApart ? old.displayName : derivedDisplayName(withFileAs);
  const card = applyContactPatch(old, { ...withFileAs, displayName, name });
  // (no number is empty here, so the card keeps every entry of `phones` in order)
  return { card, officeLocation: v['OfficeLocation'] ?? '', picture: v['Picture'] ?? '', phoneKinds: phones.map((p) => p.kind) };
}

/**
 * Does the stored contact differ from what the device sent (a slot moved to another entry, a
 * refused value)? Then the device gets the stored contact back. A "file as" the device left
 * empty is derived by the server and does not count.
 */
export function differsFromDevice(result: ContactItem, desired: DesiredContact): boolean {
  if (desired.refused) return true;
  const view = contactView(result);
  return VIEW_ELEMENTS.some((e) => !(e === 'FileAs' && !desired.view[e]) && view[e] !== (desired.view[e] ?? ''));
}
