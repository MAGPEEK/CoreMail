/**
 * Named Properties (v5.1.0)
 *
 * Outlook addresses Calendar/Contact/Task/Note properties NOT via fixed
 * uint16 PropertyIds (like PR_SUBJECT_W = 0x0037) but via GUID+LID pairs
 * ("Property Set ID" + "Long ID"). Example:
 *
 *   PSETID_Appointment = {00062002-0000-0000-C000-000000000046}
 *   LID 0x820D = "AppointmentStartWhole" (start date of an appointment, PT_SYSTIME)
 *
 * The server must map these named properties at runtime to local uint16 IDs
 * in the range 0x8000-0xFFFF ("property mapping"). Outlook requests this with:
 *
 *   RopGetPropertyIdsFromNames: list of {GUID, LID, Kind} → list of uint16 IDs
 *   RopGetNamesFromPropertyIds: reverse mapping
 *
 * We keep the cache in the session state (mapi:session:<token>.namedPropMap).
 * The mapping is built on the first OpenMessage(IPM.Appointment).
 *
 * MS-OXPROPS § 2.x documents the canonical LIDs for each property set.
 */

import { createLogger } from '@coremail/core';
import { getMapiSession } from './session-store.js';

const log = createLogger('mapi:named-properties');

// ── PropertySet GUIDs (MS-OXPROPS §1.3.2) ────────────────────────────────

export const PSETID_Common      = '00062008-0000-0000-c000-000000000046';
export const PSETID_Appointment = '00062002-0000-0000-c000-000000000046';
export const PSETID_Task        = '00062003-0000-0000-c000-000000000046';
export const PSETID_Address     = '00062004-0000-0000-c000-000000000046';
export const PSETID_Note        = '0006200e-0000-0000-c000-000000000046';
export const PSETID_Meeting     = '6ed8da90-450b-101b-98da-00aa003f1305';
export const PS_INTERNET_HEADERS= '00020386-0000-0000-c000-000000000046';
export const PS_PUBLIC_STRINGS  = '00020329-0000-0000-c000-000000000046';

// ── Named Property Kinds (MS-OXCDATA §2.6) ───────────────────────────────

export const NAMED_KIND_LID    = 0x00;   // 32-bit numeric LID
export const NAMED_KIND_NAME   = 0x01;   // Unicode string

// ── Standard Named Property LIDs ──────────────────────────────────────────

/** Standard LIDs for PSETID_Appointment (MS-OXOCAL §2.2.x). */
export const LID_APPOINTMENT_SEQUENCE      = 0x8201;
export const LID_BUSY_STATUS               = 0x8205;
export const LID_LOCATION                  = 0x8208;
export const LID_APPOINTMENT_START_WHOLE   = 0x820D;
export const LID_APPOINTMENT_END_WHOLE     = 0x820E;
export const LID_APPOINTMENT_DURATION      = 0x8213;
export const LID_APPOINTMENT_SUB_TYPE      = 0x8215;   // boolean: all-day
export const LID_APPOINTMENT_RECUR         = 0x8216;
export const LID_APPOINTMENT_STATE_FLAGS   = 0x8217;
export const LID_RESPONSE_STATUS           = 0x8218;
export const LID_RECURRING                 = 0x8223;
export const LID_INTENDED_BUSY_STATUS      = 0x8224;
export const LID_REMINDER_DELTA            = 0x8501;
export const LID_REMINDER_SET              = 0x8503;
export const LID_REMINDER_SIGNAL_TIME      = 0x8560;

/** Standard LIDs for PSETID_Address (MS-OXOCNTC §2.2.x). */
export const LID_EMAIL1_DISPLAY_NAME       = 0x8080;
export const LID_EMAIL1_ADDRESS_TYPE       = 0x8082;
export const LID_EMAIL1_EMAIL_ADDRESS      = 0x8083;
export const LID_EMAIL2_DISPLAY_NAME       = 0x8090;
export const LID_EMAIL2_EMAIL_ADDRESS      = 0x8093;
export const LID_FILE_AS                   = 0x8005;
export const LID_INSTANT_MESSAGING_ADDRESS = 0x8062;
export const LID_WORK_ADDRESS              = 0x801B;

