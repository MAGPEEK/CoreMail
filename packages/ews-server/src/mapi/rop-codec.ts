/**
 * ROP stream codec (v4.1.0)
 *
 * Format of the ROP buffer inside EcDoRpcExt2 (MS-OXCRPC §2.2.2.2.1):
 *
 *   +-------------------+
 *   | RopSize  (uint16) | ← number of bytes of the ROPs (without handle table)
 *   +-------------------+
 *   | ROP1 (variable)   |
 *   | ROP2 (variable)   |
 *   | ...               |
 *   +-------------------+
 *   | ServerObjectHandleTable (array of uint32) up to end-of-buffer
 *   +-------------------+
 *
 * Each ROP:
 *   +-----------+----------------+-----------------+
 *   | RopId (1B)| LogonId (1B)   | Inputs/Outputs  |
 *   +-----------+----------------+-----------------+
 *
 * The input/output handles are INDEXES into the ServerObjectHandleTable —
 * NOT absolute handle values. The ROP handler resolves them via `handleTable[i]`
 * to the current object handle (uint32, session-local).
 */

import { MapiReader, MapiWriter } from './codec.js';
import type { Request } from 'express';
import { RopId, type RopIdValue } from './rop-types.js';

/** Reserved uint32 value for "no object" (MS-OXCROPS §2.2.2.4). */
export const HANDLE_NULL = 0xFFFFFFFF;

/**
 * A single ROP within a request. We keep the original
 * buffer slice for detailed parsing per handler.
 */
export interface RopRequest {
  ropId:              RopIdValue | number;
  logonId:            number;
  /** Index into the handle table, or undefined for some ROPs like Logon. */
  inputHandleIndex?:  number;
  outputHandleIndex?: number;
  /** Rest of the ROP payload (after RopId/LogonId/handle indexes). */
  payload:            Buffer;
}

export interface RopRequestBuffer {
  rops:                  RopRequest[];
  /** Array of server object handles (uint32). Position = index in the ROPs. */
  serverObjectHandles:   number[];
}

