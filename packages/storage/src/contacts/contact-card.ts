/**
 * 9.5: the structured contact ("Kontakt") model shared by every protocol.
 *
 * vcardData stays the source of truth of a contact; this module defines the
 * structured view of it (names, typed e-mail / phone / address / URL / IM
 * lists, dates, categories) and everything derived from that view: the flat
 * legacy columns (email, email2, phone, mobile …) that JMAP, the GAL search and
 * older readers use, and the search text. Pure — no I/O. The vCard mapping is
 * contact-vcard.ts; REST, CardDAV and (later) ActiveSync all go through both.
 */

export const CONTACT_EMAIL_TYPES = ['work', 'home', 'other'] as const;
export const CONTACT_PHONE_TYPES = ['work', 'home', 'mobile', 'fax', 'pager', 'other'] as const;
export const CONTACT_ADDRESS_TYPES = ['work', 'home', 'other'] as const;
export const CONTACT_URL_TYPES = ['work', 'home', 'other'] as const;
export const CONTACT_IM_TYPES = ['work', 'home', 'other'] as const;

export type ContactEmailType = typeof CONTACT_EMAIL_TYPES[number];
export type ContactPhoneType = typeof CONTACT_PHONE_TYPES[number];
export type ContactAddressType = typeof CONTACT_ADDRESS_TYPES[number];
export type ContactUrlType = typeof CONTACT_URL_TYPES[number];
export type ContactImType = typeof CONTACT_IM_TYPES[number];

/** Size limits shared by the REST validation and the tolerant readers. */
export const CONTACT_LIMITS = {
  /** Entries per typed list (e-mails, phones, …). */
  listEntries: 20,
  text: 500,
  namePart: 200,
  phone: 100,
  uri: 2000,
  notes: 10_000,
  categories: 50,
  category: 60,
} as const;

// Type aliases (not interfaces): the lists are stored as Prisma JSON values.
export type ContactTyped<T extends string> = { type: T; value: string };
export type ContactEmail = ContactTyped<ContactEmailType>;
export type ContactPhone = ContactTyped<ContactPhoneType>;
export type ContactUrl = ContactTyped<ContactUrlType>;
/** value = IMPP URI, e.g. `xmpp:alex@chat.example`, `sip:alex@voip.example`. */
export type ContactIm = ContactTyped<ContactImType>;
export type ContactAddress = {
  type: ContactAddressType;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  poBox: string;
  /** Extended address (c/o, building). */
  extended: string;
};

export type ContactName = { prefix: string; given: string; middle: string; family: string; suffix: string };

export type ContactCard = {
  displayName: string;
  name: ContactName;
  nickname: string;
  /** "Speichern unter"; empty = derived (fileAsOf). */
  fileAs: string;
  company: string;
  department: string;
  jobTitle: string;
  emails: ContactEmail[];
  phones: ContactPhone[];
  addresses: ContactAddress[];
  urls: ContactUrl[];
  ims: ContactIm[];
  /** "YYYY-MM-DD", "--MM-DD" (no year) or "". */
  birthday: string;
  anniversary: string;
  categories: string[];
  notes: string;
};

/** The legacy flat columns of the `contacts` table (JMAP, GAL search, old clients). */
export type FlatContactColumns = {
  displayName: string;
  email: string;
  email2: string;
  phone: string;
  mobile: string;
  company: string;
  department: string;
  jobTitle: string;
  notes: string;
};

export const ADDRESS_FIELDS = ['street', 'city', 'region', 'postalCode', 'country', 'poBox', 'extended'] as const;

export function emptyName(): ContactName {
  return { prefix: '', given: '', middle: '', family: '', suffix: '' };
}

export function emptyContactCard(): ContactCard {
  return {
    displayName: '', name: emptyName(), nickname: '', fileAs: '', company: '', department: '', jobTitle: '',
    emails: [], phones: [], addresses: [], urls: [], ims: [], birthday: '', anniversary: '', categories: [], notes: '',
  };
}

export function emptyAddress(type: ContactAddressType = 'work'): ContactAddress {
  return { type, street: '', city: '', region: '', postalCode: '', country: '', poBox: '', extended: '' };
}

export const isAddressEmpty = (a: ContactAddress): boolean => ADDRESS_FIELDS.every((f) => !a[f].trim());

// ─── Dates ───────────────────────────────────────────────────────────────────

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validDay(year: number | null, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  if (month === 2 && year !== null) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return day <= (leap ? 29 : 28);
  }
  return day <= DAYS_IN_MONTH[month - 1]!;
}

/**
 * Canonical contact date: "YYYY-MM-DD" or "--MM-DD" (year unknown). Accepts the
 * vCard 3/4 spellings (19800517, 1980-05-17, --0517, --05-17, a trailing time)
 * and returns "" for anything that is not a real calendar date.
 */
export function normalizeContactDate(raw: string): string {
  const v = raw.trim().replace(/T.*$/, '');
  let m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDay(y, mo, d) ? `${m[1]}-${m[2]}-${m[3]}` : '';
  }
  m = /^--(\d{2})-?(\d{2})$/.exec(v);
  if (m) return validDay(null, Number(m[1]), Number(m[2])) ? `--${m[1]}-${m[2]}` : '';
  return '';
}

/** True for "" and canonical dates (what the REST API accepts). */
export function isContactDate(v: string): boolean {
  return v === '' || normalizeContactDate(v) === v;
}

// ─── Derived values ──────────────────────────────────────────────────────────

const joinWords = (parts: string[]): string => parts.map((p) => p.trim()).filter(Boolean).join(' ');

/** Display name from the name parts (prefix given middle family suffix). */
export function displayNameFromParts(n: ContactName): string {
  return joinWords([n.prefix, n.given, n.middle, n.family, n.suffix]);
}

/** Name parts from a display name: last word = family name, the rest = given name(s). */
export function namePartsFromDisplayName(displayName: string): ContactName {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return { ...emptyName(), family: words[0] ?? '' };
  return { ...emptyName(), given: words.slice(0, -1).join(' '), family: words[words.length - 1]! };
}

/** "Speichern unter": the explicit value, else "Family, Given", else the display name / company. */
export function fileAsOf(card: ContactCard): string {
  if (card.fileAs.trim()) return card.fileAs.trim();
  const { family, given } = card.name;
  if (family.trim() && given.trim()) return `${family.trim()}, ${given.trim()}`;
  return card.displayName.trim() || displayNameFromParts(card.name) || card.company.trim();
}

/** The first phone that is no mobile / fax / pager number — the legacy `phone` column. */
const isVoice = (p: ContactPhone): boolean => p.type !== 'mobile' && p.type !== 'fax' && p.type !== 'pager';

export function flatContactColumns(card: ContactCard): FlatContactColumns {
  return {
    displayName: card.displayName,
    email: card.emails[0]?.value ?? '',
    email2: card.emails[1]?.value ?? '',
    phone: card.phones.find(isVoice)?.value ?? '',
    mobile: card.phones.find((p) => p.type === 'mobile')?.value ?? '',
    company: card.company,
    department: card.department,
    jobTitle: card.jobTitle,
    notes: card.notes,
  };
}

/** Lower-case text of every searchable field (notes excluded); phones also as digits only. */
export function contactSearchText(card: ContactCard): string {
  const parts = [
    card.displayName, ...Object.values(card.name), card.nickname, card.fileAs, card.company, card.department, card.jobTitle,
    ...card.emails.map((e) => e.value),
    ...card.phones.flatMap((p) => [p.value, p.value.replace(/\D/g, '')]),
    ...card.addresses.flatMap((a) => ADDRESS_FIELDS.map((f) => a[f])),
    ...card.urls.map((u) => u.value), ...card.ims.map((i) => i.value), ...card.categories,
  ];
  return parts.map((p) => p.trim()).filter(Boolean).join('\n').toLowerCase();
}

/** Trimmed, de-duplicated (case-insensitive) category names, in order. */
export function normalizeCategories(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const c = raw.trim();
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    out.push(c);
  }
  return out;
}

/**
 * Fill the derived parts of a card: a missing display name from the name parts
 * (or the company / first e-mail), empty list entries dropped, dates canonical.
 */
export function finalizeContactCard(card: ContactCard): ContactCard {
  const displayName = card.displayName.trim() || displayNameFromParts(card.name)
    || card.company.trim() || (card.emails[0]?.value ?? '');
  return {
    ...card,
    displayName,
    emails: card.emails.filter((e) => e.value.trim()),
    phones: card.phones.filter((p) => p.value.trim()),
    addresses: card.addresses.filter((a) => !isAddressEmpty(a)),
    urls: card.urls.filter((u) => u.value.trim()),
    ims: card.ims.filter((i) => i.value.trim()),
    birthday: normalizeContactDate(card.birthday),
    anniversary: normalizeContactDate(card.anniversary),
    categories: normalizeCategories(card.categories),
  };
}

// ─── Patching (REST, later ActiveSync) ───────────────────────────────────────

/**
 * A partial update of a card. The structured fields replace the whole value
 * (a list replaces the list). The legacy flat fields (email, email2, phone,
 * mobile) address one slot each: email = 1st address, email2 = 2nd, phone = the
 * first voice number, mobile = the first mobile number — the rest is kept.
 */
export type ContactPatch = Partial<Omit<ContactCard, 'name'>> & {
  name?: Partial<ContactName>;
  email?: string;
  email2?: string;
  phone?: string;
  mobile?: string;
};

function setSlot<T extends { value: string }>(list: T[], index: number, value: string, make: (v: string) => T): T[] {
  const v = value.trim();
  const out = [...list];
  if (index < out.length) {
    if (v) out[index] = { ...out[index]!, value: v };
    else out.splice(index, 1);
  } else if (v) {
    out.push(make(v));
  }
  return out;
}

function setPhoneSlot(list: ContactPhone[], pick: (p: ContactPhone) => boolean, value: string, type: ContactPhoneType): ContactPhone[] {
  const i = list.findIndex(pick);
  return setSlot(list, i < 0 ? list.length : i, value, (v) => ({ type, value: v }));
}

