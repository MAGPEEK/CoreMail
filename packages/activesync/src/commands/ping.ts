import { prisma } from '@coremail/storage/prisma';
import { encodeWbxml, el, getText, getChild, type WbxmlElement } from '../wbxml.js';
import type { Response } from 'express';
import { easLiveRequests, type EasCredentialInfo } from '../live-sessions.js';

const DEFAULT_HEARTBEAT = 540; // 9 minutes
const MAX_HEARTBEAT = 3540;    // 59 minutes

/**
 * Ping command — long-poll push notification
 * Holds the connection open until a change is detected or heartbeat expires.
 * v7.1.0: ends early with HTTP 401 when the request's credentials become invalid
 * (MS-ASHTTP — the device asks for new credentials; Ping has no status for it).
 */
export async function handlePing(
  body: WbxmlElement,
  userId: string,
  res: Response,
  auth: EasCredentialInfo = {},
  pollIntervalMs = 10_000,
): Promise<void> {
  const heartbeatStr = getText(body, 'HeartbeatInterval');
  const heartbeat = Math.min(
    parseInt(heartbeatStr || String(DEFAULT_HEARTBEAT), 10),
    MAX_HEARTBEAT,
  );

  const folders = getChild(body, 'Folders');
  const folderIds: string[] = [];

  if (folders) {
    for (const child of folders.children ?? []) {
      if (typeof child === 'string' || child.name !== 'Folder') continue;
      const id = getText(child, 'Id');
      if (id) folderIds.push(id);
    }
  }

  // Verify folders belong to user
  const validFolders = folderIds.length > 0
    ? await prisma.folder.findMany({
        where: { id: { in: folderIds }, mailbox: { userId } },
        select: { id: true },
      })
    : [];

  const validFolderIds = new Set(validFolders.map((f) => f.id));

  // Get baseline message counts per folder
  const baseline: Record<string, number> = {};
  for (const fid of validFolderIds) {
    baseline[fid] = await prisma.message.count({ where: { folderId: fid, deletedAt: null } });
  }

  const deadline = Date.now() + heartbeat * 1000;
  const POLL_INTERVAL = pollIntervalMs; // check every 10 seconds

  // v7.1.0: credential change → wake up and answer 401.
  let revoked = false;
  let wake: (() => void) | null = null;
  const unregister = easLiveRequests.register({
    userId,
    credential: auth.credential ?? 'unknown',
    ...(auth.appPasswordId ? { appPasswordId: auth.appPasswordId } : {}),
    terminate: () => { revoked = true; wake?.(); },
  }, auth.authStartedAt);
  res.once('close', unregister);

  // Keep connection alive — poll for changes
  let changed = false;
  const changedFolderIds: string[] = [];

  try {
    while (Date.now() < deadline && !res.writableEnded && !revoked) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(POLL_INTERVAL, Math.max(0, deadline - Date.now())));
        wake = () => { clearTimeout(t); resolve(); };
      });
      wake = null;
      if (revoked) break;

      for (const fid of validFolderIds) {
        const count = await prisma.message.count({ where: { folderId: fid, deletedAt: null } });
        if (count !== baseline[fid]) {
          changed = true;
          changedFolderIds.push(fid);
          baseline[fid] = count;
        }
      }

      if (changed) break;
    }
  } finally {
    unregister();
  }

  if (res.writableEnded) return;

  if (revoked) {
    res.removeHeader('Content-Type');
    res.setHeader('WWW-Authenticate', 'Basic realm="CoreMail ActiveSync"');
    res.status(401).send('Unauthorized');
    return;
  }

  if (changed) {
    // Status 2: changes found
    const folderElements = changedFolderIds.map((fid) =>
      el('Folder', undefined, [
        el('Id', fid),
        el('Class', 'Email'),
      ])
    );
    const response = encodeWbxml(el('Ping', undefined, [
      el('Status', '2'),
      el('Folders', undefined, folderElements),
    ]));
    res.set('Content-Type', 'application/vnd.ms-sync.wbxml');
    res.set('MS-Server-ActiveSync', '14.1');
    res.status(200).send(response);
  } else {
    // Status 1: heartbeat expired, no changes
    const response = encodeWbxml(el('Ping', undefined, [el('Status', '1')]));
    res.set('Content-Type', 'application/vnd.ms-sync.wbxml');
    res.set('MS-Server-ActiveSync', '14.1');
    res.status(200).send(response);
  }
}
