/**
 * ResolveRecipients command ([MS-ASCMD] 2.2.1.15).
 *
 * Each <To> (name or address) is looked up in the caller's GAL (users + Shared
 * Mailboxes of the caller's domain, Type 1) and personal contacts (Type 2).
 * Options are answered minimally: Certificates → Status 7 (no certificate
 * returned), Availability → Status 163 (free/busy not provided), Picture ignored.
 */
import { encodeWbxml, el, getChild, getText, type WbxmlElement } from '../wbxml.js';
import { searchContacts, searchGal, type DirectoryEntry } from './directory.js';

export const RESOLVE_STATUS = {
  SUCCESS: '1',
  AMBIGUOUS: '2',
  AMBIGUOUS_PARTIAL: '3',
  NOT_RESOLVED: '4',
  PROTOCOL_ERROR: '5',
  SERVER_ERROR: '6',
} as const;

const CERT_STATUS_NONE = '7';
const AVAILABILITY_NOT_FOUND = '163';
const MAX_TO = 100;
const DEFAULT_MAX_AMBIGUOUS = 19;

const kids = (e: WbxmlElement | undefined): WbxmlElement[] =>
  (e?.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string');

/** Pure: exact address hits win; otherwise every match is a candidate (GAL before contacts, deduplicated). */
export function rankCandidates(query: string, gal: DirectoryEntry[], contacts: DirectoryEntry[]): { exact: boolean; list: DirectoryEntry[] } {
  const q = query.trim().toLowerCase();
  // A contact whose address is also in the GAL adds nothing.
  const galAddrs = new Set(gal.map((e) => e.email));
  const seen = new Set<string>();
  const all = [...gal, ...contacts.filter((c) => !galAddrs.has(c.email))].filter((e) => {
    const key = `${e.kind === 'contact' ? 'c' : 'g'}:${e.email}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const exact = all.filter((e) => e.email === q);
  if (exact.length) return { exact: true, list: [exact.find((e) => e.kind !== 'contact') ?? exact[0]!] };
  const byName = all.filter((e) => e.displayName.toLowerCase() === q);
  if (byName.length === 1) return { exact: true, list: byName };
  return { exact: false, list: all };
}

function recipient(e: DirectoryEntry, opts: { certificates: boolean; availability: boolean }): WbxmlElement {
  return el('Recipient', undefined, [
    el('Type', e.kind === 'contact' ? '2' : '1'),
    el('DisplayName', e.displayName),
    el('EmailAddress', e.email),
    ...(opts.availability ? [el('Availability', undefined, [el('Status', AVAILABILITY_NOT_FOUND)])] : []),
    ...(opts.certificates ? [el('Certificates', undefined, [el('Status', CERT_STATUS_NONE), el('CertificateCount', '0'), el('RecipientCount', '0')])] : []),
  ]);
}

export async function handleResolveRecipients(body: WbxmlElement, userId: string): Promise<Buffer> {
  const tos = kids(body).filter((c) => c.name === 'To').map((c) => c.text ?? '').filter((t) => t.trim());
  if (body.name !== 'ResolveRecipients' || tos.length === 0 || tos.length > MAX_TO) {
    return encodeWbxml(el('ResolveRecipients', undefined, [el('Status', RESOLVE_STATUS.PROTOCOL_ERROR)]));
  }
  const options = getChild(body, 'Options');
  const certRetrieval = options ? getText(options, 'CertificateRetrieval') : '';
  const opts = {
    certificates: certRetrieval === '2' || certRetrieval === '3',
    availability: !!(options && getChild(options, 'Availability')),
  };
  const maxAmbiguous = Math.max(0, Math.min(Number(options ? getText(options, 'MaxAmbiguousRecipients') || DEFAULT_MAX_AMBIGUOUS : DEFAULT_MAX_AMBIGUOUS) || 0, 100));

  const responses: WbxmlElement[] = [];
  for (const to of tos) {
    const [gal, contacts] = await Promise.all([searchGal(userId, to), searchContacts(userId, to)]);
    const { exact, list } = rankCandidates(to, gal, contacts);
    let status: string;
    let shown: DirectoryEntry[];
    if (list.length === 0) { status = RESOLVE_STATUS.NOT_RESOLVED; shown = []; }
    else if (exact || list.length === 1) { status = RESOLVE_STATUS.SUCCESS; shown = list.slice(0, 1); }
    else { status = RESOLVE_STATUS.AMBIGUOUS; shown = list.slice(0, maxAmbiguous); }
    responses.push(el('Response', undefined, [
      el('To', to),
      el('Status', status),
      el('RecipientCount', String(shown.length)),
      ...shown.map((e) => recipient(e, opts)),
    ]));
  }
  return encodeWbxml(el('ResolveRecipients', undefined, [el('Status', RESOLVE_STATUS.SUCCESS), ...responses]));
}
