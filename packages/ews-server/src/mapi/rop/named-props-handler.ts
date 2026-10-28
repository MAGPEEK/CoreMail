/**
 * Named-Properties ROP-Handler (v5.1.0)
 *
 * Implementiert:
 *   - RopGetPropertyIdsFromNames (MS-OXCPRPT §2.2.5.2)
 *   - RopGetNamesFromPropertyIds (MS-OXCPRPT §2.2.5.1)
 *
 * Beide ROPs verwalten das Mapping zwischen "Named Properties" (GUID + LID/Name)
 * und lokalen uint16-PropertyIds im 0x8000-0xFFFF-Range, das pro Session
 * konsistent bleibt.
 */

import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId } from '../rop-types.js';
import {
  getNamedPropMap, saveNamedPropMap, resolveNamedProperties,
  reverseNamedProperties, NAMED_KIND_LID, NAMED_KIND_NAME,
  type NamedProperty,
} from '../named-properties.js';
import type { RopRequest } from '../rop-codec.js';

const log = createLogger('mapi:rop:named-props');

/**
 * RopGetPropertyIdsFromNames
 *
 * Payload (MS-OXCPRPT §2.2.5.2.1):
 *   Flags(uint8) | PropertyNameCount(uint16) | PropertyNames(variable)
 *
 * Jeder PropertyName:
 *   Kind(uint8) | PropertySetGuid(16 bytes) | [LID(uint32) | NameSize(uint8) | Name(UTF-16-LE null-term)]
 *
 * Response:
 *   ReturnValue + PropertyIdCount(uint16) + PropertyIds(uint16[])
 */
export async function handleRopGetPropertyIdsFromNames(
  rop: RopRequest,
  sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const r = new MapiReader(rop.payload);
  r.readUint8();                               // Flags
  const count = r.readUint16();
  const requests: NamedProperty[] = [];
  for (let i = 0; i < count; i++) {
    try {
      const kind = r.readUint8();
      const guid = r.readGuidString();
      if (kind === NAMED_KIND_LID) {
        const lid = r.readUint32();
        requests.push({ kind, guid: guid.toLowerCase(), lid });
      } else if (kind === NAMED_KIND_NAME) {
        const name = r.readUtf16String();
        requests.push({ kind, guid: guid.toLowerCase(), name });
      } else {
        log.warn({ kind, i }, 'GetPropertyIdsFromNames: unbekannter Kind');
        break;
      }
    } catch (err) {
      log.warn({ err, parsedCount: requests.length }, 'GetPropertyIdsFromNames: Parse-Fehler');
      break;
    }
  }

  const map = await getNamedPropMap(sessionToken);
  const { ids, map: newMap } = resolveNamedProperties(map, requests);
  await saveNamedPropMap(sessionToken, newMap);

  const w = new MapiWriter();
  w.writeUint8(RopId.GetPropertyIdsFromNames);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint16(ids.length);
  for (const id of ids) w.writeUint16(id);
  log.debug({ count: ids.length, nextId: newMap.nextId }, 'GetPropertyIdsFromNames OK');
  return w.toBuffer();
}

/**
 * RopGetNamesFromPropertyIds
 *
 * Payload:
 *   PropertyIdCount(uint16) | PropertyIds(uint16[])
 *
 * Response:
 *   ReturnValue + PropertyNameCount(uint16) + PropertyNames(variable)
 */
export async function handleRopGetNamesFromPropertyIds(
  rop: RopRequest,
  sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const r = new MapiReader(rop.payload);
  const count = r.readUint16();
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(r.readUint16());

  const map = await getNamedPropMap(sessionToken);
  const props = reverseNamedProperties(map, ids);

  const w = new MapiWriter();
  w.writeUint8(RopId.GetNamesFromPropertyIds);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint16(props.length);
  for (const p of props) {
    w.writeUint8(p.kind);
    writeGuidString(w, p.guid);
    if (p.kind === NAMED_KIND_LID) {
      w.writeUint32(p.lid ?? 0);
    } else {
      w.writeUtf16String(p.name ?? '');
    }
  }
  log.debug({ count: props.length }, 'GetNamesFromPropertyIds OK');
  return w.toBuffer();
}

/**
 * Schreibt eine GUID im MS-DTYP-Format (4-2-2-8 bytes, gemischte Endianness).
 * Akzeptiert das kanonische "00062002-0000-0000-c000-000000000046"-Format.
 */
function writeGuidString(w: MapiWriter, guidStr: string): void {
  const hex = guidStr.replace(/-/g, '');
  if (hex.length !== 32) {
    // Fallback: 16 Nullbytes
    w.writeBuffer(Buffer.alloc(16));
    return;
  }
  const data1 = parseInt(hex.slice(0, 8), 16);   // little-endian uint32
  const data2 = parseInt(hex.slice(8, 12), 16);  // little-endian uint16
  const data3 = parseInt(hex.slice(12, 16), 16); // little-endian uint16
  const data4 = Buffer.from(hex.slice(16), 'hex'); // 8 bytes big-endian

  w.writeUint32(data1);
  w.writeUint16(data2);
  w.writeUint16(data3);
  w.writeBuffer(data4);
}
