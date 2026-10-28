/**
 * ROP object handle table (v4.1.0)
 *
 * Outlook keeps a "ServerObjectHandleTable" per MAPI session — a list
 * of uint32 handles representing server-side objects (mailbox, folder, message,
 * stream, attachment, table). Every ROP references
 * input/output via an INDEX into this table.
 *
 * We persist the table in Redis (via `session-store.ts`). Here we
 * define the typed object descriptors and helpers.
 */

import {
  getMapiSession, allocateRopHandle,
  type MapiSessionState,
} from './session-store.js';

/** Typed object descriptor — what is behind a ROP handle. */
export type RopObject =
  | { kind: 'mailbox'; userId: string }
  | { kind: 'folder';  userId: string; folderId: string; folderName: string }
  | { kind: 'message'; userId: string; folderId: string;
      /**
       * `messageId === null` marks a NEW draft that is not yet persisted in the DB
       * (v4.3.0 — RopCreateMessage creates the handle without an immediate DB write;
       * `pendingProperties` + `pendingRecipients` are flushed to the DB on
       * RopSaveChangesMessage).
       */
      messageId: string | null;
      isDraft?: boolean;
      /**
       * v5.1.0: PIM type for virtual folders. Controls which property mapper
       * is used in handleRopGetPropertiesAll.
       *   - 'mail' (default) → Message table
       *   - 'appointment'     → CalendarEvent table (IPM.Appointment)
       *   - 'contact'         → Contact table (IPM.Contact)
       *   - 'task'            → Task table (IPM.Task)
       *   - 'note'            → Note table (IPM.StickyNote)
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
                       /** For 'attachments': MessageId instead of FolderId. */
                       parentFolderId: string; columns?: number[] /* property-tags */ }
  | { kind: 'stream';  userId: string; messageId: string | null;
                       /** Optional: for a stream on a draft message (v4.3.0 OpenStream → WriteStream → CommitStream) */
                       parentMessageHandle?: number;
                       propertyTag: number;
                       buffer: Buffer; offset: number;
                       writable?: boolean }
  | { kind: 'attachment'; userId: string; messageId: string;
      /** For an existing attachment: ID of the DB record. Null for a new attachment (v4.4.0 RopCreateAttachment). */
      attachmentId: string | null;
      /** Attachment index within the message (Outlook AttachmentNum). */
      attachNum: number;
      /** Pending properties + buffer for the compose workflow (v4.4.0). */
      pendingProperties?: Record<string, unknown>;
      pendingBuffer?: Buffer;
    };

/**
 * Reads the object from the session-state handle table.
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
 * Allocates a new handle for an object and persists it.
 * Returns the uint32 handle (or null if the session does not exist).
 */
export async function putRopObject(
  sessionToken: string,
  object: RopObject,
): Promise<number | null> {
  return allocateRopHandle(sessionToken, object);
}

/**
 * Deletes a handle (RopRelease).
 */
export async function releaseRopObject(
  sessionToken: string,
  handle: number,
): Promise<boolean> {
  const session = await getMapiSession(sessionToken);
  if (!session) return false;
  if (!(handle in session.handleTable)) return false;
  delete session.handleTable[handle];
  // session-store writes on the next allocate; for Release we need
  // an explicit persist. We load + save manually:
  return persistSessionState(sessionToken, session);
}

/** Helper: persists state back to Redis. */
async function persistSessionState(
  sessionToken: string,
  state: MapiSessionState,
): Promise<boolean> {
  // We reuse the allocateRopHandle mechanism with an "empty" put
  // that rewrites the state. Since it increments the counter but does nothing else,
  // it is a bit of a hack — better variant: a new helper in
  // session-store.ts. Good enough for v4.1.0.
  // (TODO v4.2.0: dedicated `updateSession(token, state)` helper)
  const { getRedisClient } = await import('@coremail/core');
  const KEY = `mapi:session:${sessionToken}`;
  state.lastSeen = Date.now();
  await getRedisClient().set(KEY, JSON.stringify(state), 'EX', 600);
  return true;
}

/**
 * Updates an existing handle object (for draft accumulation in v4.3.0).
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
 * Helper to resolve a HandleIndex (from the ROP stream
 * ServerObjectHandleTable) to a concrete object.
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
