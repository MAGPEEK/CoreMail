/**
 * RopLogon Handler (v4.1.0)
 *
 * MS-OXCSTOR §2.2.1.1 — logon to a mailbox. Outlook calls this as the
 * VERY FIRST ROP after Connect to obtain a mailbox store handle.
 *
 * Request:
 *   LogonId (1B) — already parsed in RopRequest
 *   OutputHandleIndex (1B) — already parsed
 *   LogonFlags (1B)
 *   OpenFlags (4B)
 *   StoreState (4B)
 *   EssdnLen (uint16)
 *   Essdn (ASCII null-terminated)
 *
 * Response (for mailbox logon, MS-OXCSTOR §2.2.1.1.3):
 *   RopId (1B)
 *   OutputHandleIndex (1B)
 *   ReturnValue (uint32)
 *   LogonFlags (1B)
 *   FolderIds (13 × uint64 — Inbox, IPM-Subtree, etc.)
 *   ResponseFlags (1B)
 *   MailboxGuid (16B)
 *   ReplId (uint16)
 *   ReplGuid (16B)
 *   LogonTime (FILETIME 8B)
 *   GwartTime (FILETIME 8B)
 *   StoreState (uint32)
 */

import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId } from '../rop-types.js';
import { dateToFiletime } from '../property-codec.js';
import { cuidToFolderId64 } from '../entry-id.js';
import { putRopObject } from '../rop-handle-table.js';
import type { RopRequest } from '../rop-codec.js';
import type { MapiSessionState } from '../session-store.js';

const log = createLogger('mapi:rop:logon');

/**
 * Generates a deterministic 16-byte GUID from a CUID (for MailboxGuid).
 */
function cuidToGuid(cuid: string): Buffer {
  const buf = Buffer.alloc(16);
  // We take the first 16 ASCII bytes of the CUID (every CUID has 25 characters).
  Buffer.from(cuid.padEnd(16, '0'), 'ascii').copy(buf, 0, 0, 16);
  return buf;
}

export async function handleRopLogon(
  rop: RopRequest,
  sessionToken: string,
  session: MapiSessionState,
): Promise<Buffer> {
  // Parse payload (LogonFlags + OpenFlags + StoreState + EssdnLen + Essdn)
  const r = new MapiReader(rop.payload);
  let logonFlags = 0x01; // default = Private
  try {
    logonFlags = r.readUint8();
    r.readUint32(); // OpenFlags
    r.readUint32(); // StoreState
    const essdnLen = r.readUint16();
    r.readBuffer(Math.min(essdnLen, r.remaining));
  } catch {
    // Broken payload — we continue with defaults.
  }

  // Load the session user's mailbox
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true, email: true, displayName: true,
      mailbox: {
        include: {
          folders: { select: { id: true, name: true, displayName: true } },
        },
      },
    },
  }).catch(() => null);

  if (!user || !user.mailbox) {
    log.warn({ userId: session.userId }, 'RopLogon: user/mailbox not found');
    return writeLogonError(rop, MapiStatusCode.EC_OBJECT_NOT_FOUND);
  }

  // Register the mailbox object in the handle table
  const mailboxHandle = await putRopObject(sessionToken, {
    kind: 'mailbox', userId: user.id,
  });
  if (mailboxHandle === null) {
    return writeLogonError(rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Determine the folder IDs for the standard folders. Outlook expects an array
  // of 13 uint64 IDs in this order (MS-OXCSTOR §2.2.1.1.3.1):
  //   [0] PR_IPM_SUBTREE_ENTRYID
  //   [1] PR_IPM_INBOX_ENTRYID
  //   [2] PR_IPM_OUTBOX_ENTRYID
  //   [3] PR_IPM_SENTMAIL_ENTRYID
  //   [4] PR_IPM_WASTEBASKET_ENTRYID
  //   [5] PR_FINDER_ENTRYID (search root)
  //   [6] PR_VIEWS_ENTRYID
  //   [7] PR_COMMON_VIEWS_ENTRYID
  //   [8] PR_SCHEDULE_ENTRYID
  //   [9] PR_SPOOLER_QUEUE_ENTRYID
  //   [10] Reserved
  //   [11] Reserved
  //   [12] Reserved
  const findFolderId64 = (name: string): bigint => {
    const f = user.mailbox!.folders.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return f ? cuidToFolderId64(f.id) : 0n;
  };

  const inboxId    = findFolderId64('INBOX');
  const draftsId   = findFolderId64('Drafts');
  const sentId     = findFolderId64('Sent');
  const trashId    = findFolderId64('Trash');
  // IPM subtree = the virtual root folder. We use the mailbox ID
  // for it (CoreMail has no separate root folder).
  const subtreeId  = cuidToFolderId64(user.mailbox.id);

  // Assemble response
  const w = new MapiWriter();
  w.writeUint8(RopId.Logon);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);    // ReturnValue
  w.writeUint8(logonFlags);                 // LogonFlags echo
  // 13 × uint64 folder IDs
  w.writeUint64(subtreeId);                 // [0] IPM-Subtree
  w.writeUint64(inboxId);                   // [1] Inbox
  w.writeUint64(draftsId);                  // [2] Outbox (Drafts in our schema)
  w.writeUint64(sentId);                    // [3] SentMail
  w.writeUint64(trashId);                   // [4] Wastebasket
  w.writeUint64(0n);                        // [5] Finder
  w.writeUint64(0n);                        // [6] Views
  w.writeUint64(0n);                        // [7] Common Views
  w.writeUint64(0n);                        // [8] Schedule
  w.writeUint64(0n);                        // [9] Spooler Queue
  w.writeUint64(0n);                        // [10] Reserved
  w.writeUint64(0n);                        // [11] Reserved
  w.writeUint64(0n);                        // [12] Reserved
  w.writeUint8(0x00);                       // ResponseFlags (no OOF)
  w.writeBuffer(cuidToGuid(user.mailbox.id));      // MailboxGuid (16B)
  w.writeUint16(1);                                 // ReplId (= 1 for primary)
  w.writeBuffer(cuidToGuid(user.id));              // ReplGuid
  w.writeUint64(dateToFiletime(new Date()));       // LogonTime
  w.writeUint64(dateToFiletime(new Date()));       // GwartTime
  w.writeUint32(0);                                 // StoreState

  log.info({ userId: user.id, mailboxId: user.mailbox.id, handle: mailboxHandle }, 'RopLogon successful');
  return w.toBuffer();
}

function writeLogonError(rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(RopId.Logon);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}
