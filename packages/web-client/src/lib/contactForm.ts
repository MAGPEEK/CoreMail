/**
 * 9.5: contact form ("Kontakt") of the People module — form state with
 * repeatable typed rows (e-mail, phone, address, web page, chat), the German
 * labels of the types, client-side checks that mirror the server, German date
 * input (with or without year) and the request body. Pure — unit-tested with
 * `node --test`.
 */

export const EMAIL_TYPES = ['work', 'home', 'other'] as const;
export const PHONE_TYPES = ['work', 'home', 'mobile', 'fax', 'pager', 'other'] as const;
export const PLACE_TYPES = ['work', 'home', 'other'] as const;
export type EmailType = typeof EMAIL_TYPES[number];
export type PhoneType = typeof PHONE_TYPES[number];
export type PlaceType = typeof PLACE_TYPES[number];

export const PLACE_TYPE_LABEL: Record<PlaceType, string> = { work: 'Geschäftlich', home: 'Privat', other: 'Weitere' };
export const PHONE_TYPE_LABEL: Record<PhoneType, string> = {
  work: 'Geschäftlich', home: 'Privat', mobile: 'Mobil', fax: 'Fax', pager: 'Pager', other: 'Weitere',
};

export interface TypedEntry<T extends string> { type: T; value: string }
export interface AddressEntry {
  type: PlaceType;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  poBox: string;
  extended: string;
}
export interface ContactName { prefix: string; given: string; middle: string; family: string; suffix: string }

/** A contact as GET /contacts/:id returns it (9.5 fields; older servers miss them). */
export interface ContactDetail {
  id: string;
  displayName: string;
  name?: ContactName;
  nickname?: string;
  fileAs?: string;
  company: string;
  department: string;
  jobTitle: string;
  notes: string;
  email: string;
  email2: string;
  phone: string;
  mobile: string;
  emails?: Array<TypedEntry<EmailType>>;
  phones?: Array<TypedEntry<PhoneType>>;
  addresses?: AddressEntry[];
  urls?: Array<TypedEntry<PlaceType>>;
  ims?: Array<TypedEntry<PlaceType>>;
  birthday?: string;
  anniversary?: string;
  categories?: string[];
}

/** A form row: the entry plus a stable key for React lists. */
export type Row<T> = T & { key: string };

export interface ContactForm {
  displayName: string;
  name: ContactName;
  nickname: string;
  fileAs: string;
  company: string;
  department: string;
  jobTitle: string;
  emails: Array<Row<TypedEntry<EmailType>>>;
  phones: Array<Row<TypedEntry<PhoneType>>>;
  addresses: Array<Row<AddressEntry>>;
  urls: Array<Row<TypedEntry<PlaceType>>>;
  ims: Array<Row<TypedEntry<PlaceType>>>;
  /** German input: "TT.MM.JJJJ" or "TT.MM." (no year). */
  birthday: string;
  anniversary: string;
  categories: string[];
  notes: string;
}

export type ListField = 'emails' | 'phones' | 'addresses' | 'urls' | 'ims';
export const MAX_ROWS = 20;

let keySeq = 0;
const withKey = <T extends object>(e: T): Row<T> => ({ ...e, key: `r${++keySeq}` });

export const emptyName = (): ContactName => ({ prefix: '', given: '', middle: '', family: '', suffix: '' });
export const emptyAddress = (type: PlaceType = 'work'): AddressEntry =>
  ({ type, street: '', city: '', region: '', postalCode: '', country: '', poBox: '', extended: '' });

// ─── Dates ───────────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

function validDay(year: number | null, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const max = new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate(); // 2000: leap year → 29.02. without year
  return day <= max;
}

