/**
 * 9.5: request validation of the REST contacts and contact-group API (zod) and
 * the mapping of a valid body to a storage ContactPatch. Pure.
 */
import { z } from 'zod';
import {
  CONTACT_ADDRESS_TYPES, CONTACT_EMAIL_TYPES, CONTACT_IM_TYPES, CONTACT_LIMITS, CONTACT_PHONE_TYPES, CONTACT_URL_TYPES,
  GROUP_MEMBER_LIMIT, emptyAddress, isContactDate,
  type ContactAddress, type ContactName, type ContactPatch,
} from '@coremail/storage';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_LINES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** Single-line value: no control characters. */
const line = (max: number) => z.string().max(max).refine((s) => !CONTROL.test(s), 'Steuerzeichen sind nicht erlaubt');
/** Free text (line breaks allowed; they are escaped in the vCard). */
const text = (max: number) => z.string().max(max).refine((s) => !CONTROL_EXCEPT_LINES.test(s), 'Steuerzeichen sind nicht erlaubt');

const emailValue = z.string().trim().max(254).email('Ungültige E-Mail-Adresse');
/** Optional legacy e-mail field: "" (= remove) or a valid address. */
const optionalEmail = z.union([z.literal(''), emailValue]);

const PHONE_CHARS = /^[+\d\s()\-./#*,;A-Za-z]+$/;
const phoneValue = line(CONTACT_LIMITS.phone).trim().refine((s) => PHONE_CHARS.test(s) && /\d/.test(s), 'Ungültige Telefonnummer');

function isWebUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
const urlValue = line(CONTACT_LIMITS.uri).trim().refine(isWebUrl, 'Nur http- oder https-Adressen');

const UNSAFE_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file']);
/** IMPP value: a URI with a scheme (`xmpp:`, `sip:`, `skype:` …), no script schemes. */
function isImUri(v: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):\S+$/i.exec(v);
  return !!m && !UNSAFE_SCHEMES.has(m[1]!.toLowerCase());
}
const imValue = line(CONTACT_LIMITS.uri).trim().refine(isImUri, 'Adresse mit Dienst angeben, z. B. xmpp:name@server');

const typed = <T extends readonly [string, ...string[]]>(types: T, value: z.ZodType<string>) =>
  z.array(z.object({ type: z.enum(types), value })).max(CONTACT_LIMITS.listEntries);

const addressSchema = z.object({
  type: z.enum(CONTACT_ADDRESS_TYPES),
  street: text(CONTACT_LIMITS.text).optional(),
  city: line(CONTACT_LIMITS.text).optional(),
  region: line(CONTACT_LIMITS.text).optional(),
  postalCode: line(40).optional(),
  country: line(CONTACT_LIMITS.text).optional(),
  poBox: line(CONTACT_LIMITS.text).optional(),
  extended: line(CONTACT_LIMITS.text).optional(),
});

const namePart = line(CONTACT_LIMITS.namePart).optional();
const dateValue = z.string().refine(isContactDate, 'Datum als JJJJ-MM-TT oder --MM-TT');
export const categoryList = z.array(line(CONTACT_LIMITS.category).trim().min(1)).max(CONTACT_LIMITS.categories);

const contactFields = {
  displayName: text(CONTACT_LIMITS.text).optional(),
  name: z.object({ prefix: namePart, given: namePart, middle: namePart, family: namePart, suffix: namePart }).optional(),
  nickname: line(CONTACT_LIMITS.text).optional(),
  fileAs: line(CONTACT_LIMITS.text).optional(),
  company: text(CONTACT_LIMITS.text).optional(),
  department: text(CONTACT_LIMITS.text).optional(),
  jobTitle: text(CONTACT_LIMITS.text).optional(),
  notes: text(CONTACT_LIMITS.notes).optional(),
  // Legacy single slots (pre-9.5 clients); cannot be combined with the lists below
  email: optionalEmail.optional(),
  email2: optionalEmail.optional(),
  phone: text(CONTACT_LIMITS.phone).optional(),
  mobile: text(CONTACT_LIMITS.phone).optional(),
  emails: typed(CONTACT_EMAIL_TYPES, emailValue).optional(),
  phones: typed(CONTACT_PHONE_TYPES, phoneValue).optional(),
  addresses: z.array(addressSchema).max(CONTACT_LIMITS.listEntries).optional(),
  urls: typed(CONTACT_URL_TYPES, urlValue).optional(),
  ims: typed(CONTACT_IM_TYPES, imValue).optional(),
  birthday: dateValue.optional(),
  anniversary: dateValue.optional(),
  categories: categoryList.optional(),
};

