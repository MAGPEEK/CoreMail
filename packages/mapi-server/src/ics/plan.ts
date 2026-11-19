/**
 * What a synchronization download sends (MS-OXCFXICS 3.2.5.3), from the
 * client's initial ICS state and the server's current objects, and the ICS
 * state after it (the invariants of 3.2.5.3). Pure module.
 *
 * Contents: a message whose CN (modSeq) the client has not seen is sent —
 * as a read-state change when the client has it (ID in IdsetGiven), the
 * download includes read states and nothing else the client shows can have
 * changed: CoreMail never rewrites a stored message (a draft saved again is a
 * new row that keeps the message's ID only through MapiObject, with a new
 * modSeq; a move or a copy is a new UID), so a known ID only changes its
 * flags; besides the read flag the client shows only \Answered, $Forwarded
 * and \Draft, which mean a full change. Everything else is a full message
 * change. A CN the client recorded as its own read-state upload (CnsetRead
 * of the upload context, merged into its state) is not sent back.
 * Message IDs are messageCounter(): a client-assigned ID, else the UID.
 *
 * Deletions: IDs of IdsetGiven that are no longer in the folder (deleted,
 * expunged, moved away) — server IDs (UIDs; folder IDs for the hierarchy) and
 * client-assigned IDs the server knows (kept by an object, live or retired, or
 * replaced by a server ID). Other client-assigned IDs (folder associated
 * information the server does not keep) are left alone. Known messages that
 * no longer match the restriction are reported as no longer in scope.
 *
 * Final state: given IDs + sent − deleted; CnsetSeen / CnsetRead + the CNs
 * sent. After a complete unrestricted contents download every CN up to the
 * mailbox's highest modSeq read before the folder was listed is seen (every
 * message of the folder at or below it was sent or already known; a message
 * that enters the folder later gets a newer modSeq), which keeps the state
 * one compact range.
 */
import { intersect, rangesOf, subtract, union, type Range } from './globset.js';
import { folderChangeNumber, messageCounter } from './keys.js';
import { emptyState, type IcsState } from './state.js';
import { SpecialCounter, type StoreGuids } from '../ids.js';
import type { FolderNode, MailboxView } from '../objects/mailbox-view.js';
import type { MessageSummary } from '../store/types.js';

const SEEN = '\\Seen';
const FULL_CHANGE_FLAGS = ['\\Answered', '$Forwarded', '\\Draft'];
const UID_RANGE: Range = { low: 1n, high: 0xffff_ffffn };
const FOLDER_RANGES: Range[] = [
  { low: SpecialCounter.Root, high: SpecialCounter.Shortcuts },
  { low: 0x8000_0000_0000n, high: 0xffff_ffff_ffffn },
];

export interface ContentsOptions {
  /** Normal messages are synchronized (SynchronizationFlags Normal). */
  normal: boolean;
  readState: boolean;
  noDeletions: boolean;
  ignoreNoLongerInScope: boolean;
  /** Newest first (SynchronizationExtraFlags OrderByDeliveryTime). */
  orderByDeliveryTime: boolean;
  /** A restriction limits the scope. */
  restricted: boolean;
}

export interface ContentsInput {
  guids: StoreGuids;
  /** Live messages of the folder. */
  messages: readonly MessageSummary[];
  inScope: (m: MessageSummary) => boolean;
  state: IcsState;
  options: ContentsOptions;
  /** Mailbox modSeq read before the folder was listed. */
  highestModSeq: bigint;
  /** Client-assigned IDs of IdsetGiven the server knows (kept by an object, live or retired; replaced). */
  knownClientIds: ReadonlySet<bigint>;
}

export interface ContentsPlan {
  /** Full message changes in send order. */
  changes: MessageSummary[];
  /** Known messages whose only change is the read state. */
  readChanges: MessageSummary[];
  deleted: Range[];
  noLongerInScope: Range[];
}

/** IDs of IdsetGiven the server may report deleted: its own IDs and the client IDs it knows. */
function deletable(given: readonly Range[], knownClientIds: ReadonlySet<bigint>, server: readonly Range[]): Range[] {
  return intersect(given, union(server, rangesOf(knownClientIds)));
}

