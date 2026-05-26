/**
 * RopLogon Handler (v4.1.0)
 *
 * MS-OXCSTOR §2.2.1.1 — Login zu einer Mailbox. Outlook ruft das als
 * ALLERSTEN ROP nach Connect auf, um ein Mailbox-Store-Handle zu bekommen.
 *
 * Request:
 *   LogonId (1B) — schon im RopRequest parsed
 *   OutputHandleIndex (1B) — schon parsed
 *   LogonFlags (1B)
 *   OpenFlags (4B)
 *   StoreState (4B)
 *   EssdnLen (uint16)
 *   Essdn (ASCII null-terminated)
 *
 * Response (für Mailbox-Logon, MS-OXCSTOR §2.2.1.1.3):
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
 * Generiert eine deterministische 16-Byte-GUID aus einem CUID (für MailboxGuid).
 */
function cuidToGuid(cuid: string): Buffer {
  const buf = Buffer.alloc(16);
  // Wir nehmen die ersten 16 ASCII-Bytes des CUID (jedes CUID hat 25 Zeichen).
  Buffer.from(cuid.padEnd(16, '0'), 'ascii').copy(buf, 0, 0, 16);
  return buf;
}

export async function handleRopLogon(
  rop: RopRequest,
  sessionToken: string,
  session: MapiSessionState,
): Promise<Buffer> {
  // Payload parsen (LogonFlags + OpenFlags + StoreState + EssdnLen + Essdn)
  const r = new MapiReader(rop.payload);
  let logonFlags = 0x01; // default = Private
  try {
    logonFlags = r.readUint8();
    r.readUint32(); // OpenFlags
    r.readUint32(); // StoreState
    const essdnLen = r.readUint16();
    r.readBuffer(Math.min(essdnLen, r.remaining));
  } catch {
    // Defekter Payload — wir fahren mit Defaults fort.
  }

  // Mailbox des Session-Users laden
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
    log.warn({ userId: session.userId }, 'RopLogon: User/Mailbox nicht gefunden');
    return writeLogonError(rop, MapiStatusCode.EC_OBJECT_NOT_FOUND);
  }

  // Mailbox-Object in Handle-Table eintragen
  const mailboxHandle = await putRopObject(sessionToken, {
    kind: 'mailbox', userId: user.id,
  });
  if (mailboxHandle === null) {
    return writeLogonError(rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Folder-IDs für die Standard-Ordner ermitteln. Outlook erwartet einen Array
  // von 13 uint64-IDs in dieser Reihenfolge (MS-OXCSTOR §2.2.1.1.3.1):
  //   [0] PR_IPM_SUBTREE_ENTRYID
  //   [1] PR_IPM_INBOX_ENTRYID
  //   [2] PR_IPM_OUTBOX_ENTRYID
  //   [3] PR_IPM_SENTMAIL_ENTRYID
  //   [4] PR_IPM_WASTEBASKET_ENTRYID
  //   [5] PR_FINDER_ENTRYID (Search-Root)
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
  // IPM-Subtree = der virtuelle Root-Ordner. Wir verwenden den Mailbox-ID
  // dafür (CoreMail hat keinen separaten Root-Folder).
  const subtreeId  = cuidToFolderId64(user.mailbox.id);

  // Response zusammenbauen
  const w = new MapiWriter();
  w.writeUint8(RopId.Logon);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);    // ReturnValue
  w.writeUint8(logonFlags);                 // LogonFlags echo
  // 13 × uint64 Folder-IDs
  w.writeUint64(subtreeId);                 // [0] IPM-Subtree
  w.writeUint64(inboxId);                   // [1] Inbox
  w.writeUint64(draftsId);                  // [2] Outbox (Drafts in unserem Schema)
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
  w.writeUint16(1);                                 // ReplId (= 1 für Primary)
  w.writeBuffer(cuidToGuid(user.id));              // ReplGuid
  w.writeUint64(dateToFiletime(new Date()));       // LogonTime
  w.writeUint64(dateToFiletime(new Date()));       // GwartTime
  w.writeUint32(0);                                 // StoreState

  log.info({ userId: user.id, mailboxId: user.mailbox.id, handle: mailboxHandle }, 'RopLogon erfolgreich');
  return w.toBuffer();
}

function writeLogonError(rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(RopId.Logon);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}
