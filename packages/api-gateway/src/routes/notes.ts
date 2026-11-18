import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { patchSchema } from '../lib/zod-compat.js';
import { prisma, normalizeCategories } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';
import { announceOnWrite } from '../lib/realtime.js';
import { categoryList, firstIssue } from '../lib/contact-input.js';

export const notesRouter: RouterType = Router();
notesRouter.use(requireAuth);
// 9.4: note writes reach the user's other tabs and devices
notesRouter.use(announceOnWrite({ type: 'notes' }));

/** Note colours the webmail offers (9.5: validated; stored values outside the list stay readable). */
export const NOTE_COLORS = ['YELLOW', 'BLUE', 'GREEN', 'PINK', 'PURPLE'] as const;

const NoteSchema = z.object({
  subject: z.string().min(1),
  body: z.string().optional().default(''),
  color: z.enum(NOTE_COLORS).optional().default('YELLOW'),
  // 9.5: category names (the user's category list, as for mail)
  categories: categoryList.optional().default([]),
});

const NOTE_LIST_SELECT = { id: true, subject: true, color: true, categories: true, updatedAt: true } as const;

// GET /api/v1/notes?q=&category=
notesRouter.get('/', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();
  const category = String(req.query['category'] ?? '').trim();

  const where: Record<string, unknown> = { userId: req.apiUser!.userId };
  if (q.length >= 2) {
    where['OR'] = [
      { subject: { contains: q, mode: 'insensitive' } },
      { body: { contains: q, mode: 'insensitive' } },
      { categories: { has: q } },
    ];
  }
  if (category) where['categories'] = { has: category };

  const notes = await prisma.note.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    select: NOTE_LIST_SELECT,
  });
  res.json(notes);
});

// GET /api/v1/notes/:id
notesRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const note = await prisma.note.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!note) { res.status(404).json({ error: 'Note not found' }); return; }
  res.json(note);
});

// POST /api/v1/notes
notesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = NoteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', ...firstIssue(parsed.error) }); return; }

  const note = await prisma.note.create({
    data: { userId: req.apiUser!.userId, ...parsed.data, categories: normalizeCategories(parsed.data.categories) },
  });
  res.status(201).json(note);
});

// PUT /api/v1/notes/:id
notesRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = patchSchema(NoteSchema).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', ...firstIssue(parsed.error) }); return; }

  const note = await prisma.note.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!note) { res.status(404).json({ error: 'Note not found' }); return; }

  const updated = await prisma.note.update({
    where: { id },
    data: {
      ...(parsed.data.subject !== undefined ? { subject: parsed.data.subject } : {}),
      ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
      ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
      ...(parsed.data.categories !== undefined ? { categories: normalizeCategories(parsed.data.categories) } : {}),
    },
  });
  res.json(updated);
});

// DELETE /api/v1/notes/:id
notesRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const note = await prisma.note.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!note) { res.status(404).json({ error: 'Note not found' }); return; }
  await prisma.note.delete({ where: { id } });
  res.json({ ok: true });
});
