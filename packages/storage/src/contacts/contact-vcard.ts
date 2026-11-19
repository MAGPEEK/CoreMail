/**
 * 9.5: vCard 3.0 / 4.0 ↔ structured contact (contact-card.ts).
 *
 *  - contactCardFromVcard(): N, FN, NICKNAME, ORG, TITLE, NOTE, EMAIL/TEL/ADR/URL/IMPP
 *    with TYPE, BDAY, ANNIVERSARY (also X-ANNIVERSARY and the Apple
 *    X-ABDATE + X-ABLabel form), CATEGORIES and the "file as" value.
 *  - applyContactCard(): writes a card into a stored vCard. A property whose
 *    field did not change keeps its source line verbatim; within a list an
 *    entry that did not change keeps its line (group, PREF, labels); every
 *    property CoreMail does not model (PHOTO, X-…, grouped labels) survives.
 *  - contactColumnsFromVcard(): the ONE place the `contacts` columns (flat +
 *    structured + search text) are derived from vcardData.
 */
import { randomUUID } from 'node:crypto';
import { escapeText, unescapeText } from '@coremail/core/calendar';
import {
  parseVcard, serializeVcard, splitStructured, vcardProperty,
  type VcardDocument, type VcardProperty,
} from '@coremail/core/vcard';
import {
  emptyContactCard, finalizeContactCard, flatContactColumns, contactSearchText, namePartsFromDisplayName, normalizeContactDate,
  photoMediaType, sameContactCard, sameJson as same,
  type ContactAddress, type ContactAddressType, type ContactCard, type ContactEmail, type ContactEmailType, type ContactIm,
  type ContactName, type ContactPhone, type ContactPhoneType, type ContactUrl, type FlatContactColumns,
} from './contact-card.js';

/** Property CoreMail writes the "file as" value to; X-EVOLUTION-FILE-AS is read as well. */
export const FILE_AS_PROPERTY = 'X-FILE-AS';
const FILE_AS_READ = [FILE_AS_PROPERTY, 'X-EVOLUTION-FILE-AS'];
const ANNIVERSARY_READ = ['ANNIVERSARY', 'X-ANNIVERSARY'];
/** Apple writes a year-less date with this marker year. */
const APPLE_NO_YEAR = '1604';

const EMPTY_V3 = 'BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n';

// ─── Small helpers ───────────────────────────────────────────────────────────

/** UID without the "urn:uuid:" prefix — how group members reference a card. */
export function uidKey(uid: string): string {
  return uid.trim().replace(/^urn:uuid:/i, '');
}

export function isVcard4(doc: VcardDocument): boolean {
  return (doc.properties.find((p) => p.name === 'VERSION')?.value.trim() ?? '3.0').startsWith('4');
}

const text = (p: VcardProperty | undefined): string => (p ? unescapeText(p.value).trim() : '');
/** URI values: Apple escapes ':' in vCard 3 URLs (`http\://…`). */
const uriText = (p: VcardProperty): string => p.value.replace(/\\([\\;,:])/g, '$1').trim();
const cleanUri = (v: string): string => v.replace(/[\r\n]/g, '').trim();

/** The name/parameter part of a property line (everything before the first unquoted colon). */
function headOf(p: VcardProperty): string {
  let inQuotes = false;
  for (let i = 0; i < p.raw.length; i++) {
    if (p.raw[i] === '"') inQuotes = !inQuotes;
    else if (p.raw[i] === ':' && !inQuotes) return p.raw.slice(0, i);
  }
  return p.raw;
}

function prop(raw: string): VcardProperty {
  const p = vcardProperty(raw);
  if (!p) throw new Error(`not a vCard property: ${raw.slice(0, 40)}`);
  return p;
}

const groupPrefix = (p: VcardProperty): string => (p.group ? `${p.group}.` : '');

function placeType(types: string[]): 'work' | 'home' | 'other' {
  if (types.includes('WORK')) return 'work';
  if (types.includes('HOME')) return 'home';
  return 'other';
}

