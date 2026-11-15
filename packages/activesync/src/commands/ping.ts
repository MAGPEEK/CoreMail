import { prisma } from '@coremail/storage/prisma';
import { encodeWbxml, el, getText, getChild, type WbxmlElement } from '../wbxml.js';
import type { Response } from 'express';
import { easLiveRequests, type EasCredentialInfo } from '../live-sessions.js';
import { knownItems } from './item-state.js';
import { mergeSyncKeys } from './sync-keys.js';

/** [MS-ASCMD] Ping status values. */
export const PING_STATUS = {
  EXPIRED: '1',
  CHANGES: '2',
  MISSING_PARAMETERS: '3',
  BAD_HEARTBEAT: '5',
  FOLDER_HIERARCHY_SYNC: '7',
} as const;

export const MIN_HEARTBEAT = 60;    // seconds
export const MAX_HEARTBEAT = 3540;  // 59 minutes
/** Cached Ping parameters in ActiveSyncDevice.syncKeys (an empty Ping reuses them). */
const PING_CACHE_KEY = 'ping';

export interface PingOptions {
  /** EAS DeviceId (parameter cache + the device's SyncKeys as change baseline). */
  deviceId?: string;
  pollIntervalMs?: number;
  minHeartbeatSec?: number;
  maxHeartbeatSec?: number;
}

interface PingParams { heartbeat: number; folders: string[] }

function send(res: Response, children: WbxmlElement[]): void {
  res.set('Content-Type', 'application/vnd.ms-sync.wbxml');
  res.set('MS-Server-ActiveSync', '14.1');
  res.status(200).send(encodeWbxml(el('Ping', undefined, children)));
}

function cachedParams(syncKeys: Record<string, string>): Partial<PingParams> {
  try {
    const p = JSON.parse(syncKeys[PING_CACHE_KEY] ?? '{}') as Partial<PingParams>;
    return {
      ...(typeof p.heartbeat === 'number' ? { heartbeat: p.heartbeat } : {}),
      ...(Array.isArray(p.folders) ? { folders: p.folders.filter((f): f is string => typeof f === 'string') } : {}),
    };
  } catch { return {}; }
}

/**
 * Ping command — long-poll push notification.
 *
 * Parameters: HeartbeatInterval + Folders from the request; a Ping without them (or an
 * empty Ping) reuses the last parameters of the device, else Status 3. A heartbeat outside
 * [MIN_HEARTBEAT, MAX_HEARTBEAT] → Status 5 with the allowed limit; a folder that is not
 * the user's → Status 7 (folder hierarchy sync required).
 *
 * Changes are detected against the SyncKey the device last received for each folder (a
 * modSeq bound, see sync-window.ts): any row of the folder with a newer modSeq (new mail,
 * flag change, expunge tombstone) or an item the device holds that moved away. Changes that
 * happened before the Ping started are reported at once. The response lists the changed
 * folders as `<Folders><Folder>serverId</Folder></Folders>`.
 *
 * v7.1.0: ends early with HTTP 401 when the request's credentials become invalid
 * (MS-ASHTTP — the device asks for new credentials; Ping has no status for it), and stops
 * polling when the client disconnects.
 */
