/**
 * The address book a session sees (MS-OXNSPI, MS-OXOABK): one container, the
 * Global Address List (ContainerID 0), holding the active users and Shared
 * Mailboxes of the caller's own domain (the GAL scope of every CoreMail
 * directory lookup), sorted by display name.
 *
 *  - Minimal Entry IDs are derived from the directory id (sha256), so they are
 *    stable across sessions, processes and restarts; values below 0x10 are
 *    reserved for the protocol (MS-OXNSPI 2.2.1.8/2.2.1.9). Collisions are
 *    resolved deterministically (ids in sorted order take the next free MID).
 *  - Mailboxes hidden from the address list (mail flow policy) are not in the
 *    table and never found by name (ANR, GetMatches, SeekEntries); a client
 *    that already knows the DN (its own profile, an EX address in a message)
 *    can still resolve it (DNToMId, GetProps).
 *  - Recipients are addressed as type "EX" with their legacy DN (storage
 *    legacy-dn, the DN CoreMail's mailbox endpoint and Autodiscover use);
 *    PidTagSmtpAddress and PidTagAddressBookProxyAddresses carry the SMTP
 *    addresses (primary "SMTP:", aliases "smtp:").
 * Pure: built from DirectoryRecords, unit-tested.
 */
import { createHash } from 'node:crypto';
import { legacyDnFor } from '@coremail/storage';
import { addressBookEntryId, ADDRESS_BOOK_PROVIDER } from '../ids.js';
import { lookupProperty, tagForUnicodePreference, type PropertyBag } from '../props/bag.js';
import { evaluateRestriction, type Restriction } from '../props/restriction.js';
import { PropType, propIdOf, tag, Tag, ObjectType } from '../props/tags.js';
import { BufferWriter } from '../wire/writer.js';
import type { AbCell } from './wire.js';
import type { DirectoryRecord } from '../store/types.js';

/** GUID of this address book server (Bind ServerGuid, ephemeral EntryIDs); fixed. */
export const NSPI_SERVER_GUID = createHash('sha256').update('coremail:nspi-server').digest().subarray(0, 16);

export const GAL_CONTAINER_ID = 0;
/** DN of the Global Address List container (MS-OXOABK gal-addrlist-dn). */
export const GAL_DN = '/';
export const GAL_DISPLAY_NAME = 'Globale Adressliste';

/** Positioning MIDs (MS-OXNSPI 2.2.1.8). */
export const Mid = { BeginningOfTable: 0x0, Current: 0x1, EndOfTable: 0x2 } as const;
/** Ambiguous name resolution MIDs (MS-OXNSPI 2.2.1.9). */
export const AnrMid = { Unresolved: 0x0, Ambiguous: 0x1 } as const;
const FIRST_MID = 0x10;
const MID_SPACE = 0x7fff_ffff - FIRST_MID;

/** PidTagDisplayType values (MS-OXNSPI 2.2.1.3). */
export const DisplayType = { MailUser: 0x0000, Container: 0x0100 } as const;
/** PidTagContainerFlags: AB_RECIPIENTS | AB_UNMODIFIABLE (MS-OXOABK 2.2.2.1). */
const GAL_CONTAINER_FLAGS = 0x1 | 0x8;
const ENTRY_ID_EPHEMERAL = 0x87;
export const CP_WINUNICODE = 1200;

const T = PropType;
/** Address book properties (MS-OXPROPS / MS-OXOABK). */
export const AbTag = {
  ContainerFlags: tag(0x3600, T.Integer32),
  ContainerId: tag(0xfffd, T.Integer32),
  IsMaster: tag(0xfffb, T.Boolean),
  Anr: tag(0x360c, T.String),
  Account: tag(0x3a00, T.String),
  DisplayNamePrintable: tag(0x39ff, T.String),
  ProxyAddresses: tag(0x800f, T.MultipleString),
} as const;

/** Columns returned when a client asks without naming any (ResolveNames, GetMatches, QueryRows). */
export const DEFAULT_COLUMNS: readonly number[] = [
  Tag.EntryId, Tag.DisplayName, Tag.AddressType, Tag.EmailAddress, Tag.SmtpAddress,
  Tag.ObjectType, Tag.DisplayType, Tag.InstanceKey,
];

export interface AbEntry extends DirectoryRecord {
  mid: number;
  dn: string;
}