function phoneType(types: string[]): ContactPhoneType {
  if (types.includes('CELL')) return 'mobile';
  if (types.includes('FAX')) return 'fax';
  if (types.includes('PAGER')) return 'pager';
  return placeType(types);
}

/**
 * Kinds of numbers the card has no type of their own for (ActiveSync has a slot for each):
 * the card shows car / radio / assistant / company main numbers as `other` and both fax
 * kinds as `fax`; the vCard keeps the kind in a TEL TYPE value (vCard 3 CAR, x-names for
 * the rest; WORK / HOME next to FAX), so the number comes back in the same slot.
 */
export const CONTACT_PHONE_KINDS = ['car', 'radio', 'assistant', 'company-main', 'work-fax', 'home-fax'] as const;
/** A phone kind; '' = none beyond the card type. */
export type ContactPhoneKind = typeof CONTACT_PHONE_KINDS[number] | '';

/** TYPE value of the kinds of an `other` number. */
const OTHER_KIND_TYPE: Readonly<Record<string, string>> = {
  car: 'CAR', radio: 'X-RADIO', assistant: 'X-ASSISTANT', 'company-main': 'X-COMPANY-MAIN',
};

function phoneKind(types: string[]): ContactPhoneKind {
  const type = phoneType(types);
  if (type === 'fax') return types.includes('WORK') ? 'work-fax' : types.includes('HOME') ? 'home-fax' : '';
  if (type !== 'other') return '';
  return CONTACT_PHONE_KINDS.find((k) => OTHER_KIND_TYPE[k] !== undefined && types.includes(OTHER_KIND_TYPE[k])) ?? '';
}

/** True when a number of card type `type` can have `kind`. */
function kindFits(type: ContactPhoneType, kind: ContactPhoneKind): boolean {
  if (kind === '') return true;
  return kind.endsWith('-fax') ? type === 'fax' : type === 'other';
}

/** Label of an Apple grouped property (`item1.X-ABLabel:_$!<Anniversary>!$_`). */
function appleLabel(doc: VcardDocument, group: string | null): string {
  if (!group) return '';
  return text(doc.properties.find((p) => p.group === group && p.name === 'X-ABLABEL'));
}

function readDate(p: VcardProperty | undefined): string {
  if (!p) return '';
  const value = p.value.trim();
  const omit = p.params['X-APPLE-OMIT-YEAR'];
  if (omit && value.startsWith(omit)) {
    const d = normalizeContactDate(value);
    return d ? `--${d.slice(5)}` : '';
  }
  return normalizeContactDate(value);
}

function anniversaryProperty(doc: VcardDocument): VcardProperty | undefined {
  return doc.properties.find((p) => ANNIVERSARY_READ.includes(p.name))
    ?? doc.properties.find((p) => p.name === 'X-ABDATE' && /anniversary/i.test(appleLabel(doc, p.group)));
}

function splitCategories(value: string): string[] {
  return value.split(/(?<!\\),/).map((c) => unescapeText(c).trim()).filter(Boolean);
}

// ─── Reading ─────────────────────────────────────────────────────────────────

function readName(doc: VcardDocument): ContactName {
  const n = doc.properties.find((p) => p.name === 'N');
  const [family = '', given = '', middle = '', prefix = '', suffix = ''] = n
    ? splitStructured(n.value).map((s) => unescapeText(s).trim()) : [];
  return { prefix, given, middle, family, suffix };
}

function readAddress(p: VcardProperty): ContactAddress {
  const [poBox = '', extended = '', street = '', city = '', region = '', postalCode = '', country = '']
    = splitStructured(p.value).map((s) => unescapeText(s).trim());
  return { type: placeType(p.types) as ContactAddressType, street, city, region, postalCode, country, poBox, extended };
}

