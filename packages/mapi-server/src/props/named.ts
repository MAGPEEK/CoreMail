/**
 * Named properties (MS-OXCDATA 2.6.1 PropertyName, MS-OXCPRPT 3.2.5.x):
 *   Kind (1: 0x00 LID, 0x01 Name, 0xFF none) | GUID (16) | LID (4, Kind 0)
 *   | NameSize (1, Kind 1) + Name (UTF-16LE incl. terminator, Kind 1)
 *
 * The registry maps names to property IDs from 0x8000 upwards, one map per
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

const FIRST_NAMED_ID = 0x8000;
const LAST_NAMED_ID = 0xfffe;

function keyOf(n: PropertyName): string {
  const g = n.guid.toString('hex');
  return n.kind === NameKind.Lid ? `${g}:l:${n.lid}` : `${g}:n:${(n.name ?? '').toLowerCase()}`;
}

/** Name ↔ ID map of one mailbox. */
export class NamedPropertyMap {
  private readonly ids = new Map<string, number>();
  private readonly names = new Map<number, PropertyName>();
  private next = FIRST_NAMED_ID;

  /** The ID of a name; allocated when `create` is set, else undefined for unknown names. */
  idFor(n: PropertyName, create: boolean): number | undefined {
    if (n.kind === NameKind.None) return undefined;
    const known = this.ids.get(keyOf(n));
    if (known !== undefined || !create) return known;
    if (this.next > LAST_NAMED_ID) return undefined;
    const id = this.next++;
    this.ids.set(keyOf(n), id);
    this.names.set(id, { ...n, guid: Buffer.from(n.guid) });
    return id;
  }

  nameOf(id: number): PropertyName | undefined {
    return this.names.get(id);
  }
}

const maps = new Map<string, NamedPropertyMap>();

/** The (process-wide) named-property map of a mailbox. */
export function namedPropertiesOf(mailboxId: string): NamedPropertyMap {
  let m = maps.get(mailboxId);
  if (!m) { m = new NamedPropertyMap(); maps.set(mailboxId, m); }
  return m;
}
