/**
 * Named properties (MS-OXCDATA 2.6.1 PropertyName, MS-OXCPRPT 3.2.5.x):
 *   Kind (1: 0x00 LID, 0x01 Name, 0xFF none) | GUID (16) | LID (4, Kind 0)
 *   | NameSize (1, Kind 1) + Name (UTF-16LE incl. terminator, Kind 1)
 *
 * The registry maps names to property IDs from 0x8001 upwards, one map per
 * mailbox and process: IDs are stable for every session of this server process.
 * Values of named properties are not stored by CoreMail, so a restart (new IDs)
 * loses nothing that was persisted.
 */
import { BufferReader, WireFormatError } from '../wire/reader.js';
import type { BufferWriter } from '../wire/writer.js';

export interface PropertyName {
  kind: number;
  guid: Buffer;
  lid?: number;
  name?: string;
}

export const NameKind = { Lid: 0x00, Name: 0x01, None: 0xff } as const;

export function readPropertyName(r: BufferReader): PropertyName {
  const kind = r.u8();
  const guid = r.bytes(16);
  if (kind === NameKind.Lid) return { kind, guid, lid: r.u32() };
  if (kind === NameKind.Name) {
    const size = r.u8();
    const raw = r.slice(size);
    return { kind, guid, name: raw.remaining > 0 ? raw.utf16Z() : '' };
  }
  if (kind === NameKind.None) return { kind, guid };
  throw new WireFormatError(`unknown PropertyName kind 0x${kind.toString(16)}`);
}

export function writePropertyName(w: BufferWriter, n: PropertyName): void {
  w.u8(n.kind).bytes(n.guid);
  if (n.kind === NameKind.Lid) w.u32(n.lid ?? 0);
  else if (n.kind === NameKind.Name) {
    const encoded = Buffer.from(`${n.name ?? ''}\u0000`, 'utf16le');
    if (encoded.length > 0xff) throw new RangeError('property name too long');
    w.u8(encoded.length).bytes(encoded);
  }
}

/** First and last ID of a registered named property ("greater than 0x8000", never 0xFFFF). */
const FIRST_NAMED_ID = 0x8001;
const LAST_NAMED_ID = 0xfffe;
const FIRST_NAMED_RANGE = 0x8000;

/** Property sets with their own rules (MS-OXPROPS 1.3.2; GUIDs as FlatUID, little-endian). */
export const PS_MAPI = Buffer.from('2803020000000000c000000000000046', 'hex');
export const PS_INTERNET_HEADERS = Buffer.from('8603020000000000c000000000000046', 'hex');

/** Internet header names are coerced to lower case; every other name matches exactly. */
function keyOf(n: PropertyName): string {
  const g = n.guid.toString('hex');
  if (n.kind === NameKind.Lid) return `${g}:l:${n.lid}`;
  const name = n.guid.equals(PS_INTERNET_HEADERS) ? (n.name ?? '').toLowerCase() : (n.name ?? '');
  return `${g}:n:${name}`;
}

/** An ID, or why there is none. */
export type IdLookup = number | 'unknown' | 'exhausted';

/**
 * Name ↔ ID map of one mailbox (MS-OXCPRPT, Processing RopGetPropertyIdsFromNames
 * and Processing RopGetNamesFromPropertyIds):
 *  - a PS_MAPI name with a LID is the standard property with that ID (not registered);
 *  - an unknown name gets a new ID only when `create` is set (the caller checks the
 *    permission to create entries); at most 32 766 IDs, then 'exhausted';
 *  - an ID below 0x8000 is named PS_MAPI / Kind LID / LID = the ID.
 */
export class NamedPropertyMap {
  private readonly ids = new Map<string, number>();
  private readonly names = new Map<number, PropertyName>();
  private next = FIRST_NAMED_ID;

  lookup(n: PropertyName, create: boolean): IdLookup {
    if (n.kind === NameKind.None) return 'unknown';
    const lid = n.lid ?? 0;
    if (n.kind === NameKind.Lid && n.guid.equals(PS_MAPI) && lid > 0 && lid < FIRST_NAMED_RANGE) return lid;
    const known = this.ids.get(keyOf(n));
    if (known !== undefined) return known;
    if (!create) return 'unknown';
    if (this.next > LAST_NAMED_ID) return 'exhausted';
    const id = this.next++;
    this.ids.set(keyOf(n), id);
    this.names.set(id, { ...n, guid: Buffer.from(n.guid) });
    return id;
  }

  nameOf(id: number): PropertyName | undefined {
    if (id > 0 && id < FIRST_NAMED_RANGE) return { kind: NameKind.Lid, guid: Buffer.from(PS_MAPI), lid: id };
    return this.names.get(id);
  }

  /** Every registered ID (RopGetPropertyIdsFromNames without names on a Logon object). */
  registeredIds(): number[] {
    return [...this.names.keys()];
  }
}

const maps = new Map<string, NamedPropertyMap>();

/** The (process-wide) named-property map of a mailbox. */
export function namedPropertiesOf(mailboxId: string): NamedPropertyMap {
  let m = maps.get(mailboxId);
  if (!m) { m = new NamedPropertyMap(); maps.set(mailboxId, m); }
  return m;
}
