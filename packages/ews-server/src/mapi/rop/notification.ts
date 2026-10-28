/**
 * Notification ROP handler (v4.5.0)
 *
 * Implements:
 *   - RopRegisterNotification (MS-OXCNOTIF §2.2.1.2)
 *
 * Workflow:
 *   1) Outlook calls RopRegisterNotification on a folder handle.
 *   2) The subscription is persisted on the handle (subscription field via
 *      dynamic JSON attribute).
 *   3) Outlook polls via the NotificationWait long-poll.
 *   4) The server subscribes to the Redis channel `coremail:mapi:notify:<userId>`.
 *   5) On new mail storeInboundMessage() publishes an event to the
 *      channel.
 *   6) The long-poll handler answers immediately with EventPending=true.
 */

import { createLogger, getRedisClient } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId } from '../rop-types.js';
import { resolveHandleIndex, updateRopObject, type RopObject } from '../rop-handle-table.js';
import type { RopRequest } from '../rop-codec.js';

const log = createLogger('mapi:rop:notification');

/** Redis channel name per user. */
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
 * Response: ReturnValue
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

  // Attach the subscription dynamically to the handle — the JSON round-trip through Redis
  // preserves the field despite the missing type.
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
 * Publishes an event to the user's notify channel. Called (in a next
 * step) by SMTP inbound `storeInboundMessage()` when a new
 * mail lands in the inbox.
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
