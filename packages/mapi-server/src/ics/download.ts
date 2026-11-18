/**
 * A synchronization download (MS-OXCFXICS 3.2.5.9.1): on the first
 * RopFastTransferSourceGetBuffer the scope is read (folder list or the
 * folder's messages, the mailbox modSeq first), the differences are planned
 * against the uploaded initial state (plan.ts) and the stream is produced
 * element by element:
 *   contents:  *messageChange [deletions] [readStateChanges] state IncrSyncEnd
 *   hierarchy: *folderChange  [deletions] state IncrSyncEnd
 * The checkpoint state (RopSynchronizationGetTransferState) reflects the
 * elements handed out so far.
 */
import { lookupProperty } from '../props/bag.js';
import { evaluateRestriction } from '../props/restriction.js';
import { messageSummaryBag } from '../objects/props.js';
import { has, propertyFilter, SyncExtraFlag, SyncFlag, type SyncConfig } from './config.js';
import { deletions, folderChange, messageChange, readStateChanges } from './elements.js';
import { FxWriter, Marker, type FxPiece } from './fx-stream.js';
import { rangesOf } from './globset.js';
import {
  contentsStateAfter, hierarchyStateAfter, isRead, planContents, planHierarchy,
  type ContentsInput, type HierarchyInput,
} from './plan.js';
import { FastTransferSource } from './transfer.js';
import { writeState, type IcsState } from './state.js';
import { refreshView } from '../rop/ops/common.js';
import type { LogonState } from '../objects/state.js';
import type { MailStore, MessageSummary } from '../store/types.js';

export interface DownloadTransfer {
  source: FastTransferSource;
  /** The ICS state matching what was handed out so far. */
  checkpoint(): IcsState;
}

function tail(parts: FxPiece[][], state: IcsState, kind: SyncConfig['kind']): FxPiece[] {
  const w = new FxWriter();
  writeState(w, state, kind, true);
  w.marker(Marker.IncrSyncEnd);
  return [...parts.flat(), ...w.pieces];
}

async function contentsDownload(store: MailStore, logon: LogonState, config: SyncConfig, state: IcsState): Promise<DownloadTransfer> {
  const mailboxId = logon.mailbox.mailboxId;
  const highestModSeq = await store.highestModSeq(mailboxId);
  const view = await refreshView(store, logon);
  const record = view.get(config.folderCounter)?.record ?? null;
  const messages = record ? await store.listMessages(record.id) : [];
  const restriction = config.restriction;
  const inScope = (m: MessageSummary): boolean => {
    if (!restriction) return true;
    const bag = messageSummaryBag(logon, config.folderCounter, m);
    return evaluateRestriction(restriction, (t) => lookupProperty(bag, t));
  };
  const input: ContentsInput = {
    guids: logon.guids, messages, inScope, state, highestModSeq,
    replaced: await store.replacedLocalIds(mailboxId),
    options: {
      normal: has(config.flags, SyncFlag.Normal),
      readState: has(config.flags, SyncFlag.ReadState),
      noDeletions: has(config.flags, SyncFlag.NoDeletions),
      ignoreNoLongerInScope: has(config.flags, SyncFlag.IgnoreNoLongerInScope),
      orderByDeliveryTime: has(config.extraFlags, SyncExtraFlag.OrderByDeliveryTime),
      restricted: restriction !== null,
    },
  };
  const plan = planContents(input);
  const changeCtx = { store, logon, folderCounter: config.folderCounter, config, filter: propertyFilter(config) };
  async function* elements(): AsyncGenerator<FxPiece[]> {
    for (const m of plan.changes) yield await messageChange(changeCtx, m);
    const reads = plan.readChanges.filter(isRead).map((m) => BigInt(m.uid));
    const unreads = plan.readChanges.filter((m) => !isRead(m)).map((m) => BigInt(m.uid));
    yield tail([
      deletions(logon, plan.deleted, plan.noLongerInScope),
      readStateChanges(logon, rangesOf(reads), rangesOf(unreads)),
    ], contentsStateAfter(input, plan, plan.changes.length, true), 'contents');
  }
  const source = new FastTransferSource(elements(), plan.changes.length + 1);
  return {
    source,
    checkpoint: () => contentsStateAfter(input, plan, Math.min(source.completed, plan.changes.length), source.finished),
  };
}

async function hierarchyDownload(store: MailStore, logon: LogonState, config: SyncConfig, state: IcsState): Promise<DownloadTransfer> {
  const view = await refreshView(store, logon);
  const input: HierarchyInput = {
    guids: logon.guids, view, root: config.folderCounter, state,
    noDeletions: has(config.flags, SyncFlag.NoDeletions),
    replaced: await store.replacedLocalIds(logon.mailbox.mailboxId),
  };
  const plan = planHierarchy(input);
  function* elements(): Generator<FxPiece[]> {
    for (const node of plan.changes) yield folderChange(logon, node, config.folderCounter, config);
    yield tail([deletions(logon, plan.deleted, [])], hierarchyStateAfter(input, plan, plan.changes.length, true), 'hierarchy');
  }
  const source = new FastTransferSource(elements(), plan.changes.length + 1);
  return {
    source,
    checkpoint: () => hierarchyStateAfter(input, plan, Math.min(source.completed, plan.changes.length), source.finished),
  };
}

export function startDownload(store: MailStore, logon: LogonState, config: SyncConfig, state: IcsState): Promise<DownloadTransfer> {
  return config.kind === 'contents' ? contentsDownload(store, logon, config, state) : hierarchyDownload(store, logon, config, state);
}
