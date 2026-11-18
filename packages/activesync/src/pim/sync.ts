/**
 * Sync of one PIM collection ([MS-ASCMD] 2.2.1.21) — the class-independent part; the class
 * module renders and writes the items.
 *
 * SyncKeys are counters per collection (the items have no mailbox modSeq): priming answers
 * key 1, every later response the presented key + 1. The item state of commands/item-state.ts
 * decides what the device holds — the presented key must be the issued one (acknowledges the
 * last response: its pending rows become committed) or the acknowledged one (a retry: the same
 * changes are sent again); anything else, and a collection never primed, is Status 3.
 *
 * Client commands: Add (ClientId → ServerId in airsync:Responses; a retried Add with a
 * ClientId of the previous request gets the ServerId it got then, nothing is created twice),
 * Change and Delete. The device's own writes are recorded as held at their new version, so
 * they are not echoed; an item the server normalised is recorded at version 0 and comes back
 * as a Change.
 *
 * Server commands: Change, Delete and Add (inside the FilterType window), at most WindowSize
 * per response (MoreAvailable). A Change carries the complete item.
 */
import { el, getChild, getText, type WbxmlElement } from '../wbxml.js';
import { DEFAULT_BODY_PREFERENCE, parseBodyOptions, type BodyOptions, type BodyPreference } from '../commands/body.js';
import { isPrimingSyncKey, parseWindowSize, PRIMING_SYNC_KEY } from '../commands/sync-window.js';
import { ACK_KEY, acknowledgeSyncKey, forgetItems, knownItems, markKnown, recordPending, resetCollection } from '../commands/item-state.js';
import { applyRequestOptions } from '../commands/sync-options.js';
import type { EasVersion } from '../protocol-version.js';
import { moduleFor, resolveCollection } from './registry.js';
import { diffItems } from './state.js';
import { loadPimUser } from './user.js';
import { PIM_STATUS, type PimClassModule, type PimCollection, type PimUser, type RenderContext, type WriteContext } from './types.js';

export interface PimSyncContext {
  userId: string;
  deviceRowId: string | null;
  version: EasVersion;
  /** The device's syncKeys, updated in place (the caller merges the changed keys). */
  syncKeys: Record<string, string>;
  now: Date;
  /** Sync-level airsync:WindowSize (a collection's own one wins). */
  windowSize?: string;
}

/** airsync:Supported of the collection (names of the elements the client handles). */
export const SUPPORTED_KEY = (collectionId: string) => `sup:${collectionId}`;
/** ClientId → ServerId of the Adds of the last request (retry detection). */
const CLIENT_IDS_KEY = (collectionId: string) => `cid:${collectionId}`;

/** The body form sent for PIM items: plain text unless the client only takes HTML (no MIME). */
export function pimBodyPreference(opts: BodyOptions | null): BodyPreference {
  const prefs = opts?.prefs ?? [];
  const first = prefs[0];
  return prefs.find((p) => p.type === 1) ?? prefs.find((p) => p.type === 2) ?? (first ? { ...first, type: 1 } : DEFAULT_BODY_PREFERENCE);
}

export function storedSupported(syncKeys: Record<string, string>, collectionId: string): ReadonlySet<string> | null {
  try {
    const list = JSON.parse(syncKeys[SUPPORTED_KEY(collectionId)] ?? 'null') as unknown;
    return Array.isArray(list) ? new Set(list.filter((x): x is string => typeof x === 'string')) : null;
  } catch { return null; }
}

