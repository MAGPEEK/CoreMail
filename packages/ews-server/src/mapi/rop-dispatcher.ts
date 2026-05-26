/**
 * ROP-Dispatcher (v4.1.0)
 *
 * Parst den binären Execute-Request, dispatched jeden ROP an seinen
 * Handler, sammelt die Response-Buffers und baut die ROP-Stream-Response.
 *
 * Phasen-Mapping (welcher ROP in welcher Version implementiert):
 *   v4.1.0: Logon, OpenFolder, GetHierarchyTable, GetContentsTable (stub),
 *           SetColumns, QueryRows, GetRowCount, Release
 *   v4.2.0: OpenMessage, GetPropertiesAll, GetPropertiesSpecific, OpenStream,
 *           ReadStream, GetAttachmentTable
 *   v4.3.0: CreateMessage, SetProperties, SaveChangesMessage,
 *           SubmitMessage, ModifyRecipients
 *   v4.4.0: OpenAttachment, CreateAttachment, ReadAttachment, WriteAttachment,
 *           MoveCopyMessages, DeleteMessages
 *   v4.5.0: RegisterNotification, Notify
 */

import { createLogger } from '@coremail/core';
import { parseRopBuffer, RopResponseBuilder, writeNotSupportedRop, type RopRequest } from './rop-codec.js';
import { RopId } from './rop-types.js';
import type { MapiSessionState } from './session-store.js';
import { handleRopLogon } from './rop/logon.js';
import {
  handleRopOpenFolder, handleRopGetHierarchyTable, handleRopGetContentsTable,
} from './rop/folder.js';
import {
  handleRopSetColumns, handleRopQueryRows, handleRopGetRowCount, handleRopRelease,
} from './rop/table.js';

const log = createLogger('mapi:dispatcher');

export interface DispatchResult {
  responseBuffer: Buffer;
  /**
   * Nach dem Dispatch geänderte Server-Object-Handle-Table (mit ggf. neuen
   * Handles für OutputHandleIndexes der ROPs).
   */
  serverObjectHandles: number[];
}

/**
 * Hauptdispatch-Funktion.
 *
 * `executeBody` ist der raw binary Body von Execute-Request, der typischerweise
 * mit RopBuffer beginnt. Wir liefern einen ROP-Stream-Response zurück, der
 * von emsmdb-handler in eine Execute-Response-Hülle verpackt wird.
 */
export async function dispatchRopBuffer(
  executeBody: Buffer,
  sessionToken: string,
  session: MapiSessionState,
): Promise<DispatchResult> {
  const builder = new RopResponseBuilder();
  const responseHandles: number[] = [];

  let parsed;
  try {
    parsed = parseRopBuffer(executeBody);
  } catch (err) {
    log.warn({ err, bodyLen: executeBody.length }, 'ROP-Buffer-Parsing fehlgeschlagen');
    return { responseBuffer: Buffer.alloc(0), serverObjectHandles: [] };
  }

  log.debug({
    ropCount: parsed.rops.length,
    handleCount: parsed.serverObjectHandles.length,
    rops: parsed.rops.map((r) => `0x${r.ropId.toString(16)}`),
  }, 'Dispatching ROP-Stream');

  for (const rop of parsed.rops) {
    try {
      const responseBuf = await dispatchOne(rop, sessionToken, session, parsed.serverObjectHandles);
      if (responseBuf.length > 0) {
        builder.appendRop(responseBuf);
      }
    } catch (err) {
      log.error({ err, ropId: `0x${rop.ropId.toString(16)}` }, 'ROP-Handler-Fehler');
      writeNotSupportedRop(builder, rop.ropId, rop.outputHandleIndex ?? 0);
    }
  }

  // Server-Object-Handle-Table für die Response: alle Eingabe-Handles
  // bleiben gleich + ggf. neue Handles vom Allocate. Wir laden den
  // aktuellen Session-State und nehmen alle Handles die nach den ROPs
  // bekannt sind. v4.1.0 minimal: nur die Eingabe-Handles spiegeln.
  for (const h of parsed.serverObjectHandles) {
    responseHandles.push(h);
  }

  return {
    responseBuffer: builder.toBuffer(),
    serverObjectHandles: responseHandles,
  };
}

async function dispatchOne(
  rop: RopRequest,
  sessionToken: string,
  session: MapiSessionState,
  serverObjectHandles: number[],
): Promise<Buffer> {
  switch (rop.ropId) {
    case RopId.Logon:
      return handleRopLogon(rop, sessionToken, session);

    case RopId.OpenFolder:
      return handleRopOpenFolder(rop, sessionToken, serverObjectHandles);

    case RopId.GetHierarchyTable:
      return handleRopGetHierarchyTable(rop, sessionToken, serverObjectHandles);

    case RopId.GetContentsTable:
      return handleRopGetContentsTable(rop, sessionToken, serverObjectHandles);

    case RopId.SetColumns:
      return handleRopSetColumns(rop, sessionToken, serverObjectHandles);

    case RopId.QueryRows:
      return handleRopQueryRows(rop, sessionToken, serverObjectHandles);

    case RopId.GetRowCount:
      return handleRopGetRowCount(rop, sessionToken, serverObjectHandles);

    case RopId.Release:
      return handleRopRelease(rop, sessionToken, serverObjectHandles);

    // ── v4.2.0+ Phasen: TODO ────────────────────────────────────────────────
    case RopId.OpenMessage:
    case RopId.GetPropertiesAll:
    case RopId.GetPropertiesSpecific:
    case RopId.OpenStream:
    case RopId.ReadStream:
    case RopId.GetAttachmentTable:
    case RopId.CreateMessage:
    case RopId.SetProperties:
    case RopId.SaveChangesMessage:
    case RopId.SubmitMessage:
    case RopId.ModifyRecipients:
    case RopId.OpenAttachment:
    case RopId.CreateAttachment:
    case RopId.RegisterNotification:
    default: {
      const b = new RopResponseBuilder();
      writeNotSupportedRop(b, rop.ropId, rop.outputHandleIndex ?? 0);
      // appendRop wurde aufgerufen, .rops enthält den Eintrag
      // toBuffer() inkludiert aber den RopSize-Header — wir wollen nur den
      // ROP-Inhalt zurück. → einzelnen Slice ohne Header bauen
      return extractFirstRopFromBuilder(b);
    }
  }
}

function extractFirstRopFromBuilder(b: RopResponseBuilder): Buffer {
  // toBuffer() = [RopSize(2)][ROPs][Handles]
  const buf = b.toBuffer();
  if (buf.length < 4) return Buffer.alloc(0);
  const ropSize = buf.readUint16LE(0);
  return Buffer.from(buf.subarray(2, 2 + ropSize - 2));
}
