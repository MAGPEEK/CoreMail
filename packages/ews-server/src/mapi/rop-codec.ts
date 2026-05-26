/**
 * ROP-Stream-Codec (v4.1.0)
 *
 * Format des ROP-Buffers innerhalb von EcDoRpcExt2 (MS-OXCRPC §2.2.2.2.1):
 *
 *   +-------------------+
 *   | RopSize  (uint16) | ← Anzahl Bytes der ROPs (ohne Handle-Table)
 *   +-------------------+
 *   | ROP1 (variable)   |
 *   | ROP2 (variable)   |
 *   | ...               |
 *   +-------------------+
 *   | ServerObjectHandleTable (Array von uint32) bis end-of-buffer
 *   +-------------------+
 *
 * Jeder ROP:
 *   +-----------+----------------+-----------------+
 *   | RopId (1B)| LogonId (1B)   | Inputs/Outputs  |
 *   +-----------+----------------+-----------------+
 *
 * Die Input-/Output-Handles sind INDEXE in die ServerObjectHandleTable —
 * KEINE absoluten Handle-Werte. Der ROP-Handler löst sie über `handleTable[i]`
 * auf zum aktuellen Object-Handle (uint32, Session-lokal).
 */

import { MapiReader, MapiWriter } from './codec.js';
import type { Request } from 'express';
import { RopId, type RopIdValue } from './rop-types.js';

/** Reserved uint32-Wert für „kein Object" (MS-OXCROPS §2.2.2.4). */
export const HANDLE_NULL = 0xFFFFFFFF;

/**
 * Ein einzelner ROP innerhalb einer Request. Wir behalten den Original-
 * Buffer-Slice für detailliertes Parsing pro Handler.
 */
export interface RopRequest {
  ropId:              RopIdValue | number;
  logonId:            number;
  /** Index in die HandleTable, oder undefined bei manchen ROPs wie Logon. */
  inputHandleIndex?:  number;
  outputHandleIndex?: number;
  /** Rest des ROP-Payloads (nach RopId/LogonId/Handle-Indexes). */
  payload:            Buffer;
}

export interface RopRequestBuffer {
  rops:                  RopRequest[];
  /** Array von Server-Object-Handles (uint32). Position = Index in den ROPs. */
  serverObjectHandles:   number[];
}

/**
 * Parst den binären ROP-Stream aus einem Execute-Request-Body.
 *
 * v4.1.0 implementiert NUR die ROPs die wir hier dispatchen können
 * (RopLogon, RopOpenFolder, RopGetHierarchyTable, RopSetColumns,
 * RopQueryRows, RopRelease). Unbekannte ROPs bekommen einen rohen
 * Payload bis zum nächsten ROP-Boundary — die Dispatcher-Logik returnt
 * `ecNotSupported` und das Client merkt es.
 *
 * Die ROPs haben sehr unterschiedliche Strukturen — wir parsen hier nur
 * den GEMEINSAMEN Header (RopId + LogonId + Input/Output-Handle-Indexes),
 * und überlassen das ROP-spezifische Payload-Parsing dem Handler.
 */
