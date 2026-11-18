/**
 * RecipientRow (MS-OXCDATA 2.8.3) and TypedString (2.11.7) codecs for
 * RopOpenMessage / RopModifyRecipients.
 *
 * RecipientFlags: Type (mask 0x0007: 0 NoType, 1 X500DN, 3 SMTP, 6/7 PDL),
 * E 0x0008 EmailAddress, D 0x0010 DisplayName, T 0x0020 TransmittableDisplayName,
 * S 0x0040 TransmittableDisplayName = DisplayName, U 0x0200 Unicode strings,
 * I 0x0400 SimpleDisplayName, O 0x8000 AddressType present.
 */
import { BufferReader, WireFormatError } from '../../wire/reader.js';
import type { BufferWriter } from '../../wire/writer.js';
import { readPropertyRow } from '../../props/row.js';
import type { PropertyBag } from '../../props/bag.js';

const TYPE_MASK = 0x0007;
const TYPE_NONE = 0x0;
const TYPE_X500DN = 0x1;
const TYPE_SMTP = 0x3;
const TYPE_PDL1 = 0x6;
const TYPE_PDL2 = 0x7;
const F_E = 0x0008;
const F_D = 0x0010;
const F_T = 0x0020;
const F_S = 0x0040;
const F_U = 0x0200;
const F_I = 0x0400;
const F_O = 0x8000;

export interface ParsedRecipientRow {
  addressType: 'SMTP' | 'EX' | string;
  x500Dn: string | null;
  emailAddress: string | null;
  displayName: string | null;
  props: PropertyBag;
}

export function readRecipientRow(r: BufferReader, columns: readonly number[]): ParsedRecipientRow {
  const flags = r.u16();
  const type = flags & TYPE_MASK;
  const unicode = (flags & F_U) !== 0;
  const str = (): string => (unicode ? r.utf16Z() : r.asciiZ());
  let x500Dn: string | null = null;
  let addressType: string = type === TYPE_SMTP ? 'SMTP' : type === TYPE_X500DN ? 'EX' : '';
  if (type === TYPE_X500DN) {
    r.u8(); // AddressPrefixUsed
    r.u8(); // DisplayType
    x500Dn = r.asciiZ('ascii');
  }
  if (type === TYPE_PDL1 || type === TYPE_PDL2) {
    r.bytes(r.u16()); // EntryID of the distribution list
    r.bytes(r.u16()); // SearchKey
  }
  if (type === TYPE_NONE && (flags & F_O)) addressType = r.asciiZ('ascii');
  const emailAddress = flags & F_E ? str() : null;
  const displayName = flags & F_D ? str() : null;
  if (flags & F_I) str();
  if (flags & F_T) str();
  const columnCount = r.u16();
  if (columnCount > columns.length) throw new WireFormatError('recipient row has more columns than declared');
  const props = readPropertyRow(r, columns.slice(0, columnCount));
  return { addressType, x500Dn, emailAddress, displayName, props };
}

/** SMTP recipient row with display name and address, no extra columns. */
export function writeSmtpRecipientRow(w: BufferWriter, displayName: string, email: string): void {
  w.u16(TYPE_SMTP | F_E | F_D | F_S | F_U).utf16Z(email).utf16Z(displayName || email).u16(0).u8(0x00);
}

/** TypedString: 0x01 empty, 0x04 UTF-16LE with terminator. */
export function writeTypedString(w: BufferWriter, s: string): void {
  if (s === '') w.u8(0x01);
  else w.u8(0x04).utf16Z(s);
}
