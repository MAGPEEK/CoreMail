/**
 * Admin API — email aliases
 *
 * Aliases are additional receiving addresses that belong to a primary mailbox
 * (user or shared mailbox). Incoming mails to the alias address are delivered
 * by the SMTP server into the target's mailbox.
 *
 * Routes:
 *   GET    /api/v1/admin/aliases                         — list all aliases
 *   GET    /api/v1/admin/mailboxes/:id/aliases           — user aliases
 *   POST   /api/v1/admin/mailboxes/:id/aliases           — create user alias
 *   GET    /api/v1/admin/shared-mailboxes/:id/aliases    — SharedMailbox aliases
 *   POST   /api/v1/admin/shared-mailboxes/:id/aliases    — create SharedMailbox alias
 *   PATCH  /api/v1/admin/aliases/:aliasId                — edit alias (active, description)
 *   DELETE /api/v1/admin/aliases/:aliasId                — delete alias
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

const log = createLogger('admin:aliases');
export const adminAliasesRouter: RouterType = Router();
adminAliasesRouter.use(requireAdmin);

const LOCAL_PART_RE = /^[a-z0-9._+-]+$/;

const CreateBody = z.object({
  // Either a full email address OR localPart + domainId
  address:   z.string().email().optional(),
  localPart: z.string().min(1).max(64).optional(),
  domainId:  z.string().optional(),
  description: z.string().max(200).default(''),
  active:    z.boolean().default(true),
});

/**
 * Helper — builds the final alias address from input.
 * If `address` is set: the domain is extracted from the email and validated against the DB.
 * Otherwise `localPart + domainId` must be set and the domain must exist in the DB.
 */
async function resolveAliasInput(input: z.infer<typeof CreateBody>): Promise<
  { ok: true; address: string; localPart: string; domainId: string }
  | { ok: false; error: string }
> {
  if (input.address) {
    const at = input.address.lastIndexOf('@');
    if (at < 1) return { ok: false, error: 'Ungültige E-Mail-Adresse' };
    const localPart = input.address.slice(0, at).toLowerCase();
    const domainName = input.address.slice(at + 1).toLowerCase();
    if (!LOCAL_PART_RE.test(localPart) || localPart.startsWith('.') || localPart.endsWith('.')) {
      return { ok: false, error: 'Ungültiger Local-Part — erlaubt: a-z 0-9 . _ + -' };
    }
    const domain = await prisma.domain.findUnique({ where: { name: domainName }, select: { id: true } });
    if (!domain) return { ok: false, error: `Domain "${domainName}" ist nicht im System konfiguriert` };
    return { ok: true, address: `${localPart}@${domainName}`, localPart, domainId: domain.id };
  }
  if (!input.localPart || !input.domainId) {
    return { ok: false, error: 'Entweder `address` oder `localPart`+`domainId` muss gesetzt sein' };
  }
  const localPart = input.localPart.toLowerCase();
  if (!LOCAL_PART_RE.test(localPart) || localPart.startsWith('.') || localPart.endsWith('.')) {
    return { ok: false, error: 'Ungültiger Local-Part — erlaubt: a-z 0-9 . _ + -' };
  }
  const domain = await prisma.domain.findUnique({ where: { id: input.domainId }, select: { id: true, name: true } });
  if (!domain) return { ok: false, error: 'Unbekannte Domain' };
  return { ok: true, address: `${localPart}@${domain.name}`, localPart, domainId: domain.id };
}

/**
 * Checks for collisions: an alias must not collide with an existing user/SharedMailbox/alias
 * address. Returns null if free, otherwise an error string.
 */
async function checkAddressCollision(address: string, excludeAliasId?: string): Promise<string | null> {
  const lower = address.toLowerCase();
  const [user, shared, alias] = await Promise.all([
    prisma.user.findUnique({ where: { email: lower }, select: { id: true } }),
    prisma.sharedMailbox.findUnique({ where: { email: lower }, select: { id: true } }),
    prisma.emailAlias.findUnique({ where: { address: lower }, select: { id: true } }),
  ]);
  if (user)   return `Adresse ist bereits Haupt-Adresse eines Users`;
  if (shared) return `Adresse ist bereits Haupt-Adresse einer Shared Mailbox`;
  if (alias && alias.id !== excludeAliasId) return 'Adresse ist bereits als Alias vergeben';
  return null;
}

const ALIAS_SELECT = {
  id: true, address: true, localPart: true, description: true, active: true,
  domainId: true, targetUserId: true, targetSharedId: true,
  createdAt: true, updatedAt: true,
  domain:       { select: { id: true, name: true } },
  targetUser:   { select: { id: true, email: true, displayName: true } },
  targetShared: { select: { id: true, email: true, displayName: true } },
} as const;

