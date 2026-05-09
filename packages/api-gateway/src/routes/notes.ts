import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPrisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const notesRouter = Router();
notesRouter.use(requireAuth);

const NoteSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional().default(''),
  color: z.string().optional().default('#FFE599'),
  category: z.string().optional().default(''),
});

// GET /api/v1/notes
notesRouter.get('/', async (req: Request, res: Response) => {
  const category = req.query['category'] as string | undefined;
  const q = String(req.query['q'] ?? '').trim();
  const prisma = getPrisma();

  const where: Record<string, unknown> = { userId: req.apiUser!.userId };
  if (category) where['category'] = category;
  if (q.length >= 2) {
    where['OR'] = [
      { title: { contains: q, mode: 'insensitive' } },
      { body: { contains: q, mode: 'insensitive' } },
    ];
  }

  const notes = await prisma.note.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    select: { id: true, title: true, color: true, category: true, updatedAt: true },
  });
  res.json(notes);
});

// GET /api/v1/notes/:id
notesRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const prisma = getPrisma();
  const note = await prisma.note.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!note) { res.status(404).json({ error: 'Note not found' }); return; }
  res.json(note);
});

// POST /api/v1/notes
notesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = NoteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const prisma = getPrisma();
  const note = await prisma.note.create({
    data: { userId: req.apiUser!.userId, ...parsed.data },
  });
  res.status(201).json(note);
});

// PUT /api/v1/notes/:id
notesRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = NoteSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const prisma = getPrisma();
  const note = await prisma.note.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!note) { res.status(404).json({ error: 'Note not found' }); return; }

  const updated = await prisma.note.update({ where: { id }, data: parsed.data });
  res.json(updated);
});

// DELETE /api/v1/notes/:id
notesRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const prisma = getPrisma();
  const note = await prisma.note.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!note) { res.status(404).json({ error: 'Note not found' }); return; }
  await prisma.note.delete({ where: { id } });
  res.json({ ok: true });
});
