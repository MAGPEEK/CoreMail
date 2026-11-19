/**
 * 10.1: Settings → Vorlagen — the user's mail templates at a glance and the
 * button that opens "Vorlagen verwalten" (components/templates).
 */
import { FileText, Loader2 } from 'lucide-react';
import { useTemplateList } from '../../hooks/useMailTemplates.js';
import { useTemplateManager } from '../templates/useTemplatePicker.js';
import { SectionHeader } from './controls.js';
import { fmt, useT } from '../../i18n/useT.js';

export function TemplateSettings() {
  const t = useT();
  const list = useTemplateList();
  const manager = useTemplateManager();
  const templates = list.data?.templates ?? [];
  return (
    <section className="space-y-6">
      <SectionHeader title={t('section_templates')} description={t('settings_templates_desc')} />
      <div className="space-y-3">
        <button type="button" onClick={manager.open} className="btn-primary">{t('settings_templates_open')}</button>
        {list.isLoading ? (
          <div className="flex py-4 text-fg-subtle"><Loader2 size={16} className="animate-spin" aria-label={t('tpl_loading')} /></div>
        ) : templates.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('tpl_empty')}</p>
        ) : (
          <>
            <p className="text-xs text-fg-muted">{fmt(t('tpl_count'), { n: templates.length, max: list.data?.max ?? 200 })}</p>
            <ul aria-label={t('tpl_list_label')} className="divide-y divide-line border border-line rounded-lg">
              {templates.map((tpl) => (
                <li key={tpl.id} className="flex items-start gap-2.5 px-3 py-2">
                  <FileText size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-fg-subtle" />
                  <span className="min-w-0">
                    <span className="block text-sm text-fg truncate">{tpl.name}</span>
                    <span className="block text-xs text-fg-muted truncate">{tpl.subject || tpl.preview || t('compose_no_subject')}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {manager.element}    </section>
  );
}
