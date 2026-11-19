/**
 * The PIM classes of ActiveSync (w3): Calendar, Tasks, Notes — Contacts plugs in as one
 * more module. A class module owns everything class-specific (its folders, its items,
 * the WBXML codec, the writers); the generic layer (pim/sync.ts, pim/state.ts and the
 * FolderSync / Ping / GetItemEstimate / MoveItems / ItemOperations hooks) only talks to
 * this interface.
 *
 * Collection ids: `<prefix><key>` — a prefix ends with ':' and never occurs in a mail
 * folder id (cuid), so `moduleFor(collectionId)` needs no database lookup.
 */
import type { WebmailFeature } from '@coremail/storage';
import type { WbxmlElement } from '../wbxml.js';
import type { EasFeature, EasVersion } from '../protocol-version.js';
import type { BodyPreference } from '../commands/body.js';

export type PimClassName = 'Calendar' | 'Tasks' | 'Notes';

/** A FolderSync entry of a class (ParentId is always the root, '0'). */
export interface PimFolder {
  serverId: string;
  displayName: string;
  /** [MS-ASCMD] FolderSync Type: 7 tasks, 8 calendar, 10 notes, 13 user calendar. */
  type: string;
}

/** A collection of the user, resolved and owned. */
export interface PimCollection {
  id: string;
  userId: string;
  /** Class-specific key: the calendar id; the user id for tasks and notes. */
  key: string;
}

/** One item as the change detection sees it. */
export interface PimItemState {
  serverId: string;
  /** Changes whenever the item changes (updatedAt in ms). */
  version: bigint;
  /** Inside the collection's FilterType (only items inside are added to a device). */
  inFilter: boolean;
}

/** The user an item is rendered for / written by. */
export interface PimUser {
  id: string;
  email: string;
  displayName: string;
  /** Own address and active aliases, lower case. */
  addresses: string[];
  /** Settings → Region time zone (IANA), null when not set. */
  timeZone: string | null;
  /** Domain of the user: rooms of this domain are booked by the user's meetings (none without). */
  domainId: string | null;
}

export interface RenderContext {
  version: EasVersion;
  bodyPref: BodyPreference;
  user: PimUser;
}

export interface WriteContext {
  version: EasVersion;
  user: PimUser;
  now: Date;
  /**
   * airsync:Supported of the collection ([MS-ASCMD] 2.2.3.172): an element the client did
   * not list is "ghosted" — absent from a Change means unchanged. Null = no list sent:
   * every absent element is cleared.
   */
  supported: ReadonlySet<string> | null;
  /** Body size the device got (TruncationSize of the collection's options); undefined = full body. */
  truncatedAt?: number;
}

export type WriteResult =
  | {
      ok: true;
      serverId: string;
      version: bigint;
      /**
       * The stored item differs from what the device sent (the server normalised it, e.g. a
       * completed recurring task, a merged duplicate): the device gets it back as a Change.
       */
      normalized?: boolean;
    }
  | { ok: false; status: string };

export interface PimClassModule<Row = unknown> {
  readonly className: PimClassName;
  /** Collection id prefix (ends with ':'). */
  readonly idPrefix: string;
  /** Webmail module that switches the class on and off (9.4 policies). */
  readonly feature: WebmailFeature;
  /** First protocol version with the class (absent = every supported version). */
  readonly protocolFeature?: EasFeature;
  folders(userId: string): Promise<PimFolder[]>;
  /** The collection when `collectionId` is one of the user's, else null. */
  collection(userId: string, collectionId: string): Promise<PimCollection | null>;
  /**
   * The items as the change detection sees them. `held`: the ServerIds the device holds — a
   * module may leave out items outside the FilterType window the device does not hold (they
   * are neither added nor changed), so a Sync does not read a whole calendar history.
   * Without `held` only the in-window items count.
   */
  states(col: PimCollection, filterType: number | undefined, now: Date, held?: ReadonlySet<string>): Promise<PimItemState[]>;
  load(col: PimCollection, ids: string[]): Promise<Row[]>;
  rowId(row: Row): string;
  rowVersion(row: Row): bigint;
  /** Children of airsync:ApplicationData / itemoperations:Properties. */
  render(row: Row, ctx: RenderContext): WbxmlElement[];
  create(col: PimCollection, data: WbxmlElement, ctx: WriteContext): Promise<WriteResult>;
  update(col: PimCollection, serverId: string, data: WbxmlElement, ctx: WriteContext): Promise<WriteResult>;
  /** False when the item is not in the collection. */
  remove(col: PimCollection, serverId: string, ctx: WriteContext): Promise<boolean>;
  /** Cheap change marker of the whole collection (count + newest change) for Ping. */
  fingerprint(col: PimCollection): Promise<string>;
  /** MoveItems inside the class (another collection of the same class); absent = not movable. */
  move?(src: PimCollection, dst: PimCollection, serverId: string, ctx: WriteContext): Promise<WriteResult>;
}

/** Version of a row: its updatedAt in ms. */
export const versionOf = (updatedAt: Date): bigint => BigInt(updatedAt.getTime());

/** [MS-ASCMD] Sync status values of the PIM layer. */
export const PIM_STATUS = {
  SUCCESS: '1',
  INVALID_SYNC_KEY: '3',
  CONVERSION_ERROR: '6',
  OBJECT_NOT_FOUND: '8',
  HIERARCHY_CHANGED: '12',
  RETRY: '16',
} as const;
