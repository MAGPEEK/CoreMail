/**
 * RFC 5322 §3.4 address-list parser for raw header values (From, Sender, To, Cc, …).
 *
 * Tolerant: handles quoted display names, angle-addr, comments, groups
 * ("Team: a@x, b@y;") and obsolete forms well enough for sender checks and IMAP
 * ENVELOPE rendering. Display names are returned as written (RFC 2047 encoded
 * words are not decoded). Pure module.
 */

export interface ParsedMailbox {
  kind: 'mailbox';
  /** Display name (unquoted, as written) or ''. */
  name: string;
  /** addr-spec (local@domain), '' when none could be found. */
  address: string;
}

export interface ParsedGroup {
  kind: 'group';
  name: string;
  members: ParsedMailbox[];
}

export type ParsedAddress = ParsedMailbox | ParsedGroup;

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, '$1');
  return t.replace(/"/g, '');
}

function parseMailbox(text: string): ParsedMailbox | null {
  const t = text.trim();
  if (!t) return null;
  const lt = t.lastIndexOf('<');
  const gt = t.lastIndexOf('>');
  if (lt !== -1 && gt > lt) {
    let address = t.slice(lt + 1, gt).trim();
    // obs-route "<@a,@b:user@host>"
    const colon = address.lastIndexOf(':');
    if (address.startsWith('@') && colon !== -1) address = address.slice(colon + 1);
    return { kind: 'mailbox', name: unquote(t.slice(0, lt)), address: address.replace(/\s+/g, '') };
  }
  return { kind: 'mailbox', name: '', address: t.replace(/\s+/g, '') };
}

/** Splits an address-list header value into mailboxes and groups. */
export function parseAddressList(value: string): ParsedAddress[] {
  const out: ParsedAddress[] = [];
  let cur = '';
  let inQuote = false;
  let inAngle = false;
  let comment = 0;
  let group: ParsedGroup | null = null;
  const flush = (): void => {
    const mb = parseMailbox(cur);
    cur = '';
    if (!mb) return;
    if (group) group.members.push(mb); else out.push(mb);
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (comment > 0) {
      if (c === '\\') i++;
      else if (c === '(') comment++;
      else if (c === ')') comment--;
      continue;
    }
    if (inQuote) {
      cur += c;
      if (c === '\\' && i + 1 < value.length) { cur += value[i + 1]; i++; continue; }
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') { inQuote = true; cur += c; continue; }
    if (c === '(' && !inAngle) { comment = 1; continue; }
    if (c === '<') { inAngle = true; cur += c; continue; }
    if (c === '>') { inAngle = false; cur += c; continue; }
    if (inAngle) { cur += c; continue; }
    if (c === ':' && !group) {
      group = { kind: 'group', name: unquote(cur), members: [] };
      cur = '';
      continue;
    }
    if (c === ';' && group) {
      flush();
      out.push(group);
      group = null;
      continue;
    }
    if (c === ',') { flush(); continue; }
    cur += c;
  }
  flush();
  if (group) out.push(group);
  return out;
}

/** All addr-specs of an address list (group members included), lower-cased. */
export function addressesOf(value: string): string[] {
  const out: string[] = [];
  for (const a of parseAddressList(value)) {
    if (a.kind === 'mailbox') { if (a.address) out.push(a.address.toLowerCase()); }
    else for (const m of a.members) if (m.address) out.push(m.address.toLowerCase());
  }
  return out;
}
