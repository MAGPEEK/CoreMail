/**
 * EAS GetItemEstimate ([MS-ASCMD] 2.2.1.9): per collection the number of items the
 * client's next Sync(s) with its SyncKey would deliver — computed by
 * estimateSyncWindow over the same modSeq range as the Sync window.
 * Status (getitemestimate:Status): 1 ok, 2 invalid/foreign collection,
 * 3 sync state not primed (SyncKey 0), 4 invalid SyncKey.
 */
import { prisma } from '@coremail/storage/prisma';
import { ensureCounterFloor } from '@coremail/storage';
import { encodeWbxml, getChild, getText, pel, CP, type WbxmlElement } from '../wbxml.js';
import { estimateSyncWindow, type SyncEstimateDb } from './sync-window.js';

export const GIE_STATUS = { Success: '1', InvalidCollection: '2', NotPrimed: '3', InvalidSyncKey: '4' } as const;

export async function handleGetItemEstimate(body: WbxmlElement, userId: string): Promise<Buffer> {
  const G = CP.GetItemEstimate;
  const collections = getChild(body, 'Collections');
  const responses: WbxmlElement[] = [];
  for (const col of collections?.children ?? []) {
    if (typeof col === 'string' || col.name !== 'Collection') continue;
    const collectionId = getText(col, 'CollectionId');
    const respond = (status: string, estimate?: number) => responses.push(pel(G, 'Response', [
      pel(G, 'Status', status),
      pel(G, 'Collection', [
        pel(G, 'CollectionId', collectionId),
        ...(estimate !== undefined ? [pel(G, 'Estimate', String(estimate))] : []),
      ]),
    ]));

    const folder = collectionId
      ? await prisma.folder.findFirst({ where: { id: collectionId, mailbox: { userId } }, select: { id: true, mailboxId: true } })
      : null;
    if (!folder) { respond(GIE_STATUS.InvalidCollection); continue; }

    await ensureCounterFloor(prisma, folder.mailboxId);
    const est = await estimateSyncWindow(prisma as unknown as SyncEstimateDb, {
      mailboxId: folder.mailboxId, folderId: folder.id, clientSyncKey: getText(col, 'SyncKey'),
    });
    if (est.status === 'not-primed') respond(GIE_STATUS.NotPrimed);
    else if (est.status === 'invalid') respond(GIE_STATUS.InvalidSyncKey);
    else respond(GIE_STATUS.Success, est.estimate);
  }
  if (!collections) {
    responses.push(pel(G, 'Response', [pel(G, 'Status', GIE_STATUS.InvalidCollection)]));
  }
  return encodeWbxml(pel(G, 'GetItemEstimate', responses));
}
