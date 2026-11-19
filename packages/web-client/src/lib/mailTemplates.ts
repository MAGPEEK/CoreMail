/**
 * Personal mail templates ("Vorlagen", 10.1): the API shapes of
 * /api/v1/mail/templates and the rules for using a template — a new mail from a
 * template, inserting one into an open draft, saving a draft as a template.
 * Pure — unit-tested with `node --test`. The HTML a template carries is
 * untrusted: callers sanitise it (lib/mailHtml.ts) before it reaches the
 * editor or the screen.
 */

export const TEMPLATES_QUERY_KEY = ['mail-templates'] as const;
export const templateQueryKey = (id: string) => ['mail-templates', id] as const;

/** Server limits (api-gateway lib/mail-templates.ts). */
export const MAX_TEMPLATE_NAME = 100;
export const MAX_TEMPLATE_BODY_BYTES = 256 * 1024;

export interface TemplateSummary { id: string; name: string; subject: string; preview: string; updatedAt: string }
export interface TemplateList { templates: TemplateSummary[]; max: number }

export interface MailTemplate {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  to: string[];
  cc: string[];
  bcc: string[];
  updatedAt: string;
}

/** Body of POST / PUT. */
export interface TemplateInput {
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  to: string[];
  cc: string[];
  bcc: string[];
}

export const EMPTY_TEMPLATE_INPUT: TemplateInput = Object.freeze({
  name: '', subject: '', bodyHtml: '', bodyText: '', to: [], cc: [], bcc: [],
}) as TemplateInput;

/** Templates whose name, subject or preview contain every word of `query` (case-insensitive). */
export function filterTemplates(list: readonly TemplateSummary[], query: string): TemplateSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  return list.filter((t) => {
    const hay = `${t.name}\n${t.subject}\n${t.preview}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The entry that stays selected after the list changed: the same one if still shown, else the first. */
export function keepSelection(list: readonly TemplateSummary[], selected: string | null): string | null {
  if (selected && list.some((t) => t.id === selected)) return selected;
  return list[0]?.id ?? null;
}

/** Keyboard in the template list: ↑ / ↓ one step (wrapping), Home / End; null = the key does nothing. */
export function stepSelection(list: readonly TemplateSummary[], selected: string | null, key: string): string | null {
  if (list.length === 0) return null;
  const i = list.findIndex((t) => t.id === selected);
  const last = list.length - 1;
  const next = key === 'ArrowDown' ? (i < 0 ? 0 : (i + 1) % list.length)
    : key === 'ArrowUp' ? (i <= 0 ? last : i - 1)
      : key === 'Home' ? 0
        : key === 'End' ? last
          : null;
  return next === null ? null : list[next]!.id;
}

export type TemplateNameProblem = 'empty' | 'tooLong' | null;

export function templateNameProblem(name: string): TemplateNameProblem {
  const n = name.trim();
  if (!n) return 'empty';
  return n.length > MAX_TEMPLATE_NAME ? 'tooLong' : null;
}

/** The body is above the server's cap (UTF-8 bytes). */
export function templateBodyTooLarge(html: string, text: string): boolean {
  const enc = new TextEncoder();
  return enc.encode(html).length > MAX_TEMPLATE_BODY_BYTES || enc.encode(text).length > MAX_TEMPLATE_BODY_BYTES;
}

/**
 * A new mail from a template ("Verwenden"): compose-context fields. `safeBodyHtml`
 * is the template body after sanitising; it goes in front of the signature.
 */
export function composeFromTemplate(t: MailTemplate, safeBodyHtml: string): {
  mode: 'new'; subject: string; toAddrs: string[]; ccAddrs: string[]; template: { bodyHtml: string; bcc: string[] };
} {
  return {
    mode: 'new',
    subject: t.subject,
    toAddrs: [...t.to],
    ccAddrs: [...t.cc],
    template: { bodyHtml: safeBodyHtml, bcc: [...t.bcc] },
  };
}

/** What an open draft holds when a template is inserted. */
export interface DraftFields {
  subject: string;
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
}

/** Changes of "Vorlage einfügen": absent = the field stays as it is. */
export interface TemplateInsertPlan {
  subject?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
}

/**
 * "Vorlage einfügen": the body goes in at the cursor (the caller does that);
 * the subject and each recipient field are filled only while they are empty —
 * nothing the user already wrote is replaced.
 */
export function templateInsertPlan(draft: DraftFields, t: Pick<MailTemplate, 'subject' | 'to' | 'cc' | 'bcc'>): TemplateInsertPlan {
  return {
    ...(!draft.subject.trim() && t.subject ? { subject: t.subject } : {}),
    ...(draft.to.length === 0 && t.to.length ? { to: [...t.to] } : {}),
    ...(draft.cc.length === 0 && t.cc.length ? { cc: [...t.cc] } : {}),
    ...(draft.bcc.length === 0 && t.bcc.length ? { bcc: [...t.bcc] } : {}),
  };
}

/** "Als Vorlage speichern": the draft's fields as a template (the body without signature / quote, already sanitised). */
export function templateFromDraft(name: string, draft: DraftFields, body: { html: string; text: string }): TemplateInput {
  return {
    name: name.trim(),
    subject: draft.subject,
    bodyHtml: body.html,
    bodyText: body.text,
    to: [...draft.to],
    cc: [...draft.cc],
    bcc: [...draft.bcc],
  };
}

/** Editor form → request body (name trimmed). */
export function templateInputOf(t: TemplateInput): TemplateInput {
  return { ...t, name: t.name.trim(), to: [...t.to], cc: [...t.cc], bcc: [...t.bcc] };
}

/** The editor form shows unsaved changes. */
export function templateChanged(saved: TemplateInput, current: TemplateInput): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  return saved.name.trim() !== current.name.trim() || saved.subject !== current.subject || saved.bodyHtml !== current.bodyHtml
    || !same(saved.to, current.to) || !same(saved.cc, current.cc) || !same(saved.bcc, current.bcc);
}