type ContactFieldsInput = z.infer<z.ZodObject<typeof contactFields>>;

function noMixedSlots(v: ContactFieldsInput, ctx: z.RefinementCtx): void {
  if (v.emails && (v.email !== undefined || v.email2 !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['emails'], message: 'emails nicht zusammen mit email/email2 senden' });
  }
  if (v.phones && (v.phone !== undefined || v.mobile !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['phones'], message: 'phones nicht zusammen mit phone/mobile senden' });
  }
}

/** POST /contacts: a supplied vCard is kept, the fields are applied on top. */
export const ContactCreateSchema = z.object({ ...contactFields, vcardData: z.string().max(1_000_000).optional() }).superRefine(noMixedSlots);
/** PUT /contacts/:id: partial update. */
export const ContactUpdateSchema = z.object(contactFields).superRefine(noMixedSlots);

/** First problem of a failed parse, for the 400 body. */
export function firstIssue(error: z.ZodError): { field: string; message: string } {
  const issue = error.issues[0];
  return { field: issue ? issue.path.join('.') : '', message: issue?.message ?? 'Invalid request' };
}

function definedName(n: NonNullable<ContactFieldsInput['name']>): Partial<ContactName> {
  const out: Partial<ContactName> = {};
  for (const k of ['prefix', 'given', 'middle', 'family', 'suffix'] as const) {
    const v = n[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function toAddress(a: z.infer<typeof addressSchema>): ContactAddress {
  const out = emptyAddress(a.type);
  for (const f of ['street', 'city', 'region', 'postalCode', 'country', 'poBox', 'extended'] as const) out[f] = a[f]?.trim() ?? '';
  return out;
}

/** The storage patch of a validated body (only the fields the body carries). */
export function contactPatchFromInput(v: ContactFieldsInput): ContactPatch {
  const p: ContactPatch = {};
  for (const k of ['displayName', 'nickname', 'fileAs', 'company', 'department', 'jobTitle', 'notes',
    'email', 'email2', 'phone', 'mobile', 'birthday', 'anniversary'] as const) {
    const value = v[k];
    if (value !== undefined) p[k] = value;
  }
  if (v.name) p.name = definedName(v.name);
  if (v.emails) p.emails = v.emails;
  if (v.phones) p.phones = v.phones;
  if (v.addresses) p.addresses = v.addresses.map(toAddress);
  if (v.urls) p.urls = v.urls;
  if (v.ims) p.ims = v.ims;
  if (v.categories) p.categories = v.categories;
  return p;
}

// ─── Contact groups ──────────────────────────────────────────────────────────

/** A member as the webmail sends it: an own contact, a nested group, a kept card reference, or an address. */
export const GroupMemberInput = z.union([
  z.object({ contactId: z.string().min(1).max(100) }),
  z.object({ groupId: z.string().min(1).max(100) }),
  z.object({ uid: line(500).trim().min(1) }),
  z.object({ email: emailValue, name: line(CONTACT_LIMITS.text).optional() }),
]);
export type GroupMemberInput = z.infer<typeof GroupMemberInput>;

const groupName = line(CONTACT_LIMITS.text).trim().min(1, 'Name fehlt');
export const GroupCreateSchema = z.object({
  name: groupName,
  members: z.array(GroupMemberInput).max(GROUP_MEMBER_LIMIT).optional(),
});
export const GroupUpdateSchema = z.object({
  name: groupName.optional(),
  members: z.array(GroupMemberInput).max(GROUP_MEMBER_LIMIT).optional(),
});