const readEmail = (p: VcardProperty): ContactEmail => ({ type: placeType(p.types) as ContactEmailType, value: text(p) });
const readPhone = (p: VcardProperty): ContactPhone => ({ type: phoneType(p.types), value: text(p).replace(/^tel:/i, '').trim() });
/** The TEL properties behind `card.phones` (an empty number is no entry). */
const phoneProps = (props: readonly VcardProperty[]): VcardProperty[] => props.filter((p) => p.name === 'TEL' && readPhone(p).value !== '');
const readUrl = (p: VcardProperty): ContactUrl => ({ type: placeType(p.types), value: uriText(p) });
const readIm = (p: VcardProperty): ContactIm => ({ type: placeType(p.types), value: uriText(p) });

function cardFromDoc(doc: VcardDocument): ContactCard {
  const of = (name: string) => doc.properties.filter((p) => p.name === name);
  const org = doc.properties.find((p) => p.name === 'ORG');
  const [company = '', department = ''] = org ? splitStructured(org.value).map((s) => unescapeText(s).trim()) : [];
  return finalizeContactCard({
    ...emptyContactCard(),
    displayName: text(of('FN')[0]),
    name: readName(doc),
    nickname: text(of('NICKNAME')[0]),
    fileAs: text(doc.properties.find((p) => FILE_AS_READ.includes(p.name))),
    company,
    department,
    jobTitle: text(of('TITLE')[0]),
    emails: of('EMAIL').map(readEmail),
    phones: of('TEL').map(readPhone),
    addresses: of('ADR').map(readAddress),
    urls: of('URL').map(readUrl),
    ims: of('IMPP').map(readIm),
    birthday: readDate(of('BDAY')[0]),
    anniversary: readDate(anniversaryProperty(doc)),
    categories: of('CATEGORIES').flatMap((p) => splitCategories(p.value)),
    notes: text(of('NOTE')[0]),
  });
}

/** The structured contact of a vCard (an empty card when `vcard` holds none). */
export function contactCardFromVcard(vcard: string): ContactCard {
  const doc = parseVcard(vcard);
  return doc ? cardFromDoc(doc) : finalizeContactCard(emptyContactCard());
}

/** The flat columns a `contacts` row may carry next to its vCard. */
export type ContactRowFlat = { vcardData: string } & Partial<Record<keyof FlatContactColumns, string | null>>;

/**
 * The card of a `contacts` row: read from its vCard. A row whose vcardData
 * holds no vCard at all (written outside today's writers) falls back to its
 * flat columns, so the next write of the row keeps what it showed.
 */
export function contactCardFromRow(row: ContactRowFlat): ContactCard {
  if (parseVcard(row.vcardData)) return contactCardFromVcard(row.vcardData);
  const v = (k: keyof FlatContactColumns): string => (row[k] ?? '').trim();
  const typedOf = <T extends string>(pairs: Array<[T, string]>) => pairs.filter(([, value]) => value).map(([type, value]) => ({ type, value }));
  return finalizeContactCard({
    ...emptyContactCard(),
    displayName: v('displayName'),
    name: namePartsFromDisplayName(v('displayName')),
    company: v('company'),
    department: v('department'),
    jobTitle: v('jobTitle'),
    notes: v('notes'),
    emails: typedOf<ContactEmailType>([['other', v('email')], ['other', v('email2')]]),
    phones: typedOf<ContactPhoneType>([['other', v('phone')], ['mobile', v('mobile')]]),
  });
}

/** The vCard UID as group members reference it ("" when absent). */
export function vcardUidKey(vcard: string): string {
  const uid = parseVcard(vcard)?.properties.find((p) => p.name === 'UID');
  return uid ? uidKey(uid.value) : '';
}

// ─── Writing ─────────────────────────────────────────────────────────────────

function placeParam(type: 'work' | 'home' | 'other', v4: boolean): string {
  if (type === 'other') return '';
  return `;TYPE=${v4 ? type : type.toUpperCase()}`;
}

const PHONE_TYPE_PARAM: Record<ContactPhoneType, string> = {
  work: 'work,voice', home: 'home,voice', mobile: 'cell', fax: 'fax', pager: 'pager', other: 'voice',
};

