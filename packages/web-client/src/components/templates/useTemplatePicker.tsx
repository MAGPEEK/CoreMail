/**
 * 10.1: entry points of the mail templates.
 *
 * Wiring of "Neue E-Mail aus Vorlage" (10.7: the "Neue E-Mail" split button of the folder card):
 *
 *   const templates = useTemplatePicker();
 *   <NewMailButton onNewFromTemplate={templates.open} />
 *   {templates.element}
 *
 * `open()` shows TemplatePickerDialog; "Verwenden" opens a new compose tab
 * (store/ui.ts openCompose) with the template's subject, recipients and
 * sanitised body (the default signature follows it); "Vorlagen verwalten" opens
 * the manager above the picker. `element` is null while nothing is open.
 *
 * useTemplateDialogs is the same pair with an own "use" action (the compose
 * "Vorlage einfügen …"); useTemplateManager opens the manager alone (Settings).
 */
import { useState, type ReactNode } from 'react';
import { TemplatePickerDialog, type TemplatePickerMode } from './TemplatePickerDialog.js';
import { TemplateManagerDialog } from './TemplateManagerDialog.js';
import { composeFromTemplate, type MailTemplate } from '../../lib/mailTemplates.js';
import { quoteMailHtml } from '../../lib/mailHtml.js';
import { useUiStore } from '../../store/ui.js';

export interface TemplateDialogs {
  open: () => void;
  element: ReactNode;
}

export function useTemplateDialogs(mode: TemplatePickerMode, onUse: (template: MailTemplate) => void): TemplateDialogs {
  const [picker, setPicker] = useState(false);
  const [manager, setManager] = useState(false);
  const element = picker || manager ? (
    <>
      {picker && (
        <TemplatePickerDialog
          mode={mode}
          onUse={(tpl) => { setPicker(false); onUse(tpl); }}
          onManage={() => setManager(true)}
          onClose={() => setPicker(false)}
        />
      )}
      {manager && <TemplateManagerDialog onClose={() => setManager(false)} />}
    </>
  ) : null;
  return { open: () => setPicker(true), element };
}

/** "Neue E-Mail aus Vorlage" of the "Neue E-Mail" split button (see the header comment). */
export function useTemplatePicker(): TemplateDialogs {
  return useTemplateDialogs('new', (tpl) => {
    useUiStore.getState().openCompose(composeFromTemplate(tpl, quoteMailHtml(tpl.bodyHtml)));
  });
}

/** "Vorlagen verwalten" on its own (Settings → Vorlagen). */
export function useTemplateManager(): TemplateDialogs {
  const [open, setOpen] = useState(false);
  return {
    open: () => setOpen(true),
    element: open ? <TemplateManagerDialog onClose={() => setOpen(false)} /> : null,
  };
}
