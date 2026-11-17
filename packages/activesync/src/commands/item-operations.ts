/**
 * EAS ItemOperations ([MS-ASCMD] 2.2.1.10) for the mailbox store:
 *  - Fetch by airsyncbase:FileReference → attachment bytes (base64 itemoperations:Data,
 *    optional Range/Total),
 *  - Fetch by airsync:CollectionId + ServerId → the full message (Email properties +
 *    airsyncbase:Body per BodyPreference/MIMESupport, MIME byte-exact),
 *  - EmptyFolderContents → every message of the folder deleted through the message store.
 * Ownership is checked exactly like Sync/GetAttachment: the folder / message /
 * attachment must belong to the authenticated user's mailbox; anything else is
 * reported as "not found" (no existence oracle).
 * The response is always inline WBXML (no multipart, MS-ASAcceptMultiPart ignored).
 * 12.1 uses the same operations; the fetched item follows the version's schema (body.ts).
 */
import { prisma } from '@coremail/storage/prisma';
import { expunge } from '@coremail/storage';
import { downloadBuffer } from '@coremail/storage/minio';
import { encodeWbxml, getChild, getText, pel, CP, type WbxmlElement } from '../wbxml.js';
import {
  parseBodyOptions, chooseBodyPreference, buildEmailProperties, EAS_MESSAGE_SELECT, EAS_ATTACHMENT_SELECT,
  type EasMessage, type LoadRaw,
} from './body.js';
import { defaultLoadRaw } from './sync.js';
import { HIGHEST_EAS_VERSION, type EasVersion } from '../protocol-version.js';

// itemoperations:Status ([MS-ASCMD] 2.2.3.177.7)
export const IO_STATUS = {
  Success: '1', ProtocolError: '2', ServerError: '3', NotFound: '6',
  BadRange: '8', UnknownStore: '9', InvalidAttachment: '15', AccessDenied: '16',
} as const;

export interface ItemOperationsDeps {
  /** Attachment of a message in one of the user's folders (not deleted), else null. */
  findAttachment(id: string, userId: string): Promise<{ mimeType: string; size: number; storagePath: string | null } | null>;
  readAttachment(storagePath: string): Promise<Buffer>;
  /** Folder of the user's mailbox, else null. */
  findFolder(id: string, userId: string): Promise<{ id: string; mailboxId: string } | null>;
  /** Message `id` in `folderId` (not deleted) with its attachments, else null. */
  findMessage(id: string, folderId: string): Promise<EasMessage | null>;
  loadRaw: LoadRaw;
  /** Deletes every (non-deleted) message of the folder; returns the count. */
  emptyFolder(folderId: string, mailboxId: string): Promise<number>;
  warn?(msg: string, err: unknown): void;
}

/** "start-end" (inclusive, [MS-ASCMD] 2.2.3.140) → [start, end]; null when malformed. */
export function parseRange(s: string): [number, number] | null {
  const m = /^(\d{1,10})-(\d{1,10})$/.exec(s);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return a <= b ? [a, b] : null;
}

function isMailboxStore(fetch: WbxmlElement): boolean {
  const store = getText(fetch, 'Store');
  return store === '' || store.toLowerCase() === 'mailbox';
}

async function fetchAttachment(fetch: WbxmlElement, ref: string, userId: string, deps: ItemOperationsDeps): Promise<WbxmlElement> {
  const fail = (status: string) => pel(CP.ItemOperations, 'Fetch', [
    pel(CP.ItemOperations, 'Status', status),
    pel(CP.AirSyncBase, 'FileReference', ref),
  ]);
  const att = await deps.findAttachment(ref, userId);
  if (!att || !att.storagePath) return fail(IO_STATUS.InvalidAttachment);
  let data: Buffer;
  try {
    data = await deps.readAttachment(att.storagePath);
  } catch (err) {
    deps.warn?.('EAS ItemOperations attachment object not readable', err);
    return fail(IO_STATUS.InvalidAttachment);
  }
  const props: WbxmlElement[] = [pel(CP.AirSyncBase, 'ContentType', att.mimeType || 'application/octet-stream')];
  const rangeText = getText(getChild(fetch, 'Options') ?? { name: 'Options' }, 'Range');
  if (rangeText) {
    const range = parseRange(rangeText);
    if (!range || (data.length > 0 && range[0] >= data.length)) return fail(IO_STATUS.BadRange);
    const end = Math.min(range[1], data.length - 1);
    const part = data.subarray(range[0], end + 1);
    props.push(pel(CP.ItemOperations, 'Range', `${range[0]}-${Math.max(range[0], end)}`));
    props.push(pel(CP.ItemOperations, 'Total', String(data.length)));
    props.push(pel(CP.ItemOperations, 'Data', part.toString('base64')));
  } else {
    props.push(pel(CP.ItemOperations, 'Data', data.toString('base64')));
  }
  return pel(CP.ItemOperations, 'Fetch', [
    pel(CP.ItemOperations, 'Status', IO_STATUS.Success),
    pel(CP.AirSyncBase, 'FileReference', ref),
    pel(CP.ItemOperations, 'Properties', props),
  ]);
}

