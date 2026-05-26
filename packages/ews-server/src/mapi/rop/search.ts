/**
 * Search-ROP-Handler (v4.8.0)
 *
 * Implementiert:
 *   - RopRestrict   (MS-OXCTABL §2.2.2.4) — Filter auf Content-Tabelle setzen
 *   - RopFindRow    (MS-OXCTABL §2.2.2.13) — finde nächste Zeile die matcht
 *
 * Restriction-Format (MS-OXCDATA §2.12):
 *   RestrictType(uint8) + Restriction-spezifische Felder
 *
 * Unterstützte RestrictTypes für v4.8.0 MVP:
 *   ResAnd (0x00)       — AND von child restrictions
 *   ResOr  (0x01)       — OR
 *   ResNot (0x02)
 *   ResContent (0x03)   — Property contains/equals/starts-with value
 *   ResProperty (0x04)  — Property comparison (EQ/GT/LT)
 *   ResExist (0x08)     — Property is set
 *
 * Restriction wird in `columns`-Slot des Table-Handles persistiert (zusätzlich
 * zu Spalten) und beim nächsten QueryRows als Prisma where-Clause angewendet.
 */

import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId, PR, getPropId, getPropType, PropType } from '../rop-types.js';
import { resolveHandleIndex, updateRopObject, type RopObject } from '../rop-handle-table.js';
import { readPropertyValue } from '../property-codec.js';
import type { RopRequest } from '../rop-codec.js';

const log = createLogger('mapi:rop:search');

// MS-OXCDATA §2.12 RestrictType
const RES_AND       = 0x00;
const RES_OR        = 0x01;
const RES_NOT       = 0x02;
const RES_CONTENT   = 0x03;
const RES_PROPERTY  = 0x04;
const RES_EXIST     = 0x08;

// RES_CONTENT.FuzzyLevel low byte (MS-OXCDATA §2.12.4.1.1)
const FL_FULLSTRING = 0x0000;
const FL_SUBSTRING  = 0x0001;
const FL_PREFIX     = 0x0002;
const FL_IGNORECASE = 0x00010000;

// RES_PROPERTY.RelOp (MS-OXCDATA §2.12.5.1)
const RELOP_LT       = 0;
const RELOP_LE       = 1;
const RELOP_GT       = 2;
const RELOP_GE       = 3;
const RELOP_EQ       = 4;
const RELOP_NE       = 5;

/**
 * v4.8.0: RopRestrict — speichert Restriction am Table-Handle für QueryRows.
 */