export interface CellOptions {
  /** fEphID: PidTagEntryId as an ephemeral EntryID. */
  ephemeral: boolean;
  /** String values in Unicode (else 8-bit). */
  unicode: boolean;
}

function midCandidate(id: string): number {
  return FIRST_MID + (createHash('sha256').update(`nspi-mid:${id}`).digest().readUInt32BE(0) % MID_SPACE);
}

/** EphemeralEntryID (MS-OXNSPI 2.2.9.2): 0x87, server GUID, version 1, display type, MID. */
export function ephemeralEntryId(mid: number, displayType: number): Buffer {
  return new BufferWriter(32).u8(ENTRY_ID_EPHEMERAL).u8(0).u8(0).u8(0)
    .bytes(NSPI_SERVER_GUID).u32(1).u32(displayType).u32(mid).toBuffer();
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function localPart(address: string): string {
  return address.slice(0, address.lastIndexOf('@'));
}

export class AddressBook {
  /** Visible entries in display-name order (the GAL table). */
  readonly table: readonly AbEntry[];
  private readonly byMid = new Map<number, AbEntry>();
  private readonly byDn = new Map<string, AbEntry>();
  private readonly position = new Map<number, number>();

  constructor(records: readonly DirectoryRecord[]) {
    const ordered = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const r of ordered) {
      let mid = midCandidate(r.id);
      while (this.byMid.has(mid)) mid = mid + 1 > 0x7fff_ffff ? FIRST_MID : mid + 1;
      const entry: AbEntry = { ...r, mid, dn: legacyDnFor(r.id) };
      this.byMid.set(mid, entry);
      this.byDn.set(entry.dn.toLowerCase(), entry);
    }
    this.table = [...this.byMid.values()].filter((e) => !e.hidden)
      .sort((a, b) => collator.compare(a.displayName, b.displayName) || a.email.localeCompare(b.email));
    this.table.forEach((e, i) => this.position.set(e.mid, i));
  }

  entry(mid: number): AbEntry | undefined { return this.byMid.get(mid); }

  /** Entry of a legacy DN (case-insensitive), hidden entries included. */
  entryByDn(dn: string): AbEntry | undefined { return this.byDn.get(dn.trim().toLowerCase()); }

  /** Table index of a MID (visible entries only). */
  indexOf(mid: number): number | undefined { return this.position.get(mid); }

  /** Visible entries of a MID list, in the given order (unknown and hidden MIDs dropped). */
  visible(mids: readonly number[]): AbEntry[] {
    return mids.map((m) => this.byMid.get(m)).filter((e): e is AbEntry => e !== undefined && !e.hidden);
  }

  /** Index in `entries` (display-name order) of the first entry sorting at or after `name`, or -1. */
  seek(entries: readonly AbEntry[], name: string): number {
    return entries.findIndex((e) => collator.compare(e.displayName, name) >= 0);
  }

  /** Ambiguous name resolution over the table: an exact address wins, else prefixes. */
  resolve(name: string): AbEntry[] {
    const q = name.trim().replace(/^smtp:/i, '').toLowerCase();
    if (!q) return [];
    const exact = this.table.filter((e) => e.email === q || e.aliases.includes(q));
    if (exact.length > 0) return exact;
    return this.table.filter((e) => anrPrefixMatch(e, q));
  }

  /** Rows of `entries` matching a GetMatches filter (PidTagAnr nodes use ANR). */
  filter(entries: readonly AbEntry[], restriction: Restriction): AbEntry[] {
    return entries.filter((e) => {
      const bag = entryBag(e, { ephemeral: false, unicode: true });
      return evaluateRestriction(restriction, (t) => lookupProperty(bag, t), (node) => {
        if ((node.type !== 'property' && node.type !== 'content') || propIdOf(node.tag) !== propIdOf(AbTag.Anr)) return undefined;
        const v = node.value.value;
        return typeof v === 'string' && anrMatches(e, v);
      });
    });
  }

  /** Cells of an entry for `columns` (string types as requested, PtypUnspecified → stored type). */
  cells(e: AbEntry, columns: readonly number[], opts: CellOptions): AbCell[] {
    return cellsOf(entryBag(e, opts), columns);
  }

  /** Every property of an entry (GetProps without tags), strings per `opts.unicode`. */
  allCells(e: AbEntry, opts: CellOptions): AbCell[] {
    return cellsOf(entryBag(e, opts), propertyList(e, opts.unicode));
  }
}

