/**
 * 9.5: contact groups ("Kontaktlisten") in the webmail — member list editing,
 * the request body, and turning an expanded group into compose recipients.
 * Pure — unit-tested with `node --test`.
 */
import { formatRecipient, isValidAddress } from './recipients.ts';

/** A member as GET /contacts/groups/:id returns it. */
export type GroupMember =
  | { kind: 'contact'; contactId: string; uid: string; displayName: string; email: string }
  | { kind: 'group'; groupId: string; uid: string; name: string }
  | { kind: 'address'; email: string; name: string }
  | { kind: 'missing'; uid: string };

export interface ContactGroupSummary { id: string; name: string; memberCount: number }
export interface ContactGroupDetail { id: string; name: string; members: GroupMember[] }

export interface GroupExpansion {
  name?: string;
  recipients: Array<{ name: string; address: string }>;
  skipped: Array<{ reason: 'noEmail' | 'missing'; name: string }>;
}

/** Autocomplete entries of `/contacts?q=…&groups=1` that are groups carry this prefix. */
export const GROUP_SUGGESTION_PREFIX = 'group-';

export function groupIdOfSuggestion(s: { id: string; kind?: string }): string | null {
  return s.kind === 'group' && s.id.startsWith(GROUP_SUGGESTION_PREFIX) ? s.id.slice(GROUP_SUGGESTION_PREFIX.length) : null;
}

/** Stable identity of a member (list keys, duplicates). */
export function memberKey(m: GroupMember): string {
  switch (m.kind) {
    case 'contact': return `c:${m.contactId}`;
    case 'group': return `g:${m.groupId}`;
    case 'address': return `a:${m.email.toLowerCase()}`;
    case 'missing': return `u:${m.uid}`;
  }
}

/** Label of a member in the list. */
export function memberLabel(m: GroupMember): string {
  switch (m.kind) {
    case 'contact': return m.email ? `${m.displayName} <${m.email}>` : `${m.displayName} (keine E-Mail-Adresse)`;
    case 'group': return `Kontaktliste: ${m.name}`;
    case 'address': return m.name ? `${m.name} <${m.email}>` : m.email;
    case 'missing': return 'Nicht mehr vorhandener Kontakt';
  }
}

/** Add a member unless it is already in the list. */
export function addMember(members: readonly GroupMember[], m: GroupMember): GroupMember[] {
  const k = memberKey(m);
  return members.some((x) => memberKey(x) === k) ? [...members] : [...members, m];
}

export function removeMember(members: readonly GroupMember[], key: string): GroupMember[] {
  return members.filter((m) => memberKey(m) !== key);
}

/** A typed address as member; null (with the reason) when it is no valid address. */
export function addressMember(email: string, name: string): GroupMember | null {
  const e = email.trim();
  return isValidAddress(e) ? { kind: 'address', email: e, name: name.trim() } : null;
}

/** Request body member of a view member (kept references survive a save). */
export function memberInput(m: GroupMember): Record<string, string> {
  switch (m.kind) {
    case 'contact': return { contactId: m.contactId };
    case 'group': return { groupId: m.groupId };
    case 'address': return m.name ? { email: m.email, name: m.name } : { email: m.email };
    case 'missing': return { uid: m.uid };
  }
}

/** Compose entries ("Name <a@b>") of an expanded group. */
export function recipientEntries(exp: GroupExpansion): string[] {
  return exp.recipients.map((r) => formatRecipient(r.name, r.address));
}

/** German hint for members that gave no recipient (null when every member did). */
export function expansionNotice(exp: GroupExpansion): string | null {
  const noEmail = exp.skipped.filter((s) => s.reason === 'noEmail').length;
  const missing = exp.skipped.filter((s) => s.reason === 'missing').length;
  const parts: string[] = [];
  if (noEmail) parts.push(noEmail === 1 ? '1 Mitglied ohne E-Mail-Adresse' : `${noEmail} Mitglieder ohne E-Mail-Adresse`);
  if (missing) parts.push(missing === 1 ? '1 nicht mehr vorhandener Kontakt' : `${missing} nicht mehr vorhandene Kontakte`);
  return parts.length ? `Übersprungen: ${parts.join(', ')}.` : null;
}