// ── GET /admin/aliases — all ─────────────────────────────────────────────────

adminAliasesRouter.get('/aliases', async (_req: Request, res: Response) => {
  const aliases = await prisma.emailAlias.findMany({
    select: ALIAS_SELECT,
    orderBy: { address: 'asc' },
  });
  res.json(aliases);
});

// ── User aliases ─────────────────────────────────────────────────────────────

adminAliasesRouter.get('/mailboxes/:id/aliases', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const aliases = await prisma.emailAlias.findMany({
    where: { targetUserId: id },
    select: ALIAS_SELECT,
    orderBy: { address: 'asc' },
  });
  res.json(aliases);
});

adminAliasesRouter.post('/mailboxes/:id/aliases', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const p = CreateBody.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }

  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, domainId: true } });
  if (!user) { res.status(404).json({ error: 'User nicht gefunden' }); return; }

  // Default domain = the user's (for localPart-only mode)
  const input = { ...p.data, domainId: p.data.domainId ?? user.domainId };
  const resolved = await resolveAliasInput(input);
  if (!resolved.ok) { res.status(400).json({ error: resolved.error }); return; }

  const collision = await checkAddressCollision(resolved.address);
  if (collision) { res.status(409).json({ error: collision }); return; }

  const alias = await prisma.emailAlias.create({
    data: {
      address:      resolved.address,
      localPart:    resolved.localPart,
      domainId:     resolved.domainId,
      targetUserId: user.id,
      description:  p.data.description,
      active:       p.data.active,
    },
    select: ALIAS_SELECT,
  });
  log.info({ aliasId: alias.id, address: alias.address, target: 'user:' + user.id }, 'User alias created');
  res.status(201).json(alias);
});

// ── SharedMailbox aliases ────────────────────────────────────────────────────

adminAliasesRouter.get('/shared-mailboxes/:id/aliases', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const aliases = await prisma.emailAlias.findMany({
    where: { targetSharedId: id },
    select: ALIAS_SELECT,
    orderBy: { address: 'asc' },
  });
  res.json(aliases);
});

adminAliasesRouter.post('/shared-mailboxes/:id/aliases', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const p = CreateBody.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }

  const sm = await prisma.sharedMailbox.findUnique({ where: { id }, select: { id: true, domainId: true } });
  if (!sm) { res.status(404).json({ error: 'Shared Mailbox nicht gefunden' }); return; }

  const input = { ...p.data, domainId: p.data.domainId ?? sm.domainId };
  const resolved = await resolveAliasInput(input);
  if (!resolved.ok) { res.status(400).json({ error: resolved.error }); return; }

  const collision = await checkAddressCollision(resolved.address);
  if (collision) { res.status(409).json({ error: collision }); return; }

  const alias = await prisma.emailAlias.create({
    data: {
      address:        resolved.address,
      localPart:      resolved.localPart,
      domainId:       resolved.domainId,
      targetSharedId: sm.id,
      description:    p.data.description,
      active:         p.data.active,
    },
    select: ALIAS_SELECT,
  });
  log.info({ aliasId: alias.id, address: alias.address, target: 'shared:' + sm.id }, 'SharedMailbox alias created');
  res.status(201).json(alias);
});

// ── PATCH /admin/aliases/:aliasId ────────────────────────────────────────────

const PatchBody = z.object({
  description: z.string().max(200).optional(),
  active:      z.boolean().optional(),
});

adminAliasesRouter.patch('/aliases/:aliasId', async (req: Request, res: Response) => {
  const { aliasId } = req.params as { aliasId: string };
  const p = PatchBody.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }

  const existing = await prisma.emailAlias.findUnique({ where: { id: aliasId } });
  if (!existing) { res.status(404).json({ error: 'Alias not found' }); return; }

  const updated = await prisma.emailAlias.update({
    where: { id: aliasId },
    data: {
      ...(p.data.description !== undefined ? { description: p.data.description } : {}),
      ...(p.data.active      !== undefined ? { active:      p.data.active      } : {}),
    },
    select: ALIAS_SELECT,
  });
  res.json(updated);
});

// ── DELETE /admin/aliases/:aliasId ───────────────────────────────────────────

adminAliasesRouter.delete('/aliases/:aliasId', async (req: Request, res: Response) => {
  const { aliasId } = req.params as { aliasId: string };
  const existing = await prisma.emailAlias.findUnique({ where: { id: aliasId } });
  if (!existing) { res.status(404).json({ error: 'Alias not found' }); return; }
  await prisma.emailAlias.delete({ where: { id: aliasId } });
  log.info({ aliasId, address: existing.address }, 'Alias deleted');
  res.status(204).end();
});
