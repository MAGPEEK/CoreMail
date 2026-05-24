import { prisma } from '@coremail/storage/prisma';
import { encodeWbxml, el, getText, getChild, type WbxmlElement } from '../wbxml.js';

const WINDOW_SIZE = 25;
const MAX_BODY_LENGTH = 4096;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function buildMessageElement(msg: {
  id: string;
  modSeq: bigint;
  flags: string[];
  subject: string;
  fromAddr: string;
  toAddrs: string[];
  date: Date;
  bodyText: string;
  bodyHtml: string;
}): WbxmlElement {
  const isRead = msg.flags.includes('\\Seen') ? '1' : '0';
  const body = truncate(msg.bodyHtml || msg.bodyText, MAX_BODY_LENGTH);

  return el('ApplicationData', undefined, [
    el('Subject', msg.subject || '(no subject)'),
    el('DateReceived', msg.date.toISOString()),
    el('From', msg.fromAddr),
    el('DisplayTo', msg.toAddrs.join(', ')),
    el('Read', isRead),
    el('Importance', '1'),
    el('Body', body),
    el('BodySize', String(body.length)),
    el('BodyTruncated', body.length < (msg.bodyHtml || msg.bodyText).length ? '1' : '0'),
    el('MessageClass', 'IPM.Note'),
  ]);
}

/**
 * Sync command — bidirectional sync of folder contents
 */
export async function handleSync(
  body: WbxmlElement,
  userId: string,
  deviceId: string,
): Promise<Buffer> {
  const collections = getChild(body, 'Collections');
  if (!collections) {
    return encodeWbxml(el('Sync', undefined, [el('Status', '4')]));
  }

  const device = await prisma.activeSyncDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
  });

  const responseCollections: WbxmlElement[] = [];

  for (const child of collections.children ?? []) {
    if (typeof child === 'string' || child.name !== 'Collection') continue;

    const collectionId = getText(child, 'CollectionId');
    const clientSyncKey = getText(child, 'SyncKey');
    const commands = getChild(child, 'Commands');

    // Verify folder belongs to user
    const folder = await prisma.folder.findFirst({
      where: { id: collectionId, mailbox: { userId } },
    });

    if (!folder) {
      responseCollections.push(el('Collection', undefined, [
        el('Class', 'Email'),
        el('SyncKey', clientSyncKey),
        el('CollectionId', collectionId),
        el('Status', '8'), // object not found
      ]));
      continue;
    }

    // Process client commands (Read, Delete)
    if (commands) {
      for (const cmd of commands.children ?? []) {
        if (typeof cmd === 'string') continue;

        if (cmd.name === 'Change') {
          const serverId = getText(cmd, 'ServerId');
          const appData = getChild(cmd, 'ApplicationData');
          if (appData) {
            const readFlag = getText(appData, 'Read');
            if (readFlag !== undefined) {
              const msg = await prisma.message.findFirst({ where: { id: serverId, folderId: collectionId } });
              if (msg) {
                const flags = readFlag === '1'
                  ? [...msg.flags.filter((f: string) => f !== '\\Seen'), '\\Seen']
                  : msg.flags.filter((f: string) => f !== '\\Seen');
                await prisma.message.update({ where: { id: serverId }, data: { flags, modSeq: BigInt(Date.now()) } });
              }
            }
          }
        } else if (cmd.name === 'Delete') {
          const serverId = getText(cmd, 'ServerId');
          const msg = await prisma.message.findFirst({ where: { id: serverId, folderId: collectionId } });
          if (msg) {
            await prisma.message.update({ where: { id: serverId }, data: { deletedAt: new Date() } });
          }
        }
      }
    }

    // Generate new sync key
    const newSyncKey = String(Date.now());

    // Save sync keys
    if (device) {
      const syncKeys = (device.syncKeys as Record<string, string>) ?? {};
      syncKeys[collectionId] = newSyncKey;
      await prisma.activeSyncDevice.update({
        where: { id: device.id },
        data: { syncKeys, lastSyncAt: new Date() },
      });
    }

    const isInitialSync = clientSyncKey === '0' || !clientSyncKey;

    // Fetch messages to send to client
    const messages = await prisma.message.findMany({
      where: {
        folderId: collectionId,
        deletedAt: null,
        ...(isInitialSync ? {} : { modSeq: { gt: BigInt(clientSyncKey || '0') } }),
      },
      orderBy: { date: 'desc' },
      take: WINDOW_SIZE,
      select: {
        id: true, modSeq: true, flags: true, subject: true,
        fromAddr: true, toAddrs: true, date: true, bodyText: true, bodyHtml: true,
      },
    });

    const serverCommands: WbxmlElement[] = messages.map((msg) =>
      el('Add', undefined, [
        el('ServerId', msg.id),
        buildMessageElement(msg),
      ])
    );

    const moreAvailable = messages.length >= WINDOW_SIZE;

    responseCollections.push(el('Collection', undefined, [
      el('Class', 'Email'),
      el('SyncKey', newSyncKey),
      el('CollectionId', collectionId),
      el('Status', '1'),
      ...(moreAvailable ? [el('MoreAvailable', '')] : []),
      ...(serverCommands.length > 0 ? [el('Commands', undefined, serverCommands)] : []),
    ]));
  }

  return encodeWbxml(el('Sync', undefined, [
    el('Collections', undefined, responseCollections),
  ]));
}