const sameText = (a: string, b: string): boolean => a.trim() === b.trim();

/** Apply `patch` to `card` (pure). An unchanged display name never rewrites the name parts. */
export function applyContactPatch(card: ContactCard, patch: ContactPatch): ContactCard {
  const next: ContactCard = { ...card, name: { ...card.name } };
  const scalar = ['nickname', 'fileAs', 'company', 'department', 'jobTitle', 'notes', 'birthday', 'anniversary'] as const;
  for (const k of scalar) {
    const v = patch[k];
    if (v !== undefined) next[k] = v.trim();
  }
  if (patch.emails) next.emails = patch.emails.map((e) => ({ ...e }));
  if (patch.phones) next.phones = patch.phones.map((e) => ({ ...e }));
  if (patch.addresses) next.addresses = patch.addresses.map((e) => ({ ...e }));
  if (patch.urls) next.urls = patch.urls.map((e) => ({ ...e }));
  if (patch.ims) next.ims = patch.ims.map((e) => ({ ...e }));
  if (patch.categories) next.categories = [...patch.categories];
  if (patch.name) next.name = { ...next.name, ...patch.name };

  if (patch.displayName !== undefined && !sameText(patch.displayName, card.displayName)) {
    next.displayName = patch.displayName.trim();
    // A legacy client only sends the display name: the structured name follows it
    if (!patch.name) next.name = namePartsFromDisplayName(next.displayName);
  }
  if (patch.email !== undefined) next.emails = setSlot(next.emails, 0, patch.email, (v) => ({ type: 'other', value: v }));
  if (patch.email2 !== undefined) {
    next.emails = next.emails.length === 0 && patch.email2.trim()
      ? [{ type: 'other', value: patch.email2.trim() }]
      : setSlot(next.emails, 1, patch.email2, (v) => ({ type: 'other', value: v }));
  }
  if (patch.phone !== undefined) next.phones = setPhoneSlot(next.phones, isVoice, patch.phone, 'other');
  if (patch.mobile !== undefined) next.phones = setPhoneSlot(next.phones, (p) => p.type === 'mobile', patch.mobile, 'mobile');
  return finalizeContactCard(next);
}

/** Deep equality of JSON-like values (object key order irrelevant). */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function sameContactCard(a: ContactCard, b: ContactCard): boolean {
  return sameJson(a, b);
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

// ─── Photos ──────────────────────────────────────────────────────────────────

const PHOTO_SIGNATURES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['image/jpeg', [0xff, 0xd8, 0xff]], ['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/gif', [0x47, 0x49, 0x46, 0x38]],
];

/** Media type of contact photo bytes by their signature (JPEG, PNG, GIF); null for anything else. */
export function photoMediaType(data: Uint8Array): string | null {
  return PHOTO_SIGNATURES.find(([, sig]) => sig.every((b, i) => data[i] === b))?.[0] ?? null;
}

// ─── Tolerant reading of the stored JSON columns ─────────────────────────────

const asText = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

function typedList<T extends string>(raw: unknown, types: readonly T[], max: number): Array<ContactTyped<T>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<ContactTyped<T>> = [];
  for (const e of raw.slice(0, CONTACT_LIMITS.listEntries)) {
    if (!e || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    const value = asText(rec['value'], max).trim();
    if (!value) continue;
    const type = (types as readonly string[]).includes(String(rec['type'])) ? (rec['type'] as T) : types[types.length - 1]!;
    out.push({ type, value });
  }
  return out;
}

function addressList(raw: unknown): ContactAddress[] {
  if (!Array.isArray(raw)) return [];
  const out: ContactAddress[] = [];
  for (const e of raw.slice(0, CONTACT_LIMITS.listEntries)) {
    if (!e || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    const type = (CONTACT_ADDRESS_TYPES as readonly string[]).includes(String(rec['type'])) ? (rec['type'] as ContactAddressType) : 'other';
    const a = emptyAddress(type);
    for (const f of ADDRESS_FIELDS) a[f] = asText(rec[f], CONTACT_LIMITS.text);
    if (!isAddressEmpty(a)) out.push(a);
  }
  return out;
}

/** The typed lists of a `contacts` row (malformed JSON entries are dropped, never thrown). */
export function contactListsFromRow(row: { emails?: unknown; phones?: unknown; addresses?: unknown; urls?: unknown; ims?: unknown }): Pick<ContactCard, 'emails' | 'phones' | 'addresses' | 'urls' | 'ims'> {
  return {
    emails: typedList(row.emails, CONTACT_EMAIL_TYPES, CONTACT_LIMITS.text),
    phones: typedList(row.phones, CONTACT_PHONE_TYPES, CONTACT_LIMITS.phone),
    addresses: addressList(row.addresses),
    urls: typedList(row.urls, CONTACT_URL_TYPES, CONTACT_LIMITS.uri),
    ims: typedList(row.ims, CONTACT_IM_TYPES, CONTACT_LIMITS.uri),
  };
}
