/**
 * Personal mail templates ("Vorlagen", 10.1) — validation and storage of the
 * caller's own MailTemplate rows (routes/mail-templates.ts).
 *
 * Every query is scoped to the owner (`{ id, userId }`): another user's id
 * behaves exactly like an unknown id. The body is untrusted HTML: the webmail
 * sanitises it with its mail sanitiser before saving and again on every
 * display / insert, like every other mail body; the server only bounds sizes.
 */
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { recipientAddress } from './send-limits.js';

export const MAX_TEMPLATES = 200;
/** Body cap (HTML and text each), in UTF-8 bytes. */
export const MAX_TEMPLATE_BODY_BYTES = 256 * 1024;
export const MAX_TEMPLATE_NAME = 100;
export const MAX_TEMPLATE_SUBJECT = 998;
export const MAX_TEMPLATE_RECIPIENTS = 100;
/** Characters of the body text shown in the list. */
export const PREVIEW_CHARS = 140;

const withinBytes = (s: string) => Buffer.byteLength(s, 'utf8') <= MAX_TEMPLATE_BODY_BYTES;
const body = z.string().refine(withinBytes, { message: `Höchstens ${MAX_TEMPLATE_BODY_BYTES / 1024} KB` });
const recipients = z.array(z.string().max(320)).max(MAX_TEMPLATE_RECIPIENTS)
  .refine((list) => list.every((r) => recipientAddress(r) !== null), { message: 'Ungültige Empfängeradresse' });

const fields = {
  name: z.string().trim().min(1).max(MAX_TEMPLATE_NAME),
  subject: z.string().max(MAX_TEMPLATE_SUBJECT).refine((s) => !/[\r\n\0]/.test(s), { message: 'Ungültiger Betreff' }),
  bodyHtml: body,
  bodyText: body,
  to: recipients,
  cc: recipients,
  bcc: recipients,
};

/** POST body: a name is required, everything else defaults to empty. */
export const TemplateCreateSchema = z.object({
  name: fields.name,
  subject: fields.subject.default(''),
  bodyHtml: fields.bodyHtml.default(''),
  bodyText: fields.bodyText.default(''),
  to: fields.to.default([]),
  cc: fields.cc.default([]),
  bcc: fields.bcc.default([]),
}).strict();

/** PUT body: the given fields replace the stored ones. */
export const TemplateUpdateSchema = z.object({
  name: fields.name.optional(),
  subject: fields.subject.optional(),
  bodyHtml: fields.bodyHtml.optional(),
  bodyText: fields.bodyText.optional(),
  to: fields.to.optional(),
  cc: fields.cc.optional(),
  bcc: fields.bcc.optional(),
}).strict();

export type TemplateCreate = z.infer<typeof TemplateCreateSchema>;
export type TemplateUpdate = z.infer<typeof TemplateUpdateSchema>;

export interface TemplateSummary { id: string; name: string; subject: string; preview: string; updatedAt: Date }
export interface TemplateDetail {
  id: string; name: string; subject: string; bodyHtml: string; bodyText: string;
  to: string[]; cc: string[]; bcc: string[]; createdAt: Date; updatedAt: Date;
}

interface TemplateRow {
  id: string; name: string; subject: string; bodyHtml: string; bodyText: string;
  toAddrs: string[]; ccAddrs: string[]; bccAddrs: string[]; createdAt: Date; updatedAt: Date;
}

const DETAIL_SELECT = {
  id: true, name: true, subject: true, bodyHtml: true, bodyText: true,
  toAddrs: true, ccAddrs: true, bccAddrs: true, createdAt: true, updatedAt: true,
} as const;

/** One line of the body text for the list (pure). */
export function previewOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

/** API shape of a stored row (pure). */
export function toDetail(r: TemplateRow): TemplateDetail {
  return {
    id: r.id, name: r.name, subject: r.subject, bodyHtml: r.bodyHtml, bodyText: r.bodyText,
    to: r.toAddrs, cc: r.ccAddrs, bcc: r.bccAddrs, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

/** Column values of a create / update body (pure; only the given fields). */
export function toColumns(d: TemplateUpdate): Record<string, string | string[]> {
  return {
    ...(d.name !== undefined ? { name: d.name } : {}),
    ...(d.subject !== undefined ? { subject: d.subject } : {}),
    ...(d.bodyHtml !== undefined ? { bodyHtml: d.bodyHtml } : {}),
    ...(d.bodyText !== undefined ? { bodyText: d.bodyText } : {}),
    ...(d.to !== undefined ? { toAddrs: d.to } : {}),
    ...(d.cc !== undefined ? { ccAddrs: d.cc } : {}),
    ...(d.bcc !== undefined ? { bccAddrs: d.bcc } : {}),
  };
}

export async function listTemplates(userId: string): Promise<TemplateSummary[]> {
  const rows = await prisma.mailTemplate.findMany({
    where: { userId },
    select: { id: true, name: true, subject: true, bodyText: true, updatedAt: true },
    orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => ({ id: r.id, name: r.name, subject: r.subject, preview: previewOf(r.bodyText), updatedAt: r.updatedAt }));
}

export async function getTemplate(userId: string, id: string): Promise<TemplateDetail | null> {
  const row = await prisma.mailTemplate.findFirst({ where: { id, userId }, select: DETAIL_SELECT });
  return row ? toDetail(row) : null;
}

export function countTemplates(userId: string): Promise<number> {
  return prisma.mailTemplate.count({ where: { userId } });
}

export async function createTemplate(userId: string, d: TemplateCreate): Promise<TemplateDetail> {
  const row = await prisma.mailTemplate.create({
    data: {
      userId, name: d.name, subject: d.subject, bodyHtml: d.bodyHtml, bodyText: d.bodyText,
      toAddrs: d.to, ccAddrs: d.cc, bccAddrs: d.bcc,
    },
    select: DETAIL_SELECT,
  });
  return toDetail(row);
}

/** null = no own template with this id. */
export async function updateTemplate(userId: string, id: string, d: TemplateUpdate): Promise<TemplateDetail | null> {
  const { count } = await prisma.mailTemplate.updateMany({ where: { id, userId }, data: toColumns(d) });
  return count === 0 ? null : getTemplate(userId, id);
}

/** false = no own template with this id. */
export async function deleteTemplate(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.mailTemplate.deleteMany({ where: { id, userId } });
  return count > 0;
}
