/**
 * w3: permissions of the caller's own folders (webmail folder context menu
 * "Berechtigungen…"):
 *
 *   GET /api/v1/mail/folders/:folderId/permissions
 *   PUT /api/v1/mail/folders/:folderId/permissions   {entries: [...]}
 *
 * Request/response contract: lib/folder-permissions-api.ts. A folder of
 * another mailbox → 404 (no oracle); foreign folders are administered through
 * the shared/delegated mailbox routes (routes/foreign-mailbox.ts) with the
 * "folder owner" right, or by administrators in the BCP.
 */
import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';
import { replaceFolderPermissions, sendFolderPermissions, type PermissionFolder } from '../lib/folder-permissions-api.js';

const auth = (req: Request, res: Response, next: NextFunction): void => requireAuth(req, res, next);

/** The caller's own folder, or null (+ 404). */
async function ownFolder(req: Request, res: Response): Promise<(PermissionFolder & { ownerId: string }) | null> {
  const folderId = String((req.params as { folderId?: string }).folderId ?? '');
  const userId = req.apiUser!.userId;
  const folder = folderId
    ? await prisma.folder.findFirst({
      where: { id: folderId, mailbox: { userId } },
      select: { id: true, mailboxId: true, name: true, displayName: true },
    })
    : null;
  if (!folder) { res.status(404).json({ error: 'Ordner nicht gefunden' }); return null; }
  return { ...folder, ownerId: userId };
}

export const ownFolderPermissionsRouter: RouterType = Router();

ownFolderPermissionsRouter.get('/folders/:folderId/permissions', auth, async (req: Request, res: Response) => {
  const folder = await ownFolder(req, res);
  if (folder) await sendFolderPermissions(res, folder);
});

ownFolderPermissionsRouter.put('/folders/:folderId/permissions', auth, async (req: Request, res: Response) => {
  const folder = await ownFolder(req, res);
  if (folder) await replaceFolderPermissions(req, res, folder, folder.ownerId, 'webmail');
});
