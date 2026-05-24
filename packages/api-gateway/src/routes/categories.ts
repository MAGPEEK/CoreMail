import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const categoriesRouter: RouterType = Router();
categoriesRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

const CreateCategorySchema = z.object({
  name: z.string().min(1).max(60),
  color: z.string().regex(HEX_RE, 'Farbe muss ein Hex-Code sein, z. B. #3B82F6').optional(),
  isFavorite: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const PatchCategorySchema = z.object({
  name: z.string().min(1).max(60).optional(),
  color: z.string().regex(HEX_RE).optional(),
  isFavorite: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const AssignSchema = z.object({
  categoryIds: z.array(z.string()).max(50),
});

// ── GET /api/v1/categories ────────────────────────────────────────────────────
categoriesRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const list = await prisma.category.findMany({
    where: { userId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json(list);
});

// ── POST /api/v1/categories ───────────────────────────────────────────────────
categoriesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = CreateCategorySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }); return; }
  const userId = req.apiUser!.userId;

  const exists = await prisma.category.findFirst({ where: { userId, name: parsed.data.name } });
  if (exists) { res.status(409).json({ error: 'Kategorie existiert bereits' }); return; }

  const cat = await prisma.category.create({
    data: {
      userId,
      name: parsed.data.name,
      ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
      ...(parsed.data.isFavorite !== undefined ? { isFavorite: parsed.data.isFavorite } : {}),
      ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
    },
  });
  res.json(cat);
});

// ── PATCH /api/v1/categories/:id ──────────────────────────────────────────────
categoriesRouter.patch('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = PatchCategorySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }); return; }
  const userId = req.apiUser!.userId;

  const cat = await prisma.category.findFirst({ where: { id, userId } });
  if (!cat) { res.status(404).json({ error: 'Kategorie nicht gefunden' }); return; }

  if (parsed.data.name && parsed.data.name !== cat.name) {
    const collision = await prisma.category.findFirst({
      where: { userId, name: parsed.data.name, id: { not: id } },
    });
    if (collision) { res.status(409).json({ error: 'Name bereits vergeben' }); return; }
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined)       updates['name'] = parsed.data.name;
  if (parsed.data.color !== undefined)      updates['color'] = parsed.data.color;
  if (parsed.data.isFavorite !== undefined) updates['isFavorite'] = parsed.data.isFavorite;
  if (parsed.data.sortOrder !== undefined)  updates['sortOrder'] = parsed.data.sortOrder;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await prisma.category.update({ where: { id }, data: updates as any });
  res.json(updated);
});

// ── DELETE /api/v1/categories/:id ─────────────────────────────────────────────
categoriesRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const userId = req.apiUser!.userId;
  const cat = await prisma.category.findFirst({ where: { id, userId } });
  if (!cat) { res.status(404).json({ error: 'Kategorie nicht gefunden' }); return; }
  await prisma.category.delete({ where: { id } });
  res.json({ ok: true });
});

// ── POST /api/v1/categories/messages/:messageId — Set Kategorien einer Mail ──
categoriesRouter.post('/messages/:messageId', async (req: Request, res: Response) => {
  const { messageId } = req.params as { messageId: string };
  const parsed = AssignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const userId = req.apiUser!.userId;

  const msg = await prisma.message.findFirst({
    where: { id: messageId, folder: { mailbox: { userId } } },
  });
  if (!msg) { res.status(404).json({ error: 'Nachricht nicht gefunden' }); return; }

  // Nur Kategorien des Users zulassen
  const owned = await prisma.category.findMany({
    where: { id: { in: parsed.data.categoryIds }, userId },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((c) => c.id));
  const validIds = parsed.data.categoryIds.filter((id) => ownedIds.has(id));

  await prisma.$transaction([
    prisma.messageCategory.deleteMany({ where: { messageId } }),
    ...(validIds.length
      ? [prisma.messageCategory.createMany({
          data: validIds.map((categoryId) => ({ messageId, categoryId })),
        })]
      : []),
  ]);

  res.json({ ok: true, count: validIds.length });
});

// ── POST /api/v1/categories/messages/bulk — Bulk-Set ─────────────────────────
const BulkAssignSchema = z.object({
  messageIds: z.array(z.string()).min(1).max(500),
  /** Aktion: 'add' fügt hinzu, 'remove' entfernt, 'set' überschreibt */
  action: z.enum(['add', 'remove', 'set']),
  categoryIds: z.array(z.string()).min(1).max(50),
});

categoriesRouter.post('/messages/bulk', async (req: Request, res: Response) => {
  const parsed = BulkAssignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const userId = req.apiUser!.userId;
  const { messageIds, action, categoryIds } = parsed.data;

  const messages = await prisma.message.findMany({
    where: { id: { in: messageIds }, folder: { mailbox: { userId } } },
    select: { id: true },
  });
  const ownedMsgIds = messages.map((m) => m.id);

  const cats = await prisma.category.findMany({
    where: { id: { in: categoryIds }, userId },
    select: { id: true },
  });
  const ownedCatIds = cats.map((c) => c.id);
  if (!ownedMsgIds.length || !ownedCatIds.length) {
    res.json({ ok: true, affected: 0 });
    return;
  }

  if (action === 'set' || action === 'remove') {
    await prisma.messageCategory.deleteMany({
      where: { messageId: { in: ownedMsgIds }, ...(action === 'remove' ? { categoryId: { in: ownedCatIds } } : {}) },
    });
  }
  if (action === 'set' || action === 'add') {
    const rows = ownedMsgIds.flatMap((mid) => ownedCatIds.map((cid) => ({ messageId: mid, categoryId: cid })));
    await prisma.messageCategory.createMany({ data: rows, skipDuplicates: true });
  }

  res.json({ ok: true, affected: ownedMsgIds.length });
});