function anrPrefixMatch(e: AbEntry, q: string): boolean {
  const name = e.displayName.toLowerCase();
  if (name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) return true;
  return [e.email, ...e.aliases].some((a) => a.startsWith(q) || localPart(a).startsWith(q));
}

function anrMatches(e: AbEntry, value: string): boolean {
  const q = value.trim().replace(/^smtp:/i, '').toLowerCase();
  return q !== '' && (e.email === q || e.aliases.includes(q) || anrPrefixMatch(e, q));
}

function cellsOf(bag: PropertyBag, columns: readonly number[]): AbCell[] {
  return columns.map((c): AbCell => {
    const r = lookupProperty(bag, c);
    if (!r.found) return { kind: 'error', tag: c, error: NspiError.NotFound };
    return 'value' in r ? { kind: 'value', tag: r.tag, value: r.value } : { kind: 'error', tag: c, error: r.error };
  });
}

/** Tags of an entry's properties (GetPropList / GetProps without tags). */
export function propertyList(e: AbEntry, unicode: boolean): number[] {
  return [...entryBag(e, { ephemeral: false, unicode: true }).keys()].map((t) => tagForUnicodePreference(t, unicode));
}

function entryBag(e: AbEntry, opts: CellOptions): PropertyBag {
  const permanent = addressBookEntryId(e.dn, DisplayType.MailUser);
  const instanceKey = Buffer.alloc(4);
  instanceKey.writeUInt32LE(e.mid);
  const name = e.displayName || e.email;
  const bag: PropertyBag = new Map();
  bag.set(Tag.EntryId, opts.ephemeral ? ephemeralEntryId(e.mid, DisplayType.MailUser) : permanent);
  bag.set(Tag.RecordKey, permanent);
  bag.set(Tag.InstanceKey, instanceKey);
  bag.set(Tag.SearchKey, Buffer.from(`EX:${e.dn.toUpperCase()}\u0000`, 'latin1'));
  bag.set(Tag.MappingSignature, ADDRESS_BOOK_PROVIDER);
  bag.set(Tag.ObjectType, ObjectType.MailUser);
  bag.set(Tag.DisplayType, DisplayType.MailUser);
  bag.set(Tag.DisplayName, name);
  bag.set(AbTag.DisplayNamePrintable, name);
  bag.set(Tag.TransmittableDisplayName, name);
  bag.set(Tag.AddressType, 'EX');
  bag.set(Tag.EmailAddress, e.dn);
  bag.set(Tag.SmtpAddress, e.email);
  bag.set(AbTag.Account, localPart(e.email));
  bag.set(AbTag.ProxyAddresses, [`SMTP:${e.email}`, ...e.aliases.map((a) => `smtp:${a}`)]);
  return bag;
}

/** The GAL row of the hierarchy table (MS-OXNSPI 3.1.4.1.3, in the prescribed column order). */
export function galHierarchyRow(unicode: boolean): AbCell[] {
  const name = unicode ? tag(propIdOf(Tag.DisplayName), PropType.String) : tag(propIdOf(Tag.DisplayName), PropType.String8);
  return [
    { kind: 'value', tag: Tag.EntryId, value: addressBookEntryId(GAL_DN, DisplayType.Container) },
    { kind: 'value', tag: AbTag.ContainerFlags, value: GAL_CONTAINER_FLAGS },
    { kind: 'value', tag: Tag.Depth, value: 0 },
    { kind: 'value', tag: AbTag.ContainerId, value: GAL_CONTAINER_ID },
    { kind: 'value', tag: name, value: GAL_DISPLAY_NAME },
    { kind: 'value', tag: AbTag.IsMaster, value: false },
  ];
}

/** NSPI return values (MS-OXNSPI 2.2.1.2). */
export const NspiError = {
  Success: 0x00000000,
  ErrorsReturned: 0x00040380,
  GeneralFailure: 0x80004005,
  NotSupported: 0x80040102,
  NotFound: 0x8004010f,
  TooComplex: 0x80040117,
  TableTooBig: 0x80040403,
  InvalidBookmark: 0x80040405,
} as const;