export async function handlePing(
  body: WbxmlElement | null,
  userId: string,
  res: Response,
  auth: EasCredentialInfo = {},
  opts: PingOptions = {},
): Promise<void> {
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const minHeartbeat = opts.minHeartbeatSec ?? MIN_HEARTBEAT;
  const maxHeartbeat = opts.maxHeartbeatSec ?? MAX_HEARTBEAT;

  const device = opts.deviceId
    ? await prisma.activeSyncDevice.findUnique({
        where: { userId_deviceId: { userId, deviceId: opts.deviceId } },
        select: { id: true, syncKeys: true },
      })
    : null;
  const syncKeys: Record<string, string> = { ...((device?.syncKeys as Record<string, string> | null) ?? {}) };
  const cached = cachedParams(syncKeys);

  // ── Parameters ──────────────────────────────────────────────────────────────
  const hbText = body ? getText(body, 'HeartbeatInterval') : '';
  let heartbeat: number | undefined = cached.heartbeat;
  if (hbText !== '') heartbeat = /^\d{1,6}$/.test(hbText) ? Number(hbText) : Number.NaN;
  const requested: string[] = [];
  const folderList = body ? getChild(body, 'Folders') : undefined;
  for (const child of folderList?.children ?? []) {
    if (typeof child === 'string' || child.name !== 'Folder') continue;
    const id = getText(child, 'Id');
    if (id && !requested.includes(id)) requested.push(id);
  }
  const folderIds = requested.length > 0 ? requested : cached.folders ?? [];
  if (heartbeat === undefined || Number.isNaN(heartbeat) || folderIds.length === 0) {
    send(res, [el('Status', PING_STATUS.MISSING_PARAMETERS)]);
    return;
  }
  if (heartbeat < minHeartbeat || heartbeat > maxHeartbeat) {
    send(res, [el('Status', PING_STATUS.BAD_HEARTBEAT), el('HeartbeatInterval', String(heartbeat < minHeartbeat ? minHeartbeat : maxHeartbeat))]);
    return;
  }

  const folders = await prisma.folder.findMany({
    where: { id: { in: folderIds }, mailbox: { userId } },
    select: { id: true, mailboxId: true },
  });
  if (folders.length !== folderIds.length) {
    send(res, [el('Status', PING_STATUS.FOLDER_HIERARCHY_SYNC)]);
    return;
  }

  if (device) {
    const params = JSON.stringify({ heartbeat, folders: folderIds });
    if (syncKeys[PING_CACHE_KEY] !== params) {
      // 8.0.0: atomic merge of the Ping key only (no stale write-back of Sync keys).
      await mergeSyncKeys(device.id, { [PING_CACHE_KEY]: params });
    }
  }

  // ── Change detection ────────────────────────────────────────────────────────
  const mailboxIds = [...new Set(folders.map((f) => f.mailboxId))];
  const highest = async (mailboxId: string): Promise<bigint> =>
    (await prisma.mailbox.findUnique({ where: { id: mailboxId }, select: { highestModSeq: true } }))?.highestModSeq ?? 0n;
  // Baseline per folder: the SyncKey the device last received, else "now".
  const baseline = new Map<string, bigint>();
  for (const mailboxId of mailboxIds) {
    const now = (await highest(mailboxId)) + 1n;
    for (const f of folders.filter((x) => x.mailboxId === mailboxId)) {
      const key = syncKeys[f.id];
      baseline.set(f.id, key && /^\d{1,20}$/.test(key) && key !== '0' ? BigInt(key) : now);
    }
  }

  async function folderChanged(folderId: string, mailboxId: string, since: bigint): Promise<boolean> {
    const row = await prisma.message.findFirst({ where: { folderId, modSeq: { gte: since } }, select: { id: true } });
    if (row) return true;
    if (!device) return false;
    const moved = await prisma.message.findMany({
      where: { folder: { mailboxId }, modSeq: { gte: since }, folderId: { not: folderId } },
      select: { id: true },
      take: 500,
    });
    return moved.length > 0 && (await knownItems(device.id, folderId, moved.map((m) => m.id))).size > 0;
  }

  const lastChecked = new Map<string, bigint>();
  async function changedFolders(): Promise<string[]> {
    const changed: string[] = [];
    for (const mailboxId of mailboxIds) {
      const hi = await highest(mailboxId);
      if (lastChecked.get(mailboxId) === hi) continue; // nothing new since the last check
      lastChecked.set(mailboxId, hi);
      for (const f of folders.filter((x) => x.mailboxId === mailboxId)) {
        const since = baseline.get(f.id)!;
        if (hi >= since && await folderChanged(f.id, mailboxId, since)) changed.push(f.id);
      }
    }
    return changed;
  }

  // ── Long poll ───────────────────────────────────────────────────────────────
  const deadline = Date.now() + heartbeat * 1000;
  // v7.1.0: credential change → wake up and answer 401; client gone → stop polling.
  let revoked = false;
  let aborted = false;
  let wake: (() => void) | null = null;
  const unregister = easLiveRequests.register({
    userId,
    credential: auth.credential ?? 'unknown',
    ...(auth.appPasswordId ? { appPasswordId: auth.appPasswordId } : {}),
    terminate: () => { revoked = true; wake?.(); },
  }, auth.authStartedAt);
  res.once('close', () => { aborted = true; unregister(); wake?.(); });

  let changed: string[] = [];
  try {
    changed = revoked ? [] : await changedFolders();
    while (changed.length === 0 && Date.now() < deadline && !res.writableEnded && !revoked && !aborted) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
        wake = () => { clearTimeout(t); resolve(); };
      });
      wake = null;
      if (revoked || aborted) break;
      changed = await changedFolders();
    }
  } finally {
    unregister();
  }

  if (res.writableEnded || aborted) return;

  if (revoked) {
    res.removeHeader('Content-Type');
    res.setHeader('WWW-Authenticate', 'Basic realm="CoreMail ActiveSync"');
    res.status(401).send('Unauthorized');
    return;
  }

  if (changed.length > 0) {
    send(res, [el('Status', PING_STATUS.CHANGES), el('Folders', undefined, changed.map((fid) => el('Folder', fid)))]);
  } else {
    send(res, [el('Status', PING_STATUS.EXPIRED)]);
  }
}