/** "17.05.1980" → "1980-05-17", "17.05." / "17.5" → "--05-17", "" → "", anything else → null. */
export function parseGermanDate(input: string): string | null {
  const v = input.trim();
  if (!v) return '';
  const m = /^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/.exec(v);
  if (!m) return null;
  const [day, month] = [Number(m[1]), Number(m[2])];
  const year = m[3] ? Number(m[3]) : null;
  if (!validDay(year, month, day)) return null;
  return year === null ? `--${pad(month)}-${pad(day)}` : `${m[3]}-${pad(month)}-${pad(day)}`;
}

/** "1980-05-17" → "17.05.1980", "--05-17" → "17.05.", "" → "". */
export function formatGermanDate(value: string | undefined): string {
  if (!value) return '';
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  m = /^--(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[2]}.${m[1]}.` : value;
}

// ─── Form ↔ contact ──────────────────────────────────────────────────────────

/** Typed lists of a contact; a pre-9.5 server only has the flat fields. */
function listsOf(c: ContactDetail): Pick<ContactDetail, ListField> {
  return {
    emails: c.emails ?? [
      ...(c.email ? [{ type: 'other' as const, value: c.email }] : []),
      ...(c.email2 ? [{ type: 'other' as const, value: c.email2 }] : []),
    ],
    phones: c.phones ?? [
      ...(c.phone ? [{ type: 'other' as const, value: c.phone }] : []),
      ...(c.mobile ? [{ type: 'mobile' as const, value: c.mobile }] : []),
    ],
    addresses: c.addresses ?? [],
    urls: c.urls ?? [],
    ims: c.ims ?? [],
  };
}

export function emptyContactForm(): ContactForm {
  return {
    displayName: '', name: emptyName(), nickname: '', fileAs: '', company: '', department: '', jobTitle: '',
    emails: [withKey({ type: 'work', value: '' })], phones: [withKey({ type: 'work', value: '' })],
    addresses: [], urls: [], ims: [], birthday: '', anniversary: '', categories: [], notes: '',
  };
}

export function formFromContact(c: ContactDetail): ContactForm {
  const lists = listsOf(c);
  return {
    displayName: c.displayName,
    name: { ...emptyName(), ...(c.name ?? {}) },
    nickname: c.nickname ?? '',
    fileAs: c.fileAs ?? '',
    company: c.company,
    department: c.department,
    jobTitle: c.jobTitle,
    emails: (lists.emails ?? []).map(withKey),
    phones: (lists.phones ?? []).map(withKey),
    addresses: (lists.addresses ?? []).map((a) => withKey({ ...emptyAddress(a.type), ...a })),
    urls: (lists.urls ?? []).map(withKey),
    ims: (lists.ims ?? []).map(withKey),
    birthday: formatGermanDate(c.birthday),
    anniversary: formatGermanDate(c.anniversary),
    categories: [...(c.categories ?? [])],
    notes: c.notes,
  };
}

const DEFAULT_TYPE: Record<ListField, string> = { emails: 'work', phones: 'mobile', addresses: 'work', urls: 'work', ims: 'other' };

/** Add an empty row (no-op at MAX_ROWS). */
export function addRow<K extends ListField>(form: ContactForm, field: K): ContactForm {
  if (form[field].length >= MAX_ROWS) return form;
  const row = field === 'addresses'
    ? withKey(emptyAddress())
    : withKey({ type: DEFAULT_TYPE[field], value: '' });
  return { ...form, [field]: [...form[field], row] };
}

export function removeRow(form: ContactForm, field: ListField, key: string): ContactForm {
  return { ...form, [field]: (form[field] as Array<{ key: string }>).filter((r) => r.key !== key) };
}

/** Change fields of one row (`type` values come from the row's own type list). */
export function updateRow(form: ContactForm, field: ListField, key: string, patch: Readonly<Record<string, string>>): ContactForm {
  return { ...form, [field]: (form[field] as Array<{ key: string }>).map((r) => (r.key === key ? { ...r, ...patch } : r)) };
}

/** Name shown for the contact: the typed display name, else the name parts / company / first e-mail. */
export function effectiveDisplayName(form: ContactForm): string {
  const parts = [form.name.prefix, form.name.given, form.name.middle, form.name.family, form.name.suffix].map((s) => s.trim()).filter(Boolean);
  return form.displayName.trim() || parts.join(' ') || form.company.trim() || (form.emails.find((e) => e.value.trim())?.value.trim() ?? '');
}

// ─── Checks (mirror the server) ──────────────────────────────────────────────

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const PHONE_RE = /^[+\d\s()\-./#*,;A-Za-z]+$/;
const IM_RE = /^([a-z][a-z0-9+.-]*):\S+$/i;
const UNSAFE_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file']);

export function isWebUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Problems keyed by field path ("emails.<key>", "birthday", …), German texts. Empty = valid. */
export function validateContactForm(form: ContactForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!effectiveDisplayName(form)) errors['displayName'] = 'Bitte einen Namen, eine Firma oder eine E-Mail-Adresse angeben.';
  for (const e of form.emails) {
    if (e.value.trim() && !EMAIL_RE.test(e.value.trim())) errors[`emails.${e.key}`] = 'Keine gültige E-Mail-Adresse.';
  }
  for (const p of form.phones) {
    const v = p.value.trim();
    if (v && (!PHONE_RE.test(v) || !/\d/.test(v))) errors[`phones.${p.key}`] = 'Keine gültige Telefonnummer.';
  }
  for (const u of form.urls) {
    if (u.value.trim() && !isWebUrl(u.value.trim())) errors[`urls.${u.key}`] = 'Webadresse mit http:// oder https:// angeben.';
  }
  for (const i of form.ims) {
    const m = IM_RE.exec(i.value.trim());
    if (i.value.trim() && (!m || UNSAFE_SCHEMES.has(m[1]!.toLowerCase()))) errors[`ims.${i.key}`] = 'Mit Dienst angeben, z. B. xmpp:name@server.';
  }
  for (const f of ['birthday', 'anniversary'] as const) {
    if (parseGermanDate(form[f]) === null) errors[f] = 'Datum als TT.MM.JJJJ oder TT.MM. angeben.';
  }
  return errors;
}

const strip = <T extends { key: string }>(r: T): Omit<T, 'key'> => {
  const { key: _key, ...rest } = r;
  return rest;
};
const trimmed = <T extends { value: string; key: string }>(rows: T[]) =>
  rows.filter((r) => r.value.trim()).map((r) => ({ ...strip(r), value: r.value.trim() }));

/** Request body for POST / PUT /contacts (call after validateContactForm()). */
export function contactPayload(form: ContactForm): Record<string, unknown> {
  const name = Object.fromEntries(Object.entries(form.name).map(([k, v]) => [k, v.trim()]));
  return {
    displayName: effectiveDisplayName(form),
    name,
    nickname: form.nickname.trim(),
    fileAs: form.fileAs.trim(),
    company: form.company.trim(),
    department: form.department.trim(),
    jobTitle: form.jobTitle.trim(),
    emails: trimmed(form.emails),
    phones: trimmed(form.phones),
    addresses: form.addresses
      .map((a) => strip(a))
      .filter((a) => [a.street, a.city, a.region, a.postalCode, a.country, a.poBox, a.extended].some((v) => v.trim())),
    urls: trimmed(form.urls),
    ims: trimmed(form.ims),
    birthday: parseGermanDate(form.birthday) ?? '',
    anniversary: parseGermanDate(form.anniversary) ?? '',
    categories: form.categories,
    notes: form.notes,
  };
}

/** One-line postal address for the detail view. */
export function addressLines(a: AddressEntry): string[] {
  return [a.extended, a.street, a.poBox && `Postfach ${a.poBox}`, [a.postalCode, a.city].filter(Boolean).join(' '), a.region, a.country]
    .map((s) => s.trim())
    .filter(Boolean);
}