export async function handleRopRestrict(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'table') {
    return writeSearchError(RopId.Restrict, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const r = new MapiReader(rop.payload);
  r.readUint8();                        // RestrictFlags
  r.readUint16();                       // RestrictionSize
  let restriction: ParsedRestriction | null = null;
  try {
    restriction = parseRestriction(r);
  } catch (err) {
    log.warn({ err }, 'RopRestrict: Restriction-Parse-Fehler — Restriction wird ignoriert');
  }

  await updateRopObject(sessionToken, input.handle, {
    ...input.object,
    // dynamic field added to table handle; JSON-round-trip preserves it
    restriction,
  } as unknown as Partial<RopObject>);

  // Response: ReturnValue + TableStatus(uint8)
  const w = new MapiWriter();
  w.writeUint8(RopId.Restrict);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(0);                      // TableStatus = TBLSTAT_COMPLETE
  log.debug({ handle: input.handle, hasRestriction: !!restriction }, 'RopRestrict OK');
  return w.toBuffer();
}

/**
 * v4.8.0: RopFindRow — sucht in einer Content-Tabelle die nächste Zeile,
 * die der Restriction entspricht.
 *
 * Response (MS-OXCTABL §2.2.2.13.2):
 *   ReturnValue + RowNoLongerVisible(1) + HasRowData(1) + Row(variable)
 *
 * v4.8.0 minimal: liefert "kein Match" (HasRowData=0). Volle Implementation
 * bräuchte Cursor-Position-Tracking + Restriction-Matching gegen die nächste
 * Zeile aus dem Backing-Store. Für Outlook-Search-Folder-Workflows ist
 * RopRestrict + nachfolgendes RopQueryRows der Hauptpfad.
 */
export async function handleRopFindRow(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'table') {
    return writeSearchError(RopId.FindRow, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.FindRow);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(0);                      // RowNoLongerVisible = false
  w.writeUint8(0);                      // HasRowData = false
  log.debug({ handle: input.handle }, 'RopFindRow OK (no match)');
  return w.toBuffer();
}

// ── Restriction-Parsing & Prisma-Mapping ──────────────────────────────────

export type ParsedRestriction =
  | { kind: 'and'; sub: ParsedRestriction[] }
  | { kind: 'or';  sub: ParsedRestriction[] }
  | { kind: 'not'; sub: ParsedRestriction }
  | { kind: 'content'; tag: number; fuzzy: number; value: unknown }
  | { kind: 'property'; tag: number; relop: number; value: unknown }
  | { kind: 'exist'; tag: number };

function parseRestriction(r: MapiReader): ParsedRestriction {
  const type = r.readUint8();
  switch (type) {
    case RES_AND:
    case RES_OR: {
      const subCount = r.readUint16();
      const sub: ParsedRestriction[] = [];
      for (let i = 0; i < subCount; i++) sub.push(parseRestriction(r));
      return type === RES_AND ? { kind: 'and', sub } : { kind: 'or', sub };
    }
    case RES_NOT:
      return { kind: 'not', sub: parseRestriction(r) };
    case RES_CONTENT: {
      const fuzzy = r.readUint32();
      const tag = r.readUint32();
      // PropertyValue (tag + value), aber Outlook sendet manchmal duplicate
      r.readUint32();                   // duplicate-tag
      const value = readPropertyValue(r, getPropType(tag));
      return { kind: 'content', tag, fuzzy, value };
    }
    case RES_PROPERTY: {
      const relop = r.readUint8();
      const tag = r.readUint32();
      r.readUint32();
      const value = readPropertyValue(r, getPropType(tag));
      return { kind: 'property', tag, relop, value };
    }
    case RES_EXIST: {
      const tag = r.readUint32();
      return { kind: 'exist', tag };
    }
    default:
      throw new RangeError(`parseRestriction: unsupported type 0x${type.toString(16)}`);
  }
}

/**
 * Konvertiert eine ParsedRestriction in eine Prisma `where`-Clause für die
 * Message-Tabelle. Unbekannte Tags werden ignoriert (no-op match-all-true).
 */
export function restrictionToPrismaWhere(restr: ParsedRestriction | null): Record<string, unknown> {
  if (!restr) return {};
  switch (restr.kind) {
    case 'and':
      return { AND: restr.sub.map(restrictionToPrismaWhere).filter((x) => Object.keys(x).length > 0) };
    case 'or':
      return { OR: restr.sub.map(restrictionToPrismaWhere).filter((x) => Object.keys(x).length > 0) };
    case 'not':
      return { NOT: restrictionToPrismaWhere(restr.sub) };
    case 'content': {
      const field = tagToPrismaField(restr.tag);
      if (!field) return {};
      const v = String(restr.value ?? '');
      // FuzzyLevel low byte: 0=FullString, 1=Substring, 2=Prefix
      const fuzzyLow = restr.fuzzy & 0xFFFF;
      const mode = (restr.fuzzy & FL_IGNORECASE) ? 'insensitive' : undefined;
      if (fuzzyLow === FL_SUBSTRING) {
        return { [field]: { contains: v, ...(mode ? { mode } : {}) } };
      }
      if (fuzzyLow === FL_PREFIX) {
        return { [field]: { startsWith: v, ...(mode ? { mode } : {}) } };
      }
      // Default = FullString
      return { [field]: { equals: v, ...(mode ? { mode } : {}) } };
    }
    case 'property': {
      const field = tagToPrismaField(restr.tag);
      if (!field) return {};
      const op = relopToPrismaOp(restr.relop);
      return { [field]: { [op]: restr.value } };
    }
    case 'exist': {
      const field = tagToPrismaField(restr.tag);
      if (!field) return {};
      return { [field]: { not: null } };
    }
  }
  return {};
}

function tagToPrismaField(tag: number): string | null {
  // Property-Type wird ignoriert — wir matchen nur PropertyId
  const id = getPropId(tag);
  switch (id) {
    case 0x0037: return 'subject';                // PR_SUBJECT_W
    case 0x0E1D: return 'subject';                // PR_NORMALIZED_SUBJECT_W
    case 0x1000: return 'bodyText';               // PR_BODY_W
    case 0x1013: return 'bodyHtml';               // PR_HTML
    case 0x0C1A: return 'fromName';               // PR_SENDER_NAME_W
    case 0x0C1F: return 'fromAddr';               // PR_SENDER_EMAIL_ADDRESS_W
    case 0x0E04: return 'toAddrs';                // PR_DISPLAY_TO_W — Array
    case 0x0E06: return 'date';                   // PR_MESSAGE_DELIVERY_TIME
    case 0x0039: return 'date';                   // PR_CLIENT_SUBMIT_TIME
    case 0x0E07: return 'flags';                  // PR_MESSAGE_FLAGS
    case 0x0E08: return 'rawSize';                // PR_MESSAGE_SIZE
    default:     return null;
  }
}

function relopToPrismaOp(relop: number): string {
  switch (relop) {
    case RELOP_LT: return 'lt';
    case RELOP_LE: return 'lte';
    case RELOP_GT: return 'gt';
    case RELOP_GE: return 'gte';
    case RELOP_EQ: return 'equals';
    case RELOP_NE: return 'not';
    default:       return 'equals';
  }
}

function writeSearchError(ropId: number, rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(ropId);
  w.writeUint8(rop.outputHandleIndex ?? rop.inputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}

// Suppress unused-import warnings
void PR; void PropType; void prisma;
