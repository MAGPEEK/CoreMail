import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const notesRouter: RouterType = Router();
notesRouter.use(requireAuth);

const NoteSchema = z.object({
  subject: z.string().min(1),
  body: z.string().optional().default(''),
  color: z.string().optional().default('YELLOW'),
});

// GET /api/v1/notes
notesRouter.get('/', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim();

  const where: Record<string, unknown> = { userId: req.apiUser!.userId };
  if (q.length >= 2) {
    where['OR'] = [
      { subject: { contains: q, mode: 'insensitive' } },
      { body: { contains: q, mode: 'insensitive' } },
    ];
  }

  const notes = await prisma.note.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    select: { id: true, subject: true, color: true, updatedAt: true },
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
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

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

  const note = await prisma.note.findFirst({ where: { id, userId: req.apiUser!.userId } });
  if (!note) { res.status(404).json({ error: 'Note not found' }); return; }

  const updated = await prisma.note.update({
    where: { id },
    data: {
      ...(parsed.data.subject !== undefined ? { subject: parsed.data.subject } : {}),
      ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
      ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
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
