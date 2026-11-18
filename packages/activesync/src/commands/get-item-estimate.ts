/**
 * EAS GetItemEstimate ([MS-ASCMD] 2.2.1.9): per collection the number of items the
 * client's next Sync(s) with its SyncKey would deliver.
 *
 * 8.0.0: with a registered device the estimate follows the Sync rules exactly — over the
 * same modSeq range: Adds for items the device does not hold (inside the FilterType age
 * window), Changes for held items at an older modSeq, Deletes for held items that left
 * the folder. Items the device already holds at their current modSeq (its own changes)
 * are not counted. Without a device row: the raw count of the modSeq range (as before).
 * Status (getitemestimate:Status): 1 ok, 2 invalid/foreign collection,
 * 3 sync state not primed (SyncKey 0), 4 invalid SyncKey.
 * 12.1: FilterType and Class are direct children of the request Collection (14.0+:
 * FilterType inside airsync:Options, no Class); the response echoes the Class — [MS-ASCMD]
 * 2.2.3.29.1 lists getitemestimate:Class as a child of the response Collection up to 12.1.
 */
import { prisma } from '@coremail/storage/prisma';
import { ensureCounterFloor } from '@coremail/storage';
import { encodeWbxml, getChild, getText, pel, CP, type WbxmlElement } from '../wbxml.js';
import { estimateSyncWindow, syncRange, type SyncEstimateDb } from './sync-window.js';
import { filterCutoff, parseBodyOptions, parseFilterType } from './body.js';
import { knownItems } from './item-state.js';
import { departedItems } from './sync.js';
import { storedOptions } from './sync-options.js';
import { HIGHEST_EAS_VERSION, supports, type EasVersion } from '../protocol-version.js';
import { moduleFor } from '../pim/registry.js';
import { estimatePimCollection, type PimEstimate } from '../pim/estimate.js';

export const GIE_STATUS = { Success: '1', InvalidCollection: '2', NotPrimed: '3', InvalidSyncKey: '4' } as const;

const PIM_ESTIMATE_STATUS: Record<Exclude<PimEstimate['status'], 'ok'>, string> = {
  'invalid-collection': GIE_STATUS.InvalidCollection,
  'not-primed': GIE_STATUS.NotPrimed,
  'invalid-key': GIE_STATUS.InvalidSyncKey,
};

/** FilterType of a request Collection: airsync:Options (14.0+) or the direct child (12.1). */
export function requestFilterType(collection: WbxmlElement): number | undefined {
  return parseBodyOptions(collection)?.filterType ?? parseFilterType(getText(collection, 'FilterType'));
}

export async function handleGetItemEstimate(
  body: WbxmlElement,
  userId: string,
  deviceId?: string,
  now: () => Date = () => new Date(),
  version: EasVersion = HIGHEST_EAS_VERSION,
): Promise<Buffer> {
  const G = CP.GetItemEstimate;
  const collections = getChild(body, 'Collections');
  const device = deviceId
    ? await prisma.activeSyncDevice.findUnique({ where: { userId_deviceId: { userId, deviceId } }, select: { id: true, syncKeys: true } })
    : null;
  const syncKeys = (device?.syncKeys as Record<string, string> | null) ?? {};
  const responses: WbxmlElement[] = [];
  for (const col of collections?.children ?? []) {
    if (typeof col === 'string' || col.name !== 'Collection') continue;
    const collectionId = getText(col, 'CollectionId');
    const cls = supports(version, 'estimateOptions') ? '' : getText(col, 'Class');
    const respond = (status: string, estimate?: number) => responses.push(pel(G, 'Response', [
      pel(G, 'Status', status),
      pel(G, 'Collection', [
        ...(cls ? [pel(G, 'Class', cls)] : []),
        pel(G, 'CollectionId', collectionId),
        ...(estimate !== undefined ? [pel(G, 'Estimate', String(estimate))] : []),
      ]),
    ]));

    // w3: calendar, tasks and notes collections
    if (moduleFor(collectionId)) {
      const est = await estimatePimCollection({
        userId, deviceRowId: device?.id ?? null, version, syncKeys, collectionId, clientSyncKey: getText(col, 'SyncKey'),
        filterType: requestFilterType(col) ?? storedOptions(syncKeys, collectionId)?.filterType, now: now(),
      });
      if (est.status === 'ok') respond(GIE_STATUS.Success, est.estimate); else respond(PIM_ESTIMATE_STATUS[est.status]);
      continue;
    }

    const folder = collectionId
      ? await prisma.folder.findFirst({ where: { id: collectionId, mailbox: { userId } }, select: { id: true, mailboxId: true } })
      : null;
    if (!folder) { respond(GIE_STATUS.InvalidCollection); continue; }

    await ensureCounterFloor(prisma, folder.mailboxId);
    const clientSyncKey = getText(col, 'SyncKey');
    if (!device) {
      const est = await estimateSyncWindow(prisma as unknown as SyncEstimateDb, {
        mailboxId: folder.mailboxId, folderId: folder.id, clientSyncKey,
      });
      if (est.status === 'not-primed') respond(GIE_STATUS.NotPrimed);
      else if (est.status === 'invalid') respond(GIE_STATUS.InvalidSyncKey);
      else respond(GIE_STATUS.Success, est.estimate);
      continue;
    }

    const range = await syncRange(prisma as unknown as SyncEstimateDb, { mailboxId: folder.mailboxId, clientSyncKey });
    if (range.status === 'not-primed') { respond(GIE_STATUS.NotPrimed); continue; }
    if (range.status === 'invalid') { respond(GIE_STATUS.InvalidSyncKey); continue; }

    // Same FilterType source as Sync: the request's Options, else the sticky Sync options.
    const filterType = requestFilterType(col) ?? storedOptions(syncKeys, folder.id)?.filterType;
    const cutoff = filterCutoff(filterType, now());
    const rows = await prisma.message.findMany({
      where: { folderId: folder.id, deletedAt: null, modSeq: { gte: range.since, lt: range.upper } },
      select: { id: true, modSeq: true, date: true },
    });
    const known = await knownItems(device.id, folder.id, rows.map((r) => r.id));
    let estimate = 0;
    for (const r of rows) {
      const k = known.get(r.id);
      if (k === undefined) { if (!(cutoff && r.date < cutoff)) estimate++; } // Add
      else if (k < r.modSeq) estimate++; // Change
    }
    estimate += (await departedItems(device.id, folder.mailboxId, folder.id, range.since, range.upper)).length; // Delete
    respond(GIE_STATUS.Success, estimate);
  }
  if (!collections) {
    responses.push(pel(G, 'Response', [pel(G, 'Status', GIE_STATUS.InvalidCollection)]));
  }
  return encodeWbxml(pel(G, 'GetItemEstimate', responses));
}
