/**
 * The configuration of a synchronization download (RopSynchronizationConfigure,
 * MS-OXCFXICS 2.2.3.2.1.1.1) and the property filter it implies (3.2.5.10).
 * Pure module.
 */
import { PropType, propIdOf, propTypeOf, Tag } from '../props/tags.js';
import type { Restriction } from '../props/restriction.js';
import type { SyncKind } from './state.js';

export const SyncType = { Contents: 0x01, Hierarchy: 0x02 } as const;

export const SyncFlag = {
  Unicode: 0x0001,
  NoDeletions: 0x0002,
  IgnoreNoLongerInScope: 0x0004,
  ReadState: 0x0008,
  FAI: 0x0010,
  Normal: 0x0020,
  OnlySpecifiedProperties: 0x0080,
  NoForeignIdentifiers: 0x0100,
  Reserved: 0x1000,
  BestBody: 0x2000,
  IgnoreSpecifiedOnFAI: 0x4000,
  Progress: 0x8000,
} as const;

/** Every flag a client may send (3.2.5.9.1.1: unknown bits fail the ROP). */
export const KNOWN_SYNC_FLAGS = Object.values(SyncFlag).reduce((a, b) => a | b, 0) & ~SyncFlag.Reserved;

export const SyncExtraFlag = { Eid: 0x01, MessageSize: 0x02, CN: 0x04, OrderByDeliveryTime: 0x08 } as const;

export interface SyncConfig {
  kind: SyncKind;
  folderCounter: bigint;
  flags: number;
  extraFlags: number;
  restriction: Restriction | null;
  propertyTags: number[];
}

export const has = (value: number, flag: number): boolean => (value & flag) !== 0;

/** Which message properties and subobjects a download writes. */
export interface PropertyFilter {
  property(tag: number): boolean;
  recipients: boolean;
  attachments: boolean;
}

/**
 * OnlySpecifiedProperties: only the listed properties / subobjects; without
 * it the listed ones are left out (PidTagMessageRecipients and
 * PidTagMessageAttachments name the subobjects).
 */
export function propertyFilter(config: SyncConfig): PropertyFilter {
  const listed = new Set(config.propertyTags.map(propIdOf));
  const only = has(config.flags, SyncFlag.OnlySpecifiedProperties);
  const keep = (tag: number): boolean => (only ? listed.has(propIdOf(tag)) : !listed.has(propIdOf(tag)));
  return {
    property: (tag) => propTypeOf(tag) !== PropType.Object && keep(tag),
    recipients: keep(Tag.MessageRecipients),
    attachments: keep(Tag.MessageAttachments),
  };
}
