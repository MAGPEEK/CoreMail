/**
 * Notification-ROP-Handler (v4.5.0)
 *
 * Implementiert:
 *   - RopRegisterNotification (MS-OXCNOTIF §2.2.1.2)
 *
 * Workflow:
 *   1) Outlook ruft RopRegisterNotification auf einem Folder-Handle auf.
 *   2) Subscription wird am Handle persistiert (subscription-Feld via
 *      dynamic JSON-Attribut).
 *   3) Outlook polled via NotificationWait long-poll.
 *   4) Server subscribed Redis-Channel `coremail:mapi:notify:<userId>`.
 *   5) Bei neuer Mail published storeInboundMessage() ein Event auf den
 *      Channel.
 *   6) Long-poll-Handler antwortet sofort mit EventPending=true.
 */

import { createLogger, getRedisClient } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId } from '../rop-types.js';
import { resolveHandleIndex, updateRopObject, type RopObject } from '../rop-handle-table.js';
import type { RopRequest } from '../rop-codec.js';

const log = createLogger('mapi:rop:notification');

/** Redis-Channel-Name pro User. */
export function notifyChannelFor(userId: string): string {
  return `coremail:mapi:notify:${userId}`;
}

export interface NotifyEvent {
  kind: 'NewMail' | 'MessageDeleted' | 'MessageModified' | 'FolderChanged';
  userId: string;
  folderId?: string;
  messageId?: string;
  subject?: string;
}

/**
 * v4.5.0: RopRegisterNotification
 *
 * Payload: NotificationTypes(uint16) | Reserved(uint8) | WantWholeStore(uint8)
 *        | [FolderId(uint64) | MessageId(uint64)]?
 *
 * Antwort: ReturnValue
 */
export async function handleRopRegisterNotification(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input) {
    return writeNotifyError(RopId.RegisterNotification, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  let notificationTypes = 0;
  try {
    const r = new MapiReader(rop.payload);
    notificationTypes = r.readUint16();
    r.readUint8();    // Reserved
    r.readUint8();    // WantWholeStore
  } catch (err) {
    log.warn({ err }, 'RegisterNotification: Payload-Parse-Fehler');
  }

  // Subscription dynamisch am Handle anhängen — JSON-Round-Trip durch Redis
  // erhält das Feld trotz fehlendem Type.
  const patched = {
    ...input.object,
    subscription: { notificationTypes, registeredAt: Date.now() },
  } as unknown as Partial<RopObject>;
  await updateRopObject(sessionToken, input.handle, patched);

  log.debug({ notificationTypes, handle: input.handle, kind: input.object.kind }, 'RegisterNotification OK');
  const w = new MapiWriter();
  w.writeUint8(RopId.RegisterNotification);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

/**
 * Published ein Event auf den User-Notify-Channel. Wird (in einem nächsten
 * Step) von SMTP-Inbound `storeInboundMessage()` aufgerufen wenn eine neue
 * Mail in der Inbox landet.
 */
export async function publishNotifyEvent(event: NotifyEvent): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.publish(notifyChannelFor(event.userId), JSON.stringify(event));
    log.debug({ event }, 'publishNotifyEvent OK');
  } catch (err) {
    log.warn({ err }, 'publishNotifyEvent fehlgeschlagen');
  }
}

function writeNotifyError(ropId: number, rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(ropId);
  w.writeUint8(rop.outputHandleIndex ?? rop.inputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}
