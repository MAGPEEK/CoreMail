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

/** A known colour in its canonical spelling (case-insensitive), else null. */
export function canonicalNoteColor(value: string): string | null {
  const v = value.trim().toUpperCase();
  return (NOTE_COLORS as readonly string[]).includes(v) ? v : null;
}

/**
 * The colour to store, or null when it is refused. Known colours are accepted
 * in any case; a value the note already has (stored before 9.5, when any
 * string was accepted) is kept as it is, so saving such a note never fails.
 */
export function noteColorToStore(value: string, stored: string | null): string | null {
  if (stored !== null && value.trim() === stored) return stored;
  return canonicalNoteColor(value);
}

const NoteSchema = z.object({
  subject: z.string().min(1),
  body: z.string().optional().default(''),
  // Checked against the known colours in the handlers (noteColorToStore)
  color: z.string().max(40).optional().default('YELLOW'),
  // 9.5: category names (the user's category list, as for mail)
  categories: categoryList.optional().default([]),
});

const UNKNOWN_COLOR = { error: 'Invalid request', field: 'color', message: `Farbe: ${NOTE_COLORS.join(', ')}` } as const;

const NOTE_LIST_SELECT ={ id: true, subject: true, color: true, categories: true, updatedAt: true } as const;

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
  const color = noteColorToStore(parsed.data.color, null);
  if (!color) { res.status(400).json(UNKNOWN_COLOR); return; }

  const note = await prisma.note.create({
    data: { userId: req.apiUser!.userId, ...parsed.data, color, categories: normalizeCategories(parsed.data.categories) },
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
  const color = parsed.data.color !== undefined ? noteColorToStore(parsed.data.color, note.color) : undefined;
  if (color === null) { res.status(400).json(UNKNOWN_COLOR); return; }

  const updated = await prisma.note.update({
    where: { id },
    data: {
      ...(parsed.data.subject !== undefined ? { subject: parsed.data.subject } : {}),
      ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
      ...(color !== undefined ? { color } : {}),
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