async function fetchItem(
  fetch: WbxmlElement, collectionId: string, serverId: string, userId: string, deps: ItemOperationsDeps, version: EasVersion,
): Promise<WbxmlElement> {
  const ids = [pel(CP.AirSync, 'CollectionId', collectionId), pel(CP.AirSync, 'ServerId', serverId)];
  const fail = (status: string) => pel(CP.ItemOperations, 'Fetch', [pel(CP.ItemOperations, 'Status', status), ...ids]);
  const folder = await deps.findFolder(collectionId, userId);
  if (!folder) return fail(IO_STATUS.NotFound);
  const msg = await deps.findMessage(serverId, folder.id);
  if (!msg) return fail(IO_STATUS.NotFound);
  // Options without TruncationSize → the whole body (that is the point of Fetch)
  const pref = chooseBodyPreference(parseBodyOptions(fetch) ?? { prefs: [{ type: 1, allOrNone: false }], mimeSupport: 0 }, msg);
  let props: WbxmlElement[];
  try {
    props = await buildEmailProperties(msg, pref, deps.loadRaw, version);
  } catch (err) {
    deps.warn?.('EAS ItemOperations message source not readable', err);
    return fail(IO_STATUS.ServerError);
  }
  return pel(CP.ItemOperations, 'Fetch', [
    pel(CP.ItemOperations, 'Status', IO_STATUS.Success),
    ...ids,
    pel(CP.AirSync, 'Class', 'Email'),
    pel(CP.ItemOperations, 'Properties', props),
  ]);
}

async function emptyFolderContents(op: WbxmlElement, userId: string, deps: ItemOperationsDeps): Promise<WbxmlElement> {
  const collectionId = getText(op, 'CollectionId');
  const out = (status: string) => pel(CP.ItemOperations, 'EmptyFolderContents', [
    pel(CP.ItemOperations, 'Status', status),
    pel(CP.AirSync, 'CollectionId', collectionId),
  ]);
  const folder = collectionId ? await deps.findFolder(collectionId, userId) : null;
  if (!folder) return out(IO_STATUS.NotFound);
  await deps.emptyFolder(folder.id, folder.mailboxId);
  return out(IO_STATUS.Success);
}

export async function handleItemOperations(
  body: WbxmlElement, userId: string, deps: ItemOperationsDeps, version: EasVersion = HIGHEST_EAS_VERSION,
): Promise<Buffer> {
  if (body.name !== 'ItemOperations') {
    return encodeWbxml(pel(CP.ItemOperations, 'ItemOperations', [pel(CP.ItemOperations, 'Status', IO_STATUS.ProtocolError)]));
  }
  const results: WbxmlElement[] = [];
  for (const op of body.children ?? []) {
    if (typeof op === 'string') continue;
    if (op.name === 'Fetch') {
      const ref = getText(op, 'FileReference');
      const collectionId = getText(op, 'CollectionId');
      const serverId = getText(op, 'ServerId');
      if (!isMailboxStore(op)) {
        results.push(pel(CP.ItemOperations, 'Fetch', [pel(CP.ItemOperations, 'Status', IO_STATUS.UnknownStore)]));
      } else if (ref) {
        results.push(await fetchAttachment(op, ref, userId, deps));
      } else if (collectionId && serverId) {
        results.push(await fetchItem(op, collectionId, serverId, userId, deps, version));
      } else {
        // LongId (Search results) and document library links are not supported
        results.push(pel(CP.ItemOperations, 'Fetch', [pel(CP.ItemOperations, 'Status', IO_STATUS.ProtocolError)]));
      }
    } else if (op.name === 'EmptyFolderContents') {
      results.push(await emptyFolderContents(op, userId, deps));
    } else {
      // Move (conversations) is not supported
      results.push(pel(CP.ItemOperations, op.name === 'Move' ? 'Move' : 'Fetch', [pel(CP.ItemOperations, 'Status', IO_STATUS.ProtocolError)]));
    }
  }
  return encodeWbxml(pel(CP.ItemOperations, 'ItemOperations', [
    pel(CP.ItemOperations, 'Status', IO_STATUS.Success),
    pel(CP.ItemOperations, 'Response', results),
  ]));
}

const EMPTY_BATCH = 500;

/** Production wiring: Prisma (same ownership filters as Sync/GetAttachment) + MinIO. */
export function prismaItemOperationsDeps(warn?: (msg: string, err: unknown) => void): ItemOperationsDeps {
  return {
    findAttachment: (id, userId) => prisma.attachment.findFirst({
      where: { id, message: { deletedAt: null, folder: { mailbox: { userId } } } },
      select: { mimeType: true, size: true, storagePath: true },
    }),
    readAttachment: (storagePath) => downloadBuffer(storagePath),
    findFolder: (id, userId) => prisma.folder.findFirst({ where: { id, mailbox: { userId } }, select: { id: true, mailboxId: true } }),
    findMessage: async (id, folderId) => {
      const row = await prisma.message.findFirst({ where: { id, folderId, deletedAt: null }, select: EAS_MESSAGE_SELECT });
      if (!row) return null;
      const atts = await prisma.attachment.findMany({ where: { messageId: id }, orderBy: { createdAt: 'asc' }, select: EAS_ATTACHMENT_SELECT });
      return { ...row, attachments: atts.map(({ messageId: _m, ...a }) => a) };
    },
    loadRaw: defaultLoadRaw,
    emptyFolder: async (folderId, mailboxId) => {
      let total = 0;
      for (;;) {
        const rows = await prisma.message.findMany({ where: { folderId, deletedAt: null }, select: { id: true }, take: EMPTY_BATCH });
        if (rows.length === 0) return total;
        await prisma.$transaction((tx) => expunge(tx, rows.map((r) => r.id), { mailboxId }));
        total += rows.length;
        if (rows.length < EMPTY_BATCH) return total;
      }
    },
    ...(warn ? { warn } : {}),
  };
}