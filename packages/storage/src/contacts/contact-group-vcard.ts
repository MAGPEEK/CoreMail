/**
 * 9.5: contact groups ("Kontaktlisten") as vCards — pure.
 *
 * Two spellings exist and both are read and kept:
 *  - vCard 4: `KIND:group` + `MEMBER:urn:uuid:<uid>` / `MEMBER:mailto:<address>`
 *  - Apple (vCard 3): `X-ADDRESSBOOKSERVER-KIND:group` + `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:<uid>`
 * A group created in the webmail uses the Apple form (the address book announces
 * vCard 3.0, which every CardDAV client reads). Members are either cards of the
 * same address book (contacts or nested groups, by UID) or plain addresses.
 */
import { randomUUID } from 'node:crypto';
import { escapeText, unescapeText } from '@coremail/core/calendar';
import { parseVcard, serializeVcard, vcardProperty, type VcardDocument, type VcardProperty } from '@coremail/core/vcard';
import { uidKey } from './contact-vcard.js';

export const GROUP_MEMBER_LIMIT = 1000;

export type ContactGroupMember =
  | { kind: 'card'; uid: string }
  | { kind: 'address'; address: string; name: string };

export type ContactGroupData = { uid: string; name: string; members: ContactGroupMember[] };

const KIND_PROPS = ['KIND', 'X-ADDRESSBOOKSERVER-KIND'];
const MEMBER_PROPS = ['MEMBER', 'X-ADDRESSBOOKSERVER-MEMBER'];

const isGroupDoc = (doc: VcardDocument): boolean =>
  doc.properties.some((p) => KIND_PROPS.includes(p.name) && p.value.trim().toLowerCase() === 'group');

/** True when the vCard is a group (either spelling). */
export function isGroupVcard(vcard: string): boolean {
  const doc = parseVcard(vcard);
  return !!doc && isGroupDoc(doc);
}

/** `urn:uuid:<uid>` / `mailto:<address>` → member; anything else is a card UID as written. */
export function memberFromUri(raw: string): ContactGroupMember | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^mailto:/i.test(v)) {
    const address = decodeURIComponent(v.slice(7).split('?')[0] ?? '').trim();
    return address ? { kind: 'address', address, name: '' } : null;
  }
  const uid = uidKey(v);
  return uid ? { kind: 'card', uid } : null;
}

export function memberUri(m: ContactGroupMember): string {
  return m.kind === 'card' ? `urn:uuid:${m.uid}` : `mailto:${m.address}`;
}

const memberKey = (m: ContactGroupMember): string =>
  m.kind === 'card' ? `card:${m.uid}` : `address:${m.address.toLowerCase()}`;

/** Members without duplicates (first one wins), capped at GROUP_MEMBER_LIMIT. */
export function uniqueMembers(members: readonly ContactGroupMember[]): ContactGroupMember[] {
  const seen = new Set<string>();
  const out: ContactGroupMember[] = [];
  for (const m of members) {
    const k = memberKey(m);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
    if (out.length >= GROUP_MEMBER_LIMIT) break;
  }
  return out;
}

function groupFromDoc(doc: VcardDocument): ContactGroupData {
  const fn = doc.properties.find((p) => p.name === 'FN');
  const n = doc.properties.find((p) => p.name === 'N');
  const uid = doc.properties.find((p) => p.name === 'UID');
  const name = (fn ? unescapeText(fn.value) : n ? unescapeText(n.value.split(/(?<!\\);/)[0] ?? '') : '').trim();
  const members = doc.properties
    .filter((p) => MEMBER_PROPS.includes(p.name))
    .map((p) => memberFromUri(p.value.replace(/\\([\\;,:])/g, '$1')))
    .filter((m): m is ContactGroupMember => m !== null);
  return { uid: uid ? uidKey(uid.value) : '', name, members: uniqueMembers(members) };
}

/** Name, UID and members of a group vCard (null when `vcard` is no group). */
export function contactGroupFromVcard(vcard: string): ContactGroupData | null {
  const doc = parseVcard(vcard);
  return doc && isGroupDoc(doc) ? groupFromDoc(doc) : null;
}

function prop(raw: string): VcardProperty {
  const p = vcardProperty(raw);
  if (!p) throw new Error(`not a vCard property: ${raw.slice(0, 40)}`);
  return p;
}

const sameMembers = (a: ContactGroupMember[], b: ContactGroupMember[]): boolean =>
  a.length === b.length && a.every((m, i) => memberKey(m) === memberKey(b[i]!));

