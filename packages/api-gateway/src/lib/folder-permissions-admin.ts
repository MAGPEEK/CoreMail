/**
 * w3: folder permissions of any mailbox for administrators (area recipients):
 *
 *   GET /api/v1/admin/mailboxes/:id/folder-permissions                 (id = user id)
 *   GET|PUT /api/v1/admin/mailboxes/:id/folders/:folderId/permissions
 *   GET /api/v1/admin/shared-mailboxes/:id/folder-permissions          (id = SharedMailbox id)
 *   GET|PUT /api/v1/admin/shared-mailboxes/:id/folders/:folderId/permissions
 *
 * The overview lists every folder with its own entries; the per-folder routes
 * share the contract of lib/folder-permissions-api.ts. Changes are audited by
 * storage (`mailbox.folder.permission.set|remove`, source `admin`). Like every
 * other change of an account, the mailboxes of admin accounts are
 * ORGANIZATION_MANAGEMENT-only.
 */
import type { Request, Response } from 'express';
import { prisma, listMailboxFolderPermissions, type FolderAccessDb } from '@coremail/storage';
import { replaceFolderPermissions, sendFolderPermissions, withFixedEntries } from './folder-permissions-api.js';
import { canManageAccount } from './rbac.js';

export type FolderPermissionTargetKind = 'user' | 'shared';

interface Target { mailboxId: string; ownerUserId: string | null; role: string | null }

async function loadTarget(kind: FolderPermissionTargetKind, id: string): Promise<Target | null> {
  if (!id) return null;
  if (kind === 'user') {
    const u = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, mailbox: { select: { id: true } } } });
    return u?.mailbox ? { mailboxId: u.mailbox.id, ownerUserId: u.id, role: u.role } : null;
  }
  const s = await prisma.sharedMailbox.findUnique({ where: { id }, select: { mailbox: { select: { id: true } } } });
  return s?.mailbox ? { mailboxId: s.mailbox.id, ownerUserId: null, role: null } : null;
}

const NOT_FOUND = { error: 'Postfach nicht gefunden' };

/** GET …/folder-permissions: every folder with its entries (Default / Anonymous first). */
export function listFolderPermissionsHandler(kind: FolderPermissionTargetKind) {
  return async (req: Request, res: Response): Promise<void> => {
    const target = await loadTarget(kind, String(req.params['id'] ?? ''));
    if (!target) { res.status(404).json(NOT_FOUND); return; }
    const folders = await listMailboxFolderPermissions(prisma as unknown as FolderAccessDb, target.mailboxId);
    res.json(folders.map((f) => ({ ...f, entries: withFixedEntries(f.entries) })));
  };
}

async function targetFolder(kind: FolderPermissionTargetKind, req: Request, res: Response) {
  const target = await loadTarget(kind, String(req.params['id'] ?? ''));
  if (!target) { res.status(404).json(NOT_FOUND); return null; }
  const folder = await prisma.folder.findFirst({
    where: { id: String(req.params['folderId'] ?? ''), mailboxId: target.mailboxId },
    select: { id: true, mailboxId: true, name: true, displayName: true },
  });
  if (!folder) { res.status(404).json({ error: 'Ordner nicht gefunden' }); return null; }
  return { target, folder };
}

export function getFolderPermissionsHandler(kind: FolderPermissionTargetKind) {
  return async (req: Request, res: Response): Promise<void> => {
    const hit = await targetFolder(kind, req, res);
    if (hit) await sendFolderPermissions(res, hit.folder);
  };
}

export function putFolderPermissionsHandler(kind: FolderPermissionTargetKind) {
  return async (req: Request, res: Response): Promise<void> => {
    const hit = await targetFolder(kind, req, res);
    if (!hit) return;
    // Same rule as other changes of an account: admin mailboxes are ORGANIZATION_MANAGEMENT-only.
    if (hit.target.role !== null && !canManageAccount(req.apiUser!.role, hit.target.role)) {
      res.status(403).json({ error: 'Nur die Organisationsverwaltung darf Admin-Postfächer ändern', code: 'FORBIDDEN' });
      return;
    }
    await replaceFolderPermissions(req, res, hit.folder, hit.target.ownerUserId, 'admin');
  };
}