function emailLine(e: ContactEmail, v4: boolean): string {
  const param = v4 ? placeParam(e.type, true) : `;TYPE=INTERNET${e.type === 'other' ? '' : `,${e.type.toUpperCase()}`}`;
  return `EMAIL${param}:${escapeText(e.value)}`;
}
function phoneLine(p: ContactPhone, v4: boolean, kind: ContactPhoneKind = ''): string {
  const t = kind === '' || !kindFits(p.type, kind) ? PHONE_TYPE_PARAM[p.type]
    : kind.endsWith('-fax') ? `${kind.slice(0, -4)},fax` : `${OTHER_KIND_TYPE[kind]!.toLowerCase()},voice`;
  return `TEL;TYPE=${v4 ? t : t.toUpperCase()}:${escapeText(p.value)}`;
}
function addressLine(a: ContactAddress, v4: boolean): string {
  const parts = [a.poBox, a.extended, a.street, a.city, a.region, a.postalCode, a.country].map((s) => escapeText(s.trim()));
  return `ADR${placeParam(a.type, v4)}:${parts.join(';')}`;
}
const urlLine = (u: ContactUrl, v4: boolean): string => `URL${placeParam(u.type, v4)}:${cleanUri(u.value)}`;
const imLine = (i: ContactIm, v4: boolean): string => `IMPP${placeParam(i.type, v4)}:${cleanUri(i.value)}`;

/** Date property value (+ parameters) in the spelling of the vCard version. */
function dateHead(name: string, value: string, v4: boolean): string {
  const noYear = value.startsWith('--');
  if (v4) return `${name}:${noYear ? `--${value.slice(2).replace('-', '')}` : value.replace(/-/g, '')}`;
  return noYear ? `${name};X-APPLE-OMIT-YEAR=${APPLE_NO_YEAR}:${APPLE_NO_YEAR}-${value.slice(2)}` : `${name}:${value}`;
}


/** Mutable property list with the editing primitives the writer needs. */
class PropertyList {
  constructor(public props: VcardProperty[]) {}

  first(names: string | string[]): VcardProperty | undefined {
    const set = Array.isArray(names) ? names : [names];
    return this.props.find((p) => set.includes(p.name));
  }

  /** Replace the value of the first `names` property (head kept), add `fresh` when absent, remove on "". */
  setValue(names: string | string[], value: string, fresh: () => string, dropOthers = false): void {
    const set = Array.isArray(names) ? names : [names];
    const current = this.first(set);
    if (dropOthers) this.props = this.props.filter((p) => p === current || !set.includes(p.name));
    if (!value) { this.props = this.props.filter((p) => !set.includes(p.name)); return; }
    if (current) this.replace(current, prop(`${headOf(current)}:${value}`));
    else this.props.push(prop(fresh()));
  }

  replace(old: VcardProperty, next: VcardProperty): void {
    this.props = this.props.map((p) => (p === old ? next : p));
  }

  remove(pred: (p: VcardProperty) => boolean): void {
    this.props = this.props.filter((p) => !pred(p));
  }

  /**
   * Rebuild the `name` properties from `desired`. An unchanged entry keeps its
   * source line; an entry whose value changed at the same position and type
   * keeps the line's group and parameters (PREF, labels); the rest is new.
   * With `kinds` (phones written by ActiveSync) a kept line also needs the same kind.
   */
  reconcile<E extends { type: string }>(
    name: string, read: (p: VcardProperty) => E, desired: E[], line: (e: E, i: number) => string,
    kinds?: { of: (p: VcardProperty) => string; want: readonly string[] },
  ): void {
    const existing = this.props.filter((p) => p.name === name);
    const used = new Set<VcardProperty>();
    const sameKind = (p: VcardProperty, i: number): boolean => !kinds || kinds.of(p) === (kinds.want[i] ?? '');
    const exact = desired.map((d, i) => {
      const hit = existing.find((p) => !used.has(p) && same(read(p), d) && sameKind(p, i));
      if (hit) used.add(hit);
      return hit;
    });
    const out = desired.map((d, i) => {
      const hit = exact[i];
      if (hit) return hit;
      const slot = existing[i];
      // (not for VALUE=uri lines: `tel:` URIs have their own syntax)
      if (slot && !used.has(slot) && !slot.params['VALUE'] && read(slot).type === d.type && sameKind(slot, i)) {
        used.add(slot);
        const fresh = line(d, i);
        return prop(`${headOf(slot)}:${fresh.slice(fresh.indexOf(':') + 1)}`);
      }
      return prop(line(d, i));
    });
    const at = this.props.findIndex((p) => p.name === name);
    const rest = this.props.filter((p) => p.name !== name);
    rest.splice(at < 0 ? rest.length : at, 0, ...out);
    this.props = rest;
  }