/**
 * Write `name` and `members` into a stored group vCard (a new Apple-style
 * vCard 3.0 group when `vcard` is none). Unchanged parts keep their lines;
 * members are written in the spelling the card already uses.
 */
export function applyContactGroup(vcard: string, data: { name: string; members: ContactGroupMember[] }): string {
  const parsed = parseVcard(vcard);
  const doc = parsed && isGroupDoc(parsed) ? parsed : newGroupDoc();
  const before = groupFromDoc(doc);
  let props = [...doc.properties];
  const name = data.name.trim();
  const members = uniqueMembers(data.members);

  if (before.name !== name) {
    const nameValue = escapeText(name);
    props = props.filter((p) => p.name !== 'FN' && p.name !== 'N');
    const at = Math.max(1, props.findIndex((p) => p.name === 'VERSION') + 1);
    props.splice(at, 0, prop(`FN:${nameValue}`), prop(`N:${nameValue};;;;`));
  }
  if (!sameMembers(before.members, members)) {
    const v4Kind = props.some((p) => p.name === 'KIND');
    const memberName = v4Kind ? 'MEMBER' : 'X-ADDRESSBOOKSERVER-MEMBER';
    const at = props.findIndex((p) => MEMBER_PROPS.includes(p.name));
    const rest = props.filter((p) => !MEMBER_PROPS.includes(p.name));
    rest.splice(at < 0 ? rest.length : at, 0, ...members.map((m) => prop(`${memberName}:${memberUri(m)}`)));
    props = rest;
  }
  if (!props.some((p) => p.name === 'UID')) props.push(prop(`UID:urn:uuid:${randomUUID()}`));
  return serializeVcard({ properties: props });
}

function newGroupDoc(): VcardDocument {
  return { properties: [prop('VERSION:3.0'), prop('X-ADDRESSBOOKSERVER-KIND:group')] };
}

// ─── Expansion (compose) ─────────────────────────────────────────────────────

export type ResolvedCard =
  | { kind: 'contact'; displayName: string; email: string }
  | { kind: 'group'; name: string; members: ContactGroupMember[] };

export type GroupRecipient = { name: string; address: string };
export type GroupExpansion = {
  recipients: GroupRecipient[];
  /** Members that give no address: a contact without e-mail, a card that no longer exists. */
  skipped: Array<{ reason: 'noEmail' | 'missing'; name: string }>;
};

/** Nesting depth for groups within groups. */
export const GROUP_NESTING_LIMIT = 5;

/**
 * Expand members into recipients: card members resolve through `lookup` (a
 * nested group expands recursively; cycles and depth are bounded), addresses
 * are de-duplicated case-insensitively, order is kept.
 */
export function expandGroupMembers(
  members: readonly ContactGroupMember[],
  lookup: (uid: string) => ResolvedCard | undefined,
): GroupExpansion {
  const out: GroupExpansion = { recipients: [], skipped: [] };
  const seen = new Set<string>();
  const add = (name: string, address: string): void => {
    const key = address.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.recipients.push({ name: name.trim(), address: address.trim() });
  };
  const walk = (list: readonly ContactGroupMember[], depth: number, path: Set<string>): void => {
    for (const m of list) {
      if (m.kind === 'address') { add(m.name, m.address); continue; }
      const card = lookup(m.uid);
      if (!card) { out.skipped.push({ reason: 'missing', name: '' }); continue; }
      if (card.kind === 'contact') {
        if (card.email) add(card.displayName, card.email);
        else out.skipped.push({ reason: 'noEmail', name: card.displayName });
        continue;
      }
      if (path.has(m.uid) || depth >= GROUP_NESTING_LIMIT) continue;
      walk(card.members, depth + 1, new Set([...path, m.uid]));
    }
  };
  walk(members, 0, new Set());
  return out;
}

/** Tolerant read of the stored `members` JSON (malformed entries dropped). */
export function membersFromJson(raw: unknown): ContactGroupMember[] {
  if (!Array.isArray(raw)) return [];
  const out: ContactGroupMember[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (r['kind'] === 'card' && typeof r['uid'] === 'string' && r['uid']) out.push({ kind: 'card', uid: r['uid'] });
    else if (r['kind'] === 'address' && typeof r['address'] === 'string' && r['address']) {
      out.push({ kind: 'address', address: r['address'], name: typeof r['name'] === 'string' ? r['name'] : '' });
    }
  }
  return uniqueMembers(out);
}
