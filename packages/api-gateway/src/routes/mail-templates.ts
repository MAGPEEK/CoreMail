/**
 * Personal mail templates ("Vorlagen", 10.1) — mounted at /api/v1/mail/templates.
 *
 *   GET    /       → { templates: [{ id, name, subject, preview, updatedAt }], max }
 *   GET    /:id    → { id, name, subject, bodyHtml, bodyText, to, cc, bcc, createdAt, updatedAt }
 *   POST   /       { name, subject?, bodyHtml?, bodyText?, to?, cc?, bcc? } → 201 + the template
 *   PUT    /:id    { name?, subject?, bodyHtml?, bodyText?, to?, cc?, bcc? } → the template
 *   DELETE /:id    → { ok: true }
 *
 * Own templates only: another user's id answers 404 like an unknown one.
 * Validation errors → 400 (`details` = the failing fields), more than
 * MAX_TEMPLATES → 409 TEMPLATE_LIMIT. No attachments. requireAuth applies the
 * Webmail protocol switch like the drafts API; templates have no own webmail
 * module. Every write reaches the user's other tabs and devices as a
 * `settings` event with section `templates`.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import type { ZodError } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { announceOnWrite } from '../lib/realtime.js';
import {
  MAX_TEMPLATES, TemplateCreateSchema, TemplateUpdateSchema, countTemplates, createTemplate, deleteTemplate,
  getTemplate, listTemplates, updateTemplate,
} from '../lib/mail-templates.js';

export const mailTemplatesRouter: RouterType = Router();
mailTemplatesRouter.use(requireAuth);
mailTemplatesRouter.use(announceOnWrite({ type: 'settings', section: 'templates' }));

const NOT_FOUND = { error: 'Vorlage nicht gefunden', code: 'TEMPLATE_NOT_FOUND' } as const;

function invalid(res: Response, err: ZodError): void {
  res.status(400).json({
    error: 'Ungültige Vorlage',
    code: 'TEMPLATE_INVALID',
    details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
  });
}

mailTemplatesRouter.get('/', async (req: Request, res: Response) => {
  res.json({ templates: await listTemplates(req.apiUser!.userId), max: MAX_TEMPLATES });
});

mailTemplatesRouter.get('/:id', async (req: Request, res: Response) => {
  const found = await getTemplate(req.apiUser!.userId, String(req.params['id']));
  if (!found) { res.status(404).json(NOT_FOUND); return; }
  res.json(found);
});

mailTemplatesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = TemplateCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) { invalid(res, parsed.error); return; }
  const userId = req.apiUser!.userId;
  if (await countTemplates(userId) >= MAX_TEMPLATES) {
    res.status(409).json({ error: `Höchstens ${MAX_TEMPLATES} Vorlagen`, code: 'TEMPLATE_LIMIT' });
    return;
  }
  res.status(201).json(await createTemplate(userId, parsed.data));
});

mailTemplatesRouter.put('/:id', async (req: Request, res: Response) => {
  const parsed = TemplateUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) { invalid(res, parsed.error); return; }
  const updated = await updateTemplate(req.apiUser!.userId, String(req.params['id']), parsed.data);
  if (!updated) { res.status(404).json(NOT_FOUND); return; }
  res.json(updated);
});

mailTemplatesRouter.delete('/:id', async (req: Request, res: Response) => {
  if (!(await deleteTemplate(req.apiUser!.userId, String(req.params['id'])))) { res.status(404).json(NOT_FOUND); return; }
  res.json({ ok: true });
});