export function planContents(input: ContentsInput): ContentsPlan {
  const { guids, state, options } = input;
  const replica = guids.replica;
  const given = state.idsetGiven.ranges(replica);
  const inScope = input.messages.filter(input.inScope);
  const changes: MessageSummary[] = [];
  const readChanges: MessageSummary[] = [];
  if (options.normal) {
    for (const m of inScope) {
      if (state.cnsetSeen.has(replica, m.modSeq)) continue;
      const known = state.idsetGiven.has(replica, messageCounter(m));
      if (known && state.cnsetRead.has(replica, m.modSeq)) continue; // the client's own read-state upload
      const onlyRead = known && options.readState && !m.flags.some((f) => FULL_CHANGE_FLAGS.includes(f));
      (onlyRead ? readChanges : changes).push(m);
    }
  }
  const order = options.orderByDeliveryTime
    ? (a: MessageSummary, b: MessageSummary): number => b.createdAt.getTime() - a.createdAt.getTime() || b.uid - a.uid
    : (a: MessageSummary, b: MessageSummary): number => a.uid - b.uid;
  changes.sort(order);

  let deleted: Range[] = [];
  let noLongerInScope: Range[] = [];
  if (!options.noDeletions) {
    const present = rangesOf(input.messages.map(messageCounter));
    deleted = subtract(deletable(given, input.knownClientIds, [UID_RANGE]), present);
    if (!options.ignoreNoLongerInScope) {
      const outOfScope = rangesOf(input.messages.filter((m) => !input.inScope(m)).map(messageCounter));
      noLongerInScope = intersect(given, outOfScope);
    }
  }
  return { changes, readChanges, deleted, noLongerInScope };
}

/**
 * The ICS state after `sent` full changes; `complete` = the whole stream
 * (deletions and read-state changes included) went out.
 */
export function contentsStateAfter(input: ContentsInput, plan: ContentsPlan, sent: number, complete: boolean): IcsState {
  const replica = input.guids.replica;
  const out = emptyState();
  const changes = plan.changes.slice(0, sent);
  const reads = complete ? plan.readChanges : [];
  const sentCns = rangesOf([...changes, ...reads].map((m) => m.modSeq));
  const allSeen: Range[] = complete && input.options.normal && !input.options.restricted
    ? [{ low: 1n, high: input.highestModSeq }]
    : [];
  out.idsetGiven = input.state.idsetGiven.clone().add(replica, changes.map(messageCounter));
  if (complete) out.idsetGiven.removeRanges(replica, plan.deleted).removeRanges(replica, plan.noLongerInScope);
  out.cnsetSeen = input.state.cnsetSeen.clone().addRanges(replica, union(sentCns, allSeen));
  out.cnsetRead = input.state.cnsetRead.clone().addRanges(replica, union(sentCns, allSeen));
  out.cnsetSeenFai = input.state.cnsetSeenFai.clone();
  return out;
}

export function isRead(m: MessageSummary): boolean {
  return m.flags.includes(SEEN);
}

// ── Hierarchy ────────────────────────────────────────────────────────────────

export interface HierarchyInput {
  guids: StoreGuids;
  view: MailboxView;
  /** Folder the synchronization was configured on. */
  root: bigint;
  state: IcsState;
  noDeletions: boolean;
  /** Client-assigned folder IDs of IdsetGiven the server knows (kept by a folder, live or retired; replaced). */
  knownClientIds: ReadonlySet<bigint>;
}

export interface HierarchyPlan {
  /** Every folder below the synchronization root, parents before children. */
  inScope: FolderNode[];
  /** New or changed folders, parents before children. */
  changes: FolderNode[];
  deleted: Range[];
}

export function planHierarchy(input: HierarchyInput): HierarchyPlan {
  const replica = input.guids.replica;
  const inScope = input.view.descendants(input.root).map((d) => d.node);
  const changes = inScope.filter((node) => !input.state.cnsetSeen.has(replica, folderChangeNumber(node)));
  let deleted: Range[] = [];
  if (!input.noDeletions) {
    // Folders the client has that left the synchronization scope (deleted, or moved out of the root's subtree).
    const present = rangesOf(inScope.map((n) => n.counter).concat(input.root));
    deleted = subtract(deletable(input.state.idsetGiven.ranges(replica), input.knownClientIds, FOLDER_RANGES), present);
  }
  return { inScope, changes, deleted };
}

/**
 * The ICS state after `sent` folder changes. A folder's CN is derived from
 * what the hierarchy shows (keys.ts), so it recurs when a folder returns to an
 * earlier state (renamed or moved back): the final CnsetSeen therefore names
 * exactly the CNs of the folders in scope — all of them were sent or already
 * seen — instead of every CN ever seen, so such a return is sent again.
 */
export function hierarchyStateAfter(input: HierarchyInput, plan: HierarchyPlan, sent: number, complete: boolean): IcsState {
  const replica = input.guids.replica;
  const changes = plan.changes.slice(0, sent);
  const out = emptyState();
  out.idsetGiven = input.state.idsetGiven.clone().add(replica, changes.map((n) => n.counter));
  if (complete) out.idsetGiven.removeRanges(replica, plan.deleted);
  out.cnsetSeen = complete
    ? input.state.cnsetSeen.clone().setRanges(replica, rangesOf(plan.inScope.map(folderChangeNumber)))
    : input.state.cnsetSeen.clone().add(replica, changes.map(folderChangeNumber));
  return out;
}