  /** Apple labels (`itemN.X-ABLabel`) whose grouped property is gone. */
  dropOrphanLabels(): void {
    const groups = new Set(this.props.filter((p) => p.group && p.name !== 'X-ABLABEL').map((p) => p.group));
    this.remove((p) => p.name === 'X-ABLABEL' && !!p.group && !groups.has(p.group));
  }
}

function writeName(list: PropertyList, card: ContactCard): void {
  const n = Object.values(card.name).some((v) => v.trim()) ? card.name : namePartsFromDisplayName(card.displayName);
  const value = [n.family, n.given, n.middle, n.prefix, n.suffix].map((s) => escapeText(s.trim())).join(';');
  list.setValue('N', value || ';;;;', () => `N:${value || ';;;;'}`);
}

function writeOrg(list: PropertyList, card: ContactCard): void {
  const org = list.first('ORG');
  const parts = org ? splitStructured(org.value) : [];
  parts[0] = escapeText(card.company.trim());
  parts[1] = escapeText(card.department.trim());
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  const value = parts.join(';');
  list.setValue('ORG', value, () => `ORG:${value}`);
}

function writeDate(list: PropertyList, field: 'birthday' | 'anniversary', value: string, v4: boolean): void {
  const current = field === 'birthday' ? list.first('BDAY') : anniversaryProperty({ properties: list.props });
  const name = current?.name ?? (field === 'birthday' ? 'BDAY' : v4 ? 'ANNIVERSARY' : 'X-ANNIVERSARY');
  if (!value) {
    if (current) list.remove((p) => p === current);
    return;
  }
  const line = `${current ? groupPrefix(current) : ''}${dateHead(name, value, v4 && name !== 'X-ABDATE' && name !== 'X-ANNIVERSARY')}`;
  if (current) list.replace(current, prop(line));
  else list.props.push(prop(line));
}

/** Options of applyContactCard. */
export interface ApplyContactOptions {
  /**
   * The kind of each `card.phones` entry (same order; missing = none). Without it the kinds
   * stay as the vCard has them (REST, CardDAV); with it (ActiveSync) they are written too.
   */
  phoneKinds?: readonly ContactPhoneKind[];
}

/** The kinds of the numbers finalizeContactCard keeps (it drops empty ones); a kind the type cannot have is none. */
function keptPhoneKinds(phones: readonly ContactPhone[], kinds: readonly ContactPhoneKind[]): ContactPhoneKind[] {
  return phones.flatMap((p, i) => {
    const kind = kinds[i] ?? '';
    return p.value.trim() ? [kindFits(p.type, kind) ? kind : ''] : [];
  });
}

/**
 * Write `card` into the stored vCard `vcard` (a new vCard 3.0 when it holds
 * none). Only the fields that differ from what `vcard` already says are
 * rewritten; a missing VERSION / FN / N / UID is added.
 */