function readJsonMap(raw: string | undefined): Record<string, string> {
  try {
    const v = JSON.parse(raw ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {};
  } catch { return {}; }
}

const collectionElement = (className: string | undefined, collectionId: string, syncKey: string, status: string, rest: WbxmlElement[] = []) =>
  el('Collection', undefined, [
    ...(className ? [el('Class', className)] : []),
    el('SyncKey', syncKey),
    el('CollectionId', collectionId),
    el('Status', status),
    ...rest,
  ]);

const commandsOf = (e: WbxmlElement | undefined): WbxmlElement[] =>
  (e?.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string');

interface CommandScope {
  module: PimClassModule;
  collection: PimCollection;
  deviceRowId: string;
  write: WriteContext;
  syncKeys: Record<string, string>;
}

/** Client Add / Change / Delete; returns the airsync:Responses entries. */
async function applyClientCommands(commands: WbxmlElement, s: CommandScope): Promise<WbxmlElement[]> {
  const { module, collection, deviceRowId } = s;
  const responses: WbxmlElement[] = [];
  const previousAdds = readJsonMap(s.syncKeys[CLIENT_IDS_KEY(collection.id)]);
  const adds: Record<string, string> = {};
  // the device holds what it sent; a normalised item at version 0 → it gets the stored one back
  const held = (serverId: string, version: bigint, normalized?: boolean) =>
    markKnown(deviceRowId, collection.id, [{ serverId, modSeq: normalized ? 0n : version }]);

  for (const cmd of commandsOf(commands)) {
    const serverId = getText(cmd, 'ServerId');
    const data = getChild(cmd, 'ApplicationData');
    if (cmd.name === 'Add') {
      const clientId = getText(cmd, 'ClientId');
      const reply = (status: string, id?: string) => el('Add', undefined, [
        el('ClientId', clientId), ...(id ? [el('ServerId', id)] : []), el('Status', status),
      ]);
      const earlier = clientId ? previousAdds[clientId] : undefined;
      if (earlier) { adds[clientId] = earlier; responses.push(reply(PIM_STATUS.SUCCESS, earlier)); continue; }
      if (!clientId || !data) { responses.push(reply(PIM_STATUS.CONVERSION_ERROR)); continue; }
      const result = await module.create(collection, data, s.write);
      if (!result.ok) { responses.push(reply(result.status)); continue; }
      await held(result.serverId, result.version, result.normalized);
      adds[clientId] = result.serverId;
      responses.push(reply(PIM_STATUS.SUCCESS, result.serverId));
    } else if (cmd.name === 'Change') {
      if (!serverId || !data) continue;
      const result = await module.update(collection, serverId, data, s.write);
      if (result.ok) await held(result.serverId, result.version, result.normalized);
      else responses.push(el('Change', undefined, [el('ServerId', serverId), el('Status', result.status)]));
    } else if (cmd.name === 'Delete') {
      if (!serverId) continue;
      if (!await module.remove(collection, serverId, s.write)) {
        responses.push(el('Delete', undefined, [el('ServerId', serverId), el('Status', PIM_STATUS.OBJECT_NOT_FOUND)]));
      }
      await forgetItems(deviceRowId, collection.id, [serverId]);
    }
  }
  if (Object.keys(adds).length > 0) s.syncKeys[CLIENT_IDS_KEY(collection.id)] = JSON.stringify(adds);
  return responses;
}

/** Changes, Deletes, then Adds — at most `windowSize`; records them as pending under `newKey`. */
async function serverCommands(
  s: CommandScope, filterType: number | undefined, render: RenderContext, newKey: string, windowSize: number, now: Date,
): Promise<{ commands: WbxmlElement[]; moreAvailable: boolean }> {
  const { module, collection, deviceRowId } = s;
  const diff = diffItems(await module.states(collection, filterType, now), await knownItems(deviceRowId, collection.id));
  const ordered: Array<['Change' | 'Delete' | 'Add', string]> = [
    ...diff.changes.map((id) => ['Change', id] as ['Change', string]),
    ...diff.deletes.map((id) => ['Delete', id] as ['Delete', string]),
    ...diff.adds.map((id) => ['Add', id] as ['Add', string]),
  ];
  const page = ordered.slice(0, windowSize);
  const rows = new Map((await module.load(collection, page.filter(([k]) => k !== 'Delete').map(([, id]) => id))).map((r) => [module.rowId(r), r]));
  const commands: WbxmlElement[] = [];
  const pending: Array<{ serverId: string; modSeq: bigint | null }> = [];
  for (const [kind, id] of page) {
    if (kind === 'Delete') {
      commands.push(el('Delete', undefined, [el('ServerId', id)]));
      pending.push({ serverId: id, modSeq: null });
      continue;
    }
    const row = rows.get(id);
    if (!row) continue; // deleted meanwhile: a Delete with the next Sync
    commands.push(el(kind, undefined, [el('ServerId', id), el('ApplicationData', undefined, module.render(row, render))]));
    pending.push({ serverId: id, modSeq: module.rowVersion(row) });
  }
  await recordPending(deviceRowId, collection.id, newKey, pending);
  return { commands, moreAvailable: ordered.length > page.length };
}

/** One request Collection of a calendar / tasks / notes collection → its response Collection. */
export async function syncPimCollection(request: WbxmlElement, ctx: PimSyncContext): Promise<WbxmlElement> {
  const collectionId = getText(request, 'CollectionId');
  const clientKey = getText(request, 'SyncKey');
  const className = moduleFor(collectionId)?.className;
  const status = (s: string, key = clientKey) => collectionElement(className, collectionId, key, s);

  const resolved = await resolveCollection(ctx.userId, collectionId, ctx.version);
  if (resolved.status === 'unknown') return status(PIM_STATUS.OBJECT_NOT_FOUND);
  // the class was switched off: the folder is gone from the hierarchy → FolderSync
  if (resolved.status === 'disabled') return status(PIM_STATUS.HIERARCHY_CHANGED);
  if (resolved.status === 'error') return status(PIM_STATUS.RETRY);
  const { module, collection } = resolved;
  // every Sync needs a provisioned device (device policy); without its row there is no item state
  if (!ctx.deviceRowId) return status(PIM_STATUS.INVALID_SYNC_KEY, '0');
  const deviceRowId = ctx.deviceRowId;

  const { options, filterChanged } = applyRequestOptions(ctx.syncKeys, collectionId, parseBodyOptions(request, module.className));

  if (isPrimingSyncKey(clientKey)) {
    ctx.syncKeys[collectionId] = PRIMING_SYNC_KEY;
    ctx.syncKeys[ACK_KEY(collectionId)] = PRIMING_SYNC_KEY;
    const supported = getChild(request, 'Supported');
    if (supported) ctx.syncKeys[SUPPORTED_KEY(collectionId)] = JSON.stringify(commandsOf(supported).map((c) => c.name));
    await resetCollection(deviceRowId, collectionId);
    return status(PIM_STATUS.SUCCESS, PRIMING_SYNC_KEY);
  }
  if (filterChanged || ctx.syncKeys[ACK_KEY(collectionId)] === undefined
    || !await acknowledgeSyncKey(deviceRowId, collectionId, clientKey, ctx.syncKeys)) {
    return status(PIM_STATUS.INVALID_SYNC_KEY, '0');
  }

  const user: PimUser | null = await loadPimUser(ctx.userId);
  if (!user) return status(PIM_STATUS.OBJECT_NOT_FOUND);
  const bodyPref = pimBodyPreference(options);
  const scope: CommandScope = {
    module, collection, deviceRowId, syncKeys: ctx.syncKeys,
    write: {
      version: ctx.version, user, now: ctx.now, supported: storedSupported(ctx.syncKeys, collectionId),
      ...(bodyPref.truncationSize !== undefined ? { truncatedAt: bodyPref.truncationSize } : {}),
    },
  };
  const commands = getChild(request, 'Commands');
  const responses = commands ? await applyClientCommands(commands, scope) : [];

  const newKey = (BigInt(clientKey) + 1n).toString();
  const out = getText(request, 'GetChanges') === '0'
    ? { commands: [], moreAvailable: false }
    : await serverCommands(scope, options?.filterType, { version: ctx.version, bodyPref, user },
        newKey, parseWindowSize(getText(request, 'WindowSize') || ctx.windowSize), ctx.now);
  ctx.syncKeys[collectionId] = newKey;

  return collectionElement(module.className, collectionId, newKey, PIM_STATUS.SUCCESS, [
    ...(out.moreAvailable ? [el('MoreAvailable', '')] : []),
    ...(out.commands.length > 0 ? [el('Commands', undefined, out.commands)] : []),
    ...(responses.length > 0 ? [el('Responses', undefined, responses)] : []),
  ]);
}
