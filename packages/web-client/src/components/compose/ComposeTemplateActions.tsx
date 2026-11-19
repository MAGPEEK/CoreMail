/**
 * 10.1: mail templates inside the compose card ("…" menu).
 *  - "Vorlage einfügen …": the picker in insert mode; the template's body goes
 *    in at the cursor (sanitised), subject and recipient fields are filled only
 *    while they are empty (lib/mailTemplates.ts templateInsertPlan).
 *  - "Als Vorlage speichern …": asks for a name and saves subject, recipients
 *    and the body without signature block and quoted original (sanitised).
 */
import { useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import toast from 'react-hot-toast';
import { PromptDialog } from '../PromptDialog.js';
import { useTemplateDialogs } from '../templates/useTemplatePicker.js';
import { useTemplateWrites } from '../../hooks/useMailTemplates.js';
import {
  templateBodyTooLarge, templateFromDraft, templateInsertPlan, templateNameProblem, type DraftFields, type TemplateInsertPlan,
} from '../../lib/mailTemplates.js';
import { quoteMailHtml } from '../../lib/mailHtml.js';
import { QUOTE_ATTR, textToParagraphsHtml } from '../../lib/composeQuote.js';
import { SIGNATURE_BLOCK_ATTR } from '../../lib/signaturePick.js';
import { fmt, useT } from '../../i18n/useT.js';

const isEmptyLine = (el: Element | null): el is Element => !!el && el.tagName === 'P' && !el.textContent?.trim() && !el.querySelector('img');

/** The draft body as a template body: no signature block, no quoted original, no empty lines around it. */
function bodyForTemplate(html: string, plain: boolean): { html: string; text: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(`[${SIGNATURE_BLOCK_ATTR}], blockquote[${QUOTE_ATTR}]`).forEach((n) => n.remove());
  while (isEmptyLine(doc.body.lastElementChild)) doc.body.lastElementChild.remove();
  while (isEmptyLine(doc.body.firstElementChild)) doc.body.firstElementChild.remove();
  const text = Array.from(doc.body.children).map((el) => el.textContent ?? '').join('\n').trim();
  return { html: plain ? textToParagraphsHtml(text) : quoteMailHtml(doc.body.innerHTML), text };
}

export function useComposeTemplateActions(o: {
  editor: Editor | null;
  plainText: boolean;
  fields: () => DraftFields;
  apply: (plan: TemplateInsertPlan) => void;
}): { insertTemplate: () => void; saveAsTemplate: () => void; element: ReactNode } {
  const t = useT();
  const { create } = useTemplateWrites();
  const [naming, setNaming] = useState(false);

  const picker = useTemplateDialogs('insert', (tpl) => {
    const html = o.plainText || !tpl.bodyHtml ? textToParagraphsHtml(tpl.bodyText) : quoteMailHtml(tpl.bodyHtml);
    if ((o.plainText ? tpl.bodyText : html).trim()) o.editor?.chain().focus().insertContent(html).run();
    o.apply(templateInsertPlan(o.fields(), tpl));
    toast.success(t('compose_template_inserted'));
  });

  const save = async (name: string) => {
    const body = bodyForTemplate(o.editor?.getHTML() ?? '', o.plainText);
    if (templateBodyTooLarge(body.html, body.text)) throw new Error(t('tpl_body_large'));
    await create.mutateAsync(templateFromDraft(name, o.fields(), body));
    setNaming(false);
    toast.success(fmt(t('compose_template_saved'), { name: name.trim() }));
  };

  const element = (
    <>
      {picker.element}
      {naming && (
        <PromptDialog
          title={t('compose_template_save_title')}
          label={t('compose_template_name_label')}
          initialValue={o.fields().subject.slice(0, 100)}
          confirmText={t('tpl_save')}
          cancelText={t('cancel')}
          requiredText={t('tpl_name_empty')}
          validate={(v) => (templateNameProblem(v) === 'tooLong' ? t('tpl_name_long') : null)}
          onConfirm={save}
          onCancel={() => { setNaming(false); o.editor?.commands.focus(); }}
        />
      )}
    </>
  );
  return { insertTemplate: picker.open, saveAsTemplate: () => setNaming(true), element };
}
