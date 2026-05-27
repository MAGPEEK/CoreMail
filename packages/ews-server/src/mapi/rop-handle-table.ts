/**
 * ROP Object-Handle-Table (v4.1.0)
 *
 * Outlook hält pro MAPI-Session ein "ServerObjectHandleTable" — eine Liste
 * von uint32-Handles, die Server-seitige Objekte (Mailbox, Folder, Message,
 * Stream, Attachment, Table) repräsentieren. Jeder ROP referenziert
 * Input/Output über einen INDEX in diese Tabelle.
 *
 * Wir persistieren die Tabelle in Redis (über `session-store.ts`). Hier
 * definieren wir die typed Object-Descriptors und Helper.
 */

import {
  getMapiSession, allocateRopHandle,
  type MapiSessionState,
} from './session-store.js';

/** Typed Object-Descriptor — was hinter einem ROP-Handle steckt. */
export type RopObject =
  | { kind: 'mailbox'; userId: string }
  | { kind: 'folder';  userId: string; folderId: string; folderName: string }
  | { kind: 'message'; userId: string; folderId: string;
      /**
       * `messageId === null` markiert eine NEUE Draft, die noch nicht in der DB persistiert
       * ist (v4.3.0 — RopCreateMessage erzeugt das Handle ohne sofortigen DB-Schreibvorgang;
       * `pendingProperties` + `pendingRecipients` werden bei RopSaveChangesMessage in die DB
       * geflusht).
       */
      messageId: string | null;
      isDraft?: boolean;
      /**
       * v5.1.0: PIM-Typ für virtuelle Folder. Steuert welcher Property-Mapper
       * in handleRopGetPropertiesAll verwendet wird.
       *   - 'mail' (default) → Message-Tabelle
       *   - 'appointment'     → CalendarEvent-Tabelle (IPM.Appointment)
       *   - 'contact'         → Contact-Tabelle (IPM.Contact)
       *   - 'task'            → Task-Tabelle (IPM.Task)
       *   - 'note'            → Note-Tabelle (IPM.StickyNote)
       */
      pimKind?: 'mail' | 'appointment' | 'contact' | 'task' | 'note';
      pendingProperties?: Record<string, unknown>;   // PropertyTag (dec) → value
      pendingRecipients?: Array<{
        type: 'TO' | 'CC' | 'BCC';
        name: string;
        address: string;
      }>;
    }
  | { kind: 'table';   userId: string; tableType: 'hierarchy' | 'contents' | 'attachments';
                       /** Bei 'attachments': MessageId statt FolderId. */
                       parentFolderId: string; columns?: number[] /* property-tags */ }
  | { kind: 'stream';  userId: string; messageId: string | null;
                       /** Optional: für Stream auf einer Draft-Message (v4.3.0 OpenStream → WriteStream → CommitStream) */
                       parentMessageHandle?: number;
                       propertyTag: number;
                       buffer: Buffer; offset: number;
                       writable?: boolean }
  | { kind: 'attachment'; userId: string; messageId: string;
      /** Bei bestehender Attachment: ID des DB-Records. Null für neue Attachment (v4.4.0 RopCreateAttachment). */
      attachmentId: string | null;
      /** Attachment-Index innerhalb der Message (Outlook-AttachmentNum). */
      attachNum: number;
      /** Pending-Properties + Buffer für Compose-Workflow (v4.4.0). */
      pendingProperties?: Record<string, unknown>;
      pendingBuffer?: Buffer;
    };

/**
 * Liest das Object aus der Session-State HandleTable.
 */
export async function getRopObject(
  sessionToken: string,
  handle: number,
): Promise<RopObject | null> {
  const session = await getMapiSession(sessionToken);
  if (!session) return null;
  const obj = session.handleTable[handle];
  return (obj as RopObject) ?? null;
}

/**
 * Alloziert ein neues Handle für ein Object und persistiert.
 * Liefert das uint32 Handle (oder null wenn Session nicht existiert).
 */
export async function putRopObject(
  sessionToken: string,
  object: RopObject,
): Promise<number | null> {
  return allocateRopHandle(sessionToken, object);
}

/**
 * Löscht ein Handle (RopRelease).
 */
export async function releaseRopObject(
  sessionToken: string,
  handle: number,
): Promise<boolean> {
  const session = await getMapiSession(sessionToken);
  if (!session) return false;
  if (!(handle in session.handleTable)) return false;
  delete session.handleTable[handle];
  // session-store schreibt bei nächstem allocate; für Release brauchen wir
  // einen expliziten Persist. Wir laden + speichern manuell:
  return persistSessionState(sessionToken, session);
}

/** Hilfsfunktion: persistiert State zurück nach Redis. */
async function persistSessionState(
  sessionToken: string,
  state: MapiSessionState,
): Promise<boolean> {
  // Wir reuse den allocateRopHandle-Mechanismus mit einem "leeren" Put,
  // der den State neu schreibt. Da das Counter erhöht aber sonst nichts macht,
  // ist es ein bisschen hack — bessere Variante: ein neuer Helper in
  // session-store.ts. Für v4.1.0 reicht das.
  // (TODO v4.2.0: dedicated `updateSession(token, state)` helper)
  const { getRedisClient } = await import('@coremail/core');
  const KEY = `mapi:session:${sessionToken}`;
  state.lastSeen = Date.now();
  await getRedisClient().set(KEY, JSON.stringify(state), 'EX', 600);
  return true;
}

/**
 * Aktualisiert ein bestehendes Handle-Object (für Draft-Akkumulation in v4.3.0).
 */
export async function updateRopObject(
  sessionToken: string,
  handle: number,
  patch: Partial<RopObject>,
): Promise<boolean> {
  const session = await getMapiSession(sessionToken);
  if (!session) return false;
  const existing = session.handleTable[handle];
  if (!existing) return false;
  session.handleTable[handle] = { ...existing, ...(patch as object) } as RopObject;
  return persistSessionState(sessionToken, session);
}

/**
 * Hilfsfunktion zum Auflösen eines HandleIndex (aus dem ROP-Stream-
 * ServerObjectHandleTable) zu einem konkreten Object.
 */
export async function resolveHandleIndex(
  sessionToken: string,
  serverObjectHandles: number[],
  handleIndex: number | undefined,
): Promise<{ handle: number; object: RopObject } | null> {
  if (handleIndex === undefined) return null;
  const handle = serverObjectHandles[handleIndex];
  if (handle === undefined || handle === 0xFFFFFFFF) return null;
  const object = await getRopObject(sessionToken, handle);
  if (!object) return null;
  return { handle, object };
}