export function applyContactCard(vcard: string, card: ContactCard, options: ApplyContactOptions = {}): string {
  const doc = parseVcard(vcard) ?? parseVcard(EMPTY_V3)!;
  const before = cardFromDoc(doc);
  const next = finalizeContactCard(card);
  const v4 = isVcard4(doc);
  const list = new PropertyList([...doc.properties]);
  const changed = <K extends keyof ContactCard>(k: K): boolean => !same(before[k], next[k]);
  const kinds = options.phoneKinds ? keptPhoneKinds(card.phones, options.phoneKinds) : undefined;
  const kindsChanged = kinds !== undefined && !same(phoneProps(doc.properties).map((p) => phoneKind(p.types)), kinds);

  if (changed('displayName')) list.setValue('FN', escapeText(next.displayName), () => `FN:${escapeText(next.displayName)}`);
  const hasParts = Object.values(next.name).some((v) => v.trim());
  if (changed('name') || !list.first('N') || (changed('displayName') && !hasParts)) writeName(list, next);
  if (changed('nickname')) list.setValue('NICKNAME', escapeText(next.nickname), () => `NICKNAME:${escapeText(next.nickname)}`);
  if (changed('fileAs')) list.setValue(FILE_AS_READ, escapeText(next.fileAs), () => `${FILE_AS_PROPERTY}:${escapeText(next.fileAs)}`);
  if (changed('company') || changed('department')) writeOrg(list, next);
  if (changed('jobTitle')) list.setValue('TITLE', escapeText(next.jobTitle), () => `TITLE:${escapeText(next.jobTitle)}`);
  if (changed('notes')) list.setValue('NOTE', escapeText(next.notes), () => `NOTE:${escapeText(next.notes)}`);
  if (changed('categories')) {
    const value = next.categories.map(escapeText).join(',');
    list.setValue('CATEGORIES', value, () => `CATEGORIES:${value}`, true);
  }
  if (changed('birthday')) writeDate(list, 'birthday', next.birthday, v4);
  if (changed('anniversary')) writeDate(list, 'anniversary', next.anniversary, v4);

  if (changed('emails')) list.reconcile('EMAIL', readEmail, next.emails, (e) => emailLine(e, v4));
  if (changed('phones') || kindsChanged) {
    const byKind = kinds && { of: (p: VcardProperty) => phoneKind(p.types), want: kinds };
    list.reconcile('TEL', readPhone, next.phones, (p, i) => phoneLine(p, v4, kinds?.[i]), byKind);
  }
  if (changed('addresses')) list.reconcile('ADR', readAddress, next.addresses, (a) => addressLine(a, v4));
  if (changed('urls')) list.reconcile('URL', readUrl, next.urls, (u) => urlLine(u, v4));
  if (changed('ims')) list.reconcile('IMPP', readIm, next.ims, (i) => imLine(i, v4));
  list.dropOrphanLabels();

  if (!list.first('VERSION')) list.props.unshift(prop('VERSION:3.0'));
  if (!list.first('FN')) list.props.push(prop(`FN:${escapeText(next.displayName)}`));
  if (!list.first('UID')) list.props.push(prop(`UID:urn:uuid:${randomUUID()}`));
  return serializeVcard({ properties: list.props });
}

/** A fresh vCard 3.0 for `card` (FN, N, UID + every non-empty field). */
export function buildContactVcard(card: ContactCard): string {
  return applyContactCard(EMPTY_V3, card);
}

// ─── Properties outside the card (ActiveSync fields) ─────────────────────────

/** Office location of a contact (ActiveSync OfficeLocation; no standard vCard property). */
export const OFFICE_LOCATION_PROPERTY = 'X-OFFICE-LOCATION';

const docOf = (vcard: string): VcardDocument => parseVcard(vcard) ?? parseVcard(EMPTY_V3)!;

/** Unescaped text of the first `name` property ("" when absent). */
export function vcardText(vcard: string, name: string): string {
  return text(parseVcard(vcard)?.properties.find((p) => p.name === name));
}

/**
 * `vcard` with its `name` property set to `value`: the first one keeps its group and
 * parameters, further ones are dropped; "" removes them all. Everything else is untouched.
 */
export function setVcardText(vcard: string, name: string, value: string): string {
  const list = new PropertyList([...docOf(vcard).properties]);
  const escaped = escapeText(value.trim());
  list.setValue(name, escaped, () => `${name}:${escaped}`, true);
  return serializeVcard({ properties: list.props });
}

/** An inline contact photo. */
export type VcardPhoto = { mediaType: string; data: Buffer };