export function parseRopBuffer(body: Buffer): RopRequestBuffer {
  if (body.length < 2) {
    throw new RangeError('ROP buffer too small (need at least RopSize uint16)');
  }
  const reader = new MapiReader(body);
  const ropSize = reader.readUint16();
  if (ropSize > body.length - 2) {
    throw new RangeError(`RopSize ${ropSize} exceeds buffer length ${body.length - 2}`);
  }

  // RopSize ist nach MS-OXCRPC inclusiv der eigenen 2 Bytes; manche Outlook-
  // Builds senden es exklusiv. Wir interpretieren defensiv.
  const ropEndOffset = ropSize + 2 > body.length ? body.length : ropSize + 2;

  const rops: RopRequest[] = [];
  while (reader.position < ropEndOffset) {
    const ropId = reader.readUint8();
    if (ropId === 0) break; // padding / end-of-stream

    const startOffset = reader.position;
    let logonId = 0;
    let inputHandleIndex: number | undefined;
    let outputHandleIndex: number | undefined;
    let payloadEnd: number;

    // ROP-spezifisches Header-Parsing. Wir kennen die strukturelle Länge der
    // wichtigsten ROPs; für unbekannte versuchen wir konservativ den Rest des
    // Buffers zu konsumieren (Dispatcher wird ecNotSupported zurückgeben).
    switch (ropId) {
      case RopId.Logon: {
        // RopLogon Request (MS-OXCSTOR §2.2.1.1.1):
        //   LogonId (1B), OutputHandleIndex (1B), LogonFlags (1B),
        //   OpenFlags (4B), StoreState (4B), EssdnLen (uint16), Essdn (ASCII)
        logonId = reader.readUint8();
        outputHandleIndex = reader.readUint8();
        // Rest als Payload bis Buffer-Ende für diesen ROP
        const remainingFromStart = body.length - reader.position;
        // RopLogon-Payload: LogonFlags(1) + OpenFlags(4) + StoreState(4) + EssdnLen(2) + Essdn(variable)
        // Wir suchen die Essdn-Länge um exakt zu bestimmen
        if (remainingFromStart >= 11) {
          const peekPos = reader.position;
          reader.readUint8();                         // LogonFlags
          reader.readUint32();                        // OpenFlags
          reader.readUint32();                        // StoreState
          const essdnLen = reader.readUint16();
          reader.readBuffer(Math.min(essdnLen, body.length - reader.position));
          payloadEnd = reader.position;
          // Payload-Slice aus dem Original-Buffer
          rops.push({
            ropId, logonId, outputHandleIndex,
            payload: Buffer.from(body.subarray(peekPos, payloadEnd)),
          });
        } else {
          // Defekt: kompletter Rest
          payloadEnd = body.length;
          rops.push({
            ropId, logonId, outputHandleIndex,
            payload: Buffer.from(body.subarray(reader.position, payloadEnd)),
          });
          reader.seek(payloadEnd);
        }
        continue;
      }

      case RopId.Release: {
        // RopRelease (MS-OXCROPS §2.2.15.3):
        //   LogonId (1B), InputHandleIndex (1B)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        rops.push({ ropId, logonId, inputHandleIndex, payload: Buffer.alloc(0) });
        continue;
      }

      case RopId.OpenFolder: {
        // RopOpenFolder (MS-OXCFOLD §2.2.1.1):
        //   LogonId(1), InputHandleIndex(1), OutputHandleIndex(1),
        //   FolderId(8), OpenModeFlags(1)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        outputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint64();   // FolderId
        reader.readUint8();    // OpenModeFlags
        rops.push({
          ropId, logonId, inputHandleIndex, outputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.GetHierarchyTable: {
        // RopGetHierarchyTable (MS-OXCFOLD §2.2.1.13):
        //   LogonId(1), InputHandleIndex(1), OutputHandleIndex(1),
        //   TableFlags(1)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        outputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8(); // TableFlags
        rops.push({
          ropId, logonId, inputHandleIndex, outputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.GetContentsTable: {
        // RopGetContentsTable (MS-OXCFOLD §2.2.1.14):
        //   LogonId(1), InputHandleIndex(1), OutputHandleIndex(1),
        //   TableFlags(1)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        outputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8();
        rops.push({
          ropId, logonId, inputHandleIndex, outputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.SetColumns: {
        // RopSetColumns (MS-OXCTABL §2.2.2.2):
        //   LogonId(1), InputHandleIndex(1), TableFlags(1),
        //   PropertyTagCount(uint16), PropertyTags(uint32[])
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8(); // TableFlags
        const tagCount = reader.readUint16();
        reader.readBuffer(tagCount * 4);
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.QueryRows: {
        // RopQueryRows (MS-OXCTABL §2.2.2.7):
        //   LogonId(1), InputHandleIndex(1), QueryRowsFlags(1),
        //   ForwardRead(1), RowCount(uint16)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8(); reader.readUint8(); reader.readUint16();
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.GetRowCount: {
        // RopGetRowCount: LogonId(1), InputHandleIndex(1)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        rops.push({ ropId, logonId, inputHandleIndex, payload: Buffer.alloc(0) });
        continue;
      }

      default: {
        // Unbekannter ROP — wir konsumieren minimal (LogonId+InputHandleIndex)
        // und stoppen. Dispatcher wird ecNotSupported zurückgeben.
        if (reader.remaining >= 2) {
          logonId = reader.readUint8();
          inputHandleIndex = reader.readUint8();
        }
        rops.push({
          ropId, logonId,
          ...(inputHandleIndex !== undefined ? { inputHandleIndex } : {}),
          payload: Buffer.from(body.subarray(startOffset, reader.position)),
        });
        // Da wir die genaue Länge nicht kennen → Abbruch des Stream-Parsings
        break;
      }
    }
  }

  // Server-Object-Handle-Table: Rest des Buffers, je uint32
  const handles: number[] = [];
  reader.seek(ropEndOffset);
  while (reader.remaining >= 4) {
    handles.push(reader.readUint32());
  }

  return { rops, serverObjectHandles: handles };
}

/**
 * Schreibt eine Response-ROP-Stream-Struktur in einen Buffer.
 * Spiegelung von parseRopBuffer für Output.
 */
export class RopResponseBuilder {
  private rops: Buffer[] = [];
  private handles: number[] = [];

  /** Hängt eine fertige ROP-Response (mit RopId + Payload) an. */
  appendRop(buf: Buffer): void {
    this.rops.push(buf);
  }

  /** Hängt einen Handle in die ServerObjectHandleTable. */
  appendHandle(h: number): void {
    this.handles.push(h);
  }

  toBuffer(): Buffer {
    const ropPart = Buffer.concat(this.rops);
    const handlePart = Buffer.allocUnsafe(this.handles.length * 4);
    for (let i = 0; i < this.handles.length; i++) {
      handlePart.writeUInt32LE(this.handles[i]!, i * 4);
    }
    // RopSize = inkl. der 2-Byte-Länge selbst (manche Outlook-Builds erwarten das)
    const header = Buffer.allocUnsafe(2);
    header.writeUInt16LE(ropPart.length + 2, 0);
    return Buffer.concat([header, ropPart, handlePart]);
  }

  get isEmpty(): boolean {
    return this.rops.length === 0;
  }
}

/**
 * Hilfsfunktion: schreibt ein leeres ecNotSupported-ROP-Response in den Builder
 * (für einen unbekannten oder noch nicht implementierten ROP).
 */
export function writeNotSupportedRop(
  builder: RopResponseBuilder,
  ropId: number,
  outputHandleIndex: number = 0,
): void {
  const w = new MapiWriter();
  w.writeUint8(ropId);
  w.writeUint8(outputHandleIndex);
  w.writeUint32(0x80040102); // ecNotSupported
  builder.appendRop(w.toBuffer());
}

// Re-export hilfsweise für den Dispatcher.
export { Request };