/** Standard LIDs for PSETID_Task (MS-OXOTASK §2.2.x). */
export const LID_TASK_STATUS               = 0x8101;
export const LID_PERCENT_COMPLETE          = 0x8102;
export const LID_TASK_START_DATE           = 0x8104;
export const LID_TASK_DUE_DATE             = 0x8105;
export const LID_TASK_DATE_COMPLETED       = 0x810F;
export const LID_TASK_COMPLETE             = 0x811C;
export const LID_TASK_OWNER                = 0x811F;

/** Standard LIDs for PSETID_Note (MS-OXONOTE §2.2.x). */
export const LID_NOTE_COLOR                = 0x8B00;
export const LID_NOTE_WIDTH                = 0x8B02;
export const LID_NOTE_HEIGHT               = 0x8B03;

// ── Named Property Type ───────────────────────────────────────────────────

export interface NamedProperty {
  kind: typeof NAMED_KIND_LID | typeof NAMED_KIND_NAME;
  guid: string;                          // lowercase canonical
  lid?: number;                          // if kind === LID
  name?: string;                         // if kind === NAME
}

export interface NamedPropertyMap {
  /** local uint16 IDs in the range 0x8000-0xFFFF, indexed by serialized key */
  byKey: Record<string, number>;
  /** reverse mapping: uint16 → NamedProperty */
  byId:  Record<number, NamedProperty>;
  /** next uint16 ID to assign (start: 0x8000) */
  nextId: number;
}

/**
 * Unique string key for a NamedProperty (for hash lookup).
 */
export function namedPropKey(np: NamedProperty): string {
  const g = np.guid.toLowerCase();
  return np.kind === NAMED_KIND_LID
    ? `${g}|lid|${np.lid?.toString(16)}`
    : `${g}|name|${np.name}`;
}

/**
 * Loads (or initializes) the named-property map of a session.
 */
export async function getNamedPropMap(sessionToken: string): Promise<NamedPropertyMap> {
  const session = await getMapiSession(sessionToken);
  const raw = session as unknown as { namedPropMap?: NamedPropertyMap };
  if (raw?.namedPropMap) return raw.namedPropMap;
  return { byKey: {}, byId: {}, nextId: 0x8000 };
}

/**
 * Maps a list of NamedProperty requests to uint16 IDs.
 * Assigns new IDs for names not yet known.
 */
export function resolveNamedProperties(
  map: NamedPropertyMap,
  requests: NamedProperty[],
): { ids: number[]; map: NamedPropertyMap } {
  const ids: number[] = [];
  const out: NamedPropertyMap = { byKey: { ...map.byKey }, byId: { ...map.byId }, nextId: map.nextId };
  for (const req of requests) {
    const key = namedPropKey(req);
    let id = out.byKey[key];
    if (id === undefined) {
      id = out.nextId++;
      out.byKey[key] = id;
      out.byId[id]   = req;
    }
    ids.push(id);
  }
  return { ids, map: out };
}

/**
 * Reverse-Lookup: uint16-IDs → NamedProperty[].
 */
export function reverseNamedProperties(
  map: NamedPropertyMap,
  ids: number[],
): NamedProperty[] {
  return ids.map((id) => map.byId[id]).filter((x): x is NamedProperty => x !== undefined);
}

/**
 * Persists the named-property map back into the session.
 */
export async function saveNamedPropMap(sessionToken: string, map: NamedPropertyMap): Promise<void> {
  const { getRedisClient } = await import('@coremail/core');
  const redis = getRedisClient();
  const KEY = `mapi:session:${sessionToken}`;
  const raw = await redis.get(KEY);
  if (!raw) return;
  const state = JSON.parse(raw) as Record<string, unknown>;
  state['namedPropMap'] = map;
  state['lastSeen'] = Date.now();
  await redis.set(KEY, JSON.stringify(state), 'EX', 600);
}

/**
 * Convenience: creates a NamedProperty for a PSETID_*+LID entry.
 */
export function lidProp(guid: string, lid: number): NamedProperty {
  return { kind: NAMED_KIND_LID, guid: guid.toLowerCase(), lid };
}

// Suppress unused-warning during dev
void log;