/** Base64 text → bytes; null unless it is strict base64 of an image CoreMail recognises. */
function decodePhoto(b64: string): VcardPhoto | null {
  const clean = b64.replace(/\s+/g, '');
  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  const data = Buffer.from(clean, 'base64');
  const mediaType = photoMediaType(data);
  return mediaType ? { mediaType, data } : null;
}

/**
 * The inline PHOTO of a vCard: vCard 3 `PHOTO;ENCODING=b` (also 2.1 `ENCODING=BASE64`) or a
 * vCard 4 `data:` URI. Null for none, a photo by reference (URL) or unrecognised data.
 */
export function vcardPhoto(vcard: string): VcardPhoto | null {
  const p = parseVcard(vcard)?.properties.find((x) => x.name === 'PHOTO');
  if (!p) return null;
  const dataUri = /^data:[^,]*;base64,(.*)$/is.exec(p.value.trim());
  if (dataUri) return decodePhoto(dataUri[1]!);
  const encoding = (p.params['ENCODING'] ?? '').toUpperCase();
  return encoding === 'B' || encoding === 'BASE64' ? decodePhoto(p.value) : null;
}

/** `vcard` with its PHOTO replaced by `photo` (in the spelling of the vCard version); null removes it. */
export function setVcardPhoto(vcard: string, photo: VcardPhoto | null): string {
  const doc = docOf(vcard);
  const list = new PropertyList([...doc.properties]);
  const b64 = photo?.data.toString('base64') ?? '';
  const subtype = photo?.mediaType.split('/')[1]?.toUpperCase() ?? 'JPEG';
  const line = isVcard4(doc) ? `PHOTO:data:${photo?.mediaType};base64,${b64}` : `PHOTO;ENCODING=b;TYPE=${subtype}:${b64}`;
  list.remove((p) => p.name === 'PHOTO');
  if (photo) list.props.push(prop(line));
  return serializeVcard({ properties: list.props });
}

/** The kind of each number of `contactCardFromVcard(vcard).phones` (same order; [] without a vCard). */
export function vcardPhoneKinds(vcard: string): ContactPhoneKind[] {
  const doc = parseVcard(vcard);
  return doc ? phoneProps(doc.properties).map((p) => phoneKind(p.types)) : [];
}

/** True when `card` says the same as the stored vCard (nothing to write). */
export function vcardSaysCard(vcard: string, card: ContactCard): boolean {
  return sameContactCard(contactCardFromVcard(vcard), finalizeContactCard(card));
}

// ─── Table columns ───────────────────────────────────────────────────────────

/** Every derived column of the `contacts` table (Prisma create / update data). */
export type ContactColumns = FlatContactColumns & {
  uid: string;
  givenName: string;
  familyName: string;
  middleName: string;
  namePrefix: string;
  nameSuffix: string;
  nickname: string;
  fileAs: string;
  birthday: string;
  anniversary: string;
  categories: string[];
  emails: ContactEmail[];
  phones: ContactPhone[];
  addresses: ContactAddress[];
  urls: ContactUrl[];
  ims: ContactIm[];
  searchText: string;
};

export function contactColumns(card: ContactCard, uid: string): ContactColumns {
  return {
    ...flatContactColumns(card),
    uid,
    givenName: card.name.given,
    familyName: card.name.family,
    middleName: card.name.middle,
    namePrefix: card.name.prefix,
    nameSuffix: card.name.suffix,
    nickname: card.nickname,
    fileAs: card.fileAs,
    birthday: card.birthday,
    anniversary: card.anniversary,
    categories: card.categories,
    emails: card.emails,
    phones: card.phones,
    addresses: card.addresses,
    urls: card.urls,
    ims: card.ims,
    searchText: contactSearchText(card),
  };
}

/** The `contacts` columns of a stored vCard — the single derivation every writer uses. */
export function contactColumnsFromVcard(vcard: string): ContactColumns {
  return contactColumns(contactCardFromVcard(vcard), vcardUidKey(vcard));
}