/**
 * Parses the binary ROP stream from an Execute request body.
 *
 * v4.1.0 implements ONLY the ROPs we can dispatch here
 * (RopLogon, RopOpenFolder, RopGetHierarchyTable, RopSetColumns,
 * RopQueryRows, RopRelease). Unknown ROPs get a raw
 * payload up to the next ROP boundary — the dispatcher logic returns
 * `ecNotSupported` and the client notices.
 *
 * The ROPs have very different structures — here we only parse
 * the COMMON header (RopId + LogonId + input/output handle indexes),
 * and leave the ROP-specific payload parsing to the handler.
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

  // Per MS-OXCRPC RopSize includes its own 2 bytes; some Outlook
  // builds send it exclusive. We interpret defensively.
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

    // ROP-specific header parsing. We know the structural length of the
    // most important ROPs; for unknown ones we conservatively try to consume the rest
    // of the buffer (the dispatcher will return ecNotSupported).
    switch (ropId) {
      case RopId.Logon: {
        // RopLogon Request (MS-OXCSTOR §2.2.1.1.1):
        //   LogonId (1B), OutputHandleIndex (1B), LogonFlags (1B),
        //   OpenFlags (4B), StoreState (4B), EssdnLen (uint16), Essdn (ASCII)
        logonId = reader.readUint8();
        outputHandleIndex = reader.readUint8();
        // Rest as payload up to the buffer end for this ROP
        const remainingFromStart = body.length - reader.position;
        // RopLogon-Payload: LogonFlags(1) + OpenFlags(4) + StoreState(4) + EssdnLen(2) + Essdn(variable)
        // We look for the Essdn length to determine it exactly
        if (remainingFromStart >= 11) {
          const peekPos = reader.position;
          reader.readUint8();                         // LogonFlags
          reader.readUint32();                        // OpenFlags
          reader.readUint32();                        // StoreState
          const essdnLen = reader.readUint16();
          reader.readBuffer(Math.min(essdnLen, body.length - reader.position));
          payloadEnd = reader.position;
          // Payload slice from the original buffer
          rops.push({
            ropId, logonId, outputHandleIndex,
            payload: Buffer.from(body.subarray(peekPos, payloadEnd)),
          });
        } else {
          // Broken: take the complete rest
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

      case RopId.Restrict: {
        // RopRestrict (MS-OXCTABL §2.2.2.4):
        //   LogonId(1), InputHandleIndex(1), RestrictFlags(1),
        //   RestrictionSize(uint16), Restriction(variable, MS-OXCDATA §2.12)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8();
        const rSize = reader.readUint16();
        reader.readBuffer(rSize);
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.FindRow: {
        // RopFindRow (MS-OXCTABL §2.2.2.13):
        //   LogonId(1), InputHandleIndex(1), FindRowFlags(1),
        //   RestrictionSize(uint16), Restriction(variable),
        //   Origin(1), BookmarkSize(uint16), Bookmark(variable)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8();
        const rSize = reader.readUint16();
        reader.readBuffer(rSize);
        reader.readUint8();
        const bSize = reader.readUint16();
        reader.readBuffer(bSize);
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

      // v4.2.0 — Reading mail
      case RopId.OpenMessage: {
        // RopOpenMessage: LogonId(1), InputHandleIndex(1), OutputHandleIndex(1),
        //   CodePageId(uint16), FolderId(uint64), OpenModeFlags(uint8), MessageId(uint64)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        outputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint16();         // CodePageId
        reader.readUint64();         // FolderId
        reader.readUint8();          // OpenModeFlags
        reader.readUint64();         // MessageId
        rops.push({
          ropId, logonId, inputHandleIndex, outputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.GetPropertiesAll: {
        // RopGetPropertiesAll: LogonId(1), InputHandleIndex(1),
        //   PropertySizeLimit(uint16), WantUnicode(uint16)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint16(); reader.readUint16();
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.GetPropertiesSpecific: {
        // RopGetPropertiesSpecific: LogonId(1), InputHandleIndex(1),
        //   PropertySizeLimit(uint16), WantUnicode(uint16),
        //   PropertyTagCount(uint16), PropertyTags(uint32[])
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint16(); reader.readUint16();
        const cnt = reader.readUint16();
        reader.readBuffer(cnt * 4);
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.OpenStream: {
        // RopOpenStream: LogonId(1), InputHandleIndex(1), OutputHandleIndex(1),
        //   PropertyTag(uint32), OpenModeFlags(uint8)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        outputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint32(); reader.readUint8();
        rops.push({
          ropId, logonId, inputHandleIndex, outputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.ReadStream: {
        // RopReadStream: LogonId(1), InputHandleIndex(1), ByteCount(uint16),
        //   MaximumByteCount(uint32 — if ByteCount==0xBABE)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        const byteCount = reader.readUint16();
        if (byteCount === 0xBABE) {
          reader.readUint32();
        }
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.GetStreamSize: {
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        rops.push({ ropId, logonId, inputHandleIndex, payload: Buffer.alloc(0) });
        continue;
      }

      // v4.3.0 — Composing + sending mail
      case RopId.CreateMessage: {
        // RopCreateMessage: LogonId(1), InputHandleIndex(1), OutputHandleIndex(1),
        //   CodePageId(uint16), FolderId(uint64), AssociatedFlag(uint8)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        outputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint16(); reader.readUint64(); reader.readUint8();
        rops.push({
          ropId, logonId, inputHandleIndex, outputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.SaveChangesMessage: {
        // RopSaveChangesMessage: LogonId(1), InputHandleIndex(1),
        //   ResponseHandleIndex(1), SaveFlags(uint8)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8(); reader.readUint8();
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.SetProperties: {
        // RopSetProperties: LogonId(1), InputHandleIndex(1),
        //   PropertyValueSize(uint16), PropertyValueCount(uint16), PropertyValues(variable)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        const valSize = reader.readUint16();
        reader.readBuffer(valSize);
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.SubmitMessage: {
        // RopSubmitMessage: LogonId(1), InputHandleIndex(1), SubmitFlags(uint8)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8();
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.WriteStream: {
        // RopWriteStream: LogonId(1), InputHandleIndex(1), DataSize(uint16), Data(variable)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        const sz = reader.readUint16();
        reader.readBuffer(sz);
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.CommitStream:
      case RopId.SetMessageReadFlag:
      case RopId.SetReadFlags: {
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        rops.push({ ropId, logonId, inputHandleIndex, payload: Buffer.alloc(0) });
        continue;
      }

      // v4.4.0 — Attachments
      case RopId.GetAttachmentTable: {
        // LogonId(1) | InputHandleIndex(1) | OutputHandleIndex(1) | TableFlags(1)
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

      case RopId.OpenAttachment: {
        // LogonId(1) | InputHandleIndex(1) | OutputHandleIndex(1) | OpenAttachmentFlags(1) | AttachmentId(uint32)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        outputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8(); reader.readUint32();
        rops.push({
          ropId, logonId, inputHandleIndex, outputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.CreateAttachment: {
        // LogonId(1) | InputHandleIndex(1) | OutputHandleIndex(1)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        outputHandleIndex = reader.readUint8();
        rops.push({
          ropId, logonId, inputHandleIndex, outputHandleIndex,
          payload: Buffer.alloc(0),
        });
        continue;
      }

      case RopId.DeleteAttachment: {
        // LogonId(1) | InputHandleIndex(1) | AttachmentId(uint32)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint32();
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.SaveChangesAttachment: {
        // LogonId(1) | InputHandleIndex(1) | ResponseHandleIndex(1) | SaveFlags(1)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8(); reader.readUint8();
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      // v4.4.0 — Move + Delete
      case RopId.DeleteMessages: {
        // LogonId(1) | InputHandleIndex(1) | WantAsynchronous(1) | NotifyNonRead(1)
        //   | MessageIdCount(uint16) | MessageIds(uint64[])
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8(); reader.readUint8();
        const idCount = reader.readUint16();
        for (let i = 0; i < idCount; i++) reader.readUint64();
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      case RopId.MoveCopyMessages: {
        // LogonId(1) | InputHandleIndex(1) | DestinationHandleIndex(1)
        //   | WantAsynchronous(1) | WantCopy(1)
        //   | MessageIdCount(uint16) | MessageIds(uint64[])
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const destHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint8(); reader.readUint8();
        const idCount = reader.readUint16();
        for (let i = 0; i < idCount; i++) reader.readUint64();
        rops.push({
          ropId, logonId, inputHandleIndex, outputHandleIndex: destHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      // v5.1.0 — Named Properties (variable-length, parsed by its own handler)
      case RopId.GetPropertyIdsFromNames:
      case RopId.GetNamesFromPropertyIds: {
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const remStart = reader.position;
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(remStart, body.length)),
        });
        reader.seek(body.length);
        continue;
      }

      // v5.2.0 — OpenEmbeddedMessage
      case RopId.OpenEmbeddedMessage: {
        // LogonId(1) | InputHandleIndex(1) | OutputHandleIndex(1) | CodePageId(uint16) | OpenModeFlags(uint8)
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        outputHandleIndex = reader.readUint8();
        const payloadStart = reader.position;
        reader.readUint16(); reader.readUint8();
        rops.push({
          ropId, logonId, inputHandleIndex, outputHandleIndex,
          payload: Buffer.from(body.subarray(payloadStart, reader.position)),
        });
        continue;
      }

      // v5.2.0 — Search Folders / Rules / Permissions / Misc (variable-length)
      case RopId.GetSearchCriteria:
      case RopId.SetSearchCriteria:
      case RopId.GetRulesTable:
      case RopId.UpdateRules:
      case RopId.GetPermissionsTable:
      case RopId.ModifyPermissions:
      case RopId.ReloadCachedInformation:
      case RopId.GetMessageStatus:
      case RopId.SetMessageStatus:
      case RopId.AbortSubmit: {
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        // OutputHandle for *Table ROPs
        if (ropId === RopId.GetRulesTable || ropId === RopId.GetPermissionsTable) {
          outputHandleIndex = reader.readUint8();
        }
        const remStart = reader.position;
        rops.push({
          ropId, logonId, inputHandleIndex,
          ...(outputHandleIndex !== undefined ? { outputHandleIndex } : {}),
          payload: Buffer.from(body.subarray(remStart, body.length)),
        });
        reader.seek(body.length);
        continue;
      }

      // v5.2.0 — MS-OXCFXICS Sync ROPs (variable-length, parsed by their own handler)
      case RopId.FastTransferSourceGetBuffer:
      case RopId.FastTransferSourceCopyFolder:
      case RopId.FastTransferSourceCopyMessages:
      case RopId.FastTransferSourceCopyProperties:
      case RopId.FastTransferDestinationConfigure:
      case RopId.FastTransferDestinationPutBuffer:
      case RopId.SyncConfigure:
      case RopId.SyncImportMessageChange:
      case RopId.SyncImportHierarchyChange:
      case RopId.SyncImportDeletes:
      case RopId.SyncImportMessageMove:
      case RopId.SyncUploadStateStreamBegin:
      case RopId.SyncUploadStateStreamContinue:
      case RopId.SyncUploadStateStreamEnd:
      case RopId.SyncOpenCollector:
      case RopId.GetLocalReplicaIds:
      case RopId.SyncGetTransferState: {
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        // OutputHandle for ROPs that issue a new handle
        if (ropId === RopId.SyncConfigure ||
            ropId === RopId.FastTransferSourceCopyFolder ||
            ropId === RopId.FastTransferSourceCopyMessages ||
            ropId === RopId.FastTransferSourceCopyProperties ||
            ropId === RopId.FastTransferDestinationConfigure ||
            ropId === RopId.SyncImportMessageChange ||
            ropId === RopId.SyncOpenCollector ||
            ropId === RopId.SyncGetTransferState) {
          outputHandleIndex = reader.readUint8();
        }
        const remStart = reader.position;
        rops.push({
          ropId, logonId, inputHandleIndex,
          ...(outputHandleIndex !== undefined ? { outputHandleIndex } : {}),
          payload: Buffer.from(body.subarray(remStart, body.length)),
        });
        reader.seek(body.length);
        continue;
      }

      case RopId.MoveFolder:
      case RopId.CopyFolder:
      // v4.5.0 — Notifications
      case RopId.RegisterNotification:
      case RopId.ModifyRecipients:
      case RopId.ReadRecipients:
      case RopId.RemoveAllRecipients: {
        // Variable-length ROPs without an explicit length prefix:
        // - ModifyRecipients (v4.3.0): parsed completely by the handler.
        // - Other v4.5+ stubs (ecNotSupported) that ignore their payload.
        logonId = reader.readUint8();
        inputHandleIndex = reader.readUint8();
        const remStart = reader.position;
        rops.push({
          ropId, logonId, inputHandleIndex,
          payload: Buffer.from(body.subarray(remStart, body.length)),
        });
        // Abort stream parsing — these ROPs are variable-length without a
        // length prefix, we cannot safely jump to the next ROP.
        reader.seek(body.length);
        continue;
      }

      default: {
        // Unknown ROP — we consume the minimum (LogonId+InputHandleIndex)
        // and stop. The dispatcher will return ecNotSupported.
        if (reader.remaining >= 2) {
          logonId = reader.readUint8();
          inputHandleIndex = reader.readUint8();
        }
        rops.push({
          ropId, logonId,
          ...(inputHandleIndex !== undefined ? { inputHandleIndex } : {}),
          payload: Buffer.from(body.subarray(startOffset, reader.position)),
        });
        // Since we do not know the exact length → abort stream parsing
        break;
      }
    }
  }

  // Server object handle table: rest of the buffer, one uint32 each
  const handles: number[] = [];
  reader.seek(ropEndOffset);
  while (reader.remaining >= 4) {
    handles.push(reader.readUint32());
  }

  return { rops, serverObjectHandles: handles };
}

/**
 * Writes a response ROP stream structure into a buffer.
 * Mirror of parseRopBuffer for output.
 */
export class RopResponseBuilder {
  private rops: Buffer[] = [];
  private handles: number[] = [];

  /** Appends a finished ROP response (with RopId + payload). */
  appendRop(buf: Buffer): void {
    this.rops.push(buf);
  }

  /** Appends a handle to the ServerObjectHandleTable. */
  appendHandle(h: number): void {
    this.handles.push(h);
  }

  toBuffer(): Buffer {
    const ropPart = Buffer.concat(this.rops);
    const handlePart = Buffer.allocUnsafe(this.handles.length * 4);
    for (let i = 0; i < this.handles.length; i++) {
      handlePart.writeUInt32LE(this.handles[i]!, i * 4);
    }
    // RopSize = including the 2-byte length itself (some Outlook builds expect that)
    const header = Buffer.allocUnsafe(2);
    header.writeUInt16LE(ropPart.length + 2, 0);
    return Buffer.concat([header, ropPart, handlePart]);
  }

  get isEmpty(): boolean {
    return this.rops.length === 0;
  }
}

/**
 * Helper: writes an empty ecNotSupported ROP response into the builder
 * (for an unknown or not-yet-implemented ROP).
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

// Re-export as a convenience for the dispatcher.
export { Request };
