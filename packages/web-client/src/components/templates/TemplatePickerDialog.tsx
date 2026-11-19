/**
 * 10.1: "Neue E-Mail aus Vorlage" / "Vorlage einfügen" — search, the list of
 * the user's templates and a preview of the selected one (subject, recipients,
 * sanitised body on the mail paper). Footer: "Vorlagen verwalten" left,
 * "Abbrechen" / "Verwenden" (or "Einfügen") right. Empty state points to the
 * manager. Modal: focus trap, Escape closes, focus returns to the opener.
 * ↑ / ↓ in the search field move the list selection, Enter uses it.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Loader2, Search, X } from 'lucide-react';
import { Modal } from '../Modal.js';
import { MAIL_BODY_STYLE, MAIL_PAPER_CLASS } from '../MailBody.js';
import { TemplateListbox, listKeyDown, optionDomId } from './TemplateListbox.js';
import { useTemplate, useTemplateList } from '../../hooks/useMailTemplates.js';
import { filterTemplates, keepSelection, type MailTemplate } from '../../lib/mailTemplates.js';
import { sanitizeMailHtml } from '../../lib/mailHtml.js';
import { toastError } from '../../lib/errors.js';
import { useT } from '../../i18n/useT.js';

export type TemplatePickerMode = 'new' | 'insert';

interface Props {
  mode: TemplatePickerMode;
  /** "Verwenden" / "Einfügen" with the loaded template. */
  onUse: (template: MailTemplate) => void;
  onManage: () => void;
  onClose: () => void;
}

function Recipients({ label, list }: { label: string; list: string[] }) {
  if (list.length === 0) return null;
  return (
    <p className="text-xs text-fg-muted truncate">
      <span className="font-medium text-fg">{label}:</span> {list.join(', ')}
    </p>
  );
}

function Preview({ template, loading }: { template: MailTemplate | undefined; loading: boolean }) {
  const t = useT();
  const html = useMemo(() => (template ? sanitizeMailHtml(template.bodyHtml) : ''), [template]);
  if (loading || !template) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-sm text-fg-muted" role="status">
        {loading && <><Loader2 size={16} className="animate-spin" aria-hidden="true" />{t('tpl_loading')}</>}
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <div className="space-y-0.5">
        <p className="text-sm font-semibold text-fg break-words">{template.subject || t('compose_no_subject')}</p>
        <Recipients label={t('compose_to')} list={template.to} />
        <Recipients label={t('compose_cc')} list={template.cc} />
        <Recipients label={t('compose_bcc')} list={template.bcc} />
      </div>
      <div className="flex-1 min-h-[8rem] overflow-y-auto rounded border border-line">
        {html
          ? <div className={`${MAIL_PAPER_CLASS} p-3 text-sm`} style={MAIL_BODY_STYLE} dangerouslySetInnerHTML={{ __html: html }} />
          : <p className="p-3 text-sm text-fg-muted whitespace-pre-wrap">{template.bodyText}</p>}
      </div>
    </div>
  );
}

export function TemplatePickerDialog({ mode, onUse, onManage, onClose }: Props) {
  const t = useT();
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useTemplateList();
  const searchRef = useRef<HTMLInputElement>(null);
  // after the Modal moved focus into the dialog (and once the list has loaded): start in the search field
  useEffect(() => {
    const timer = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [list.isLoading]);
  const all = useMemo(() => list.data?.templates ?? [], [list.data]);
  const shown = useMemo(() => filterTemplates(all, query), [all, query]);
  useEffect(() => { setSelectedId((cur) => keepSelection(shown, cur)); }, [shown]);
  const detail = useTemplate(selectedId);
  useEffect(() => { if (list.error) toastError(list.error); }, [list.error]);

  const use = (templateId = selectedId) => {
    if (!templateId || detail.data?.id !== templateId) return;
    onUse(detail.data);
  };
  const keys = { templates: shown, selectedId, onSelect: setSelectedId, onActivate: (tid: string) => use(tid) };
  const empty = !list.isLoading && all.length === 0;

  return createPortal(
    <Modal
      onClose={onClose}
      labelledBy={`${id}-title`}
      overlayClassName="fixed inset-0 z-[200] flex items-center justify-center bg-scrim/40 sm:p-4"
      className="bg-surface shadow-xl flex flex-col w-full h-full sm:h-auto sm:max-h-[85vh] sm:w-[760px] sm:max-w-full sm:rounded-lg"
    >
      <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-line shrink-0">
        <h2 id={`${id}-title`} className="text-base font-semibold text-fg">
          {t(mode === 'new' ? 'tpl_picker_title_new' : 'tpl_picker_title_insert')}
        </h2>
        <button type="button" onClick={onClose} aria-label={t('compose_close')} className="p-2 rounded text-fg-muted hover:text-fg hover:bg-surface-2">
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {empty ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
          <FileText size={28} aria-hidden="true" className="text-fg-subtle" />
          <p className="text-sm font-semibold text-fg">{t('tpl_empty')}</p>
          <p className="text-sm text-fg-muted">{t('tpl_empty_hint')}</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col sm:flex-row sm:flex-[0_1_440px]">
          <div className="flex flex-col min-h-0 max-sm:max-h-[40%] sm:w-[280px] shrink-0 border-b sm:border-b-0 sm:border-r border-line p-3 gap-2">
            <label className="relative block shrink-0">
              <span className="sr-only">{t('tpl_search')}</span>
              <Search size={14} aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <input
                type="search"
                ref={searchRef}
                value={query}
                placeholder={t('tpl_search')}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => listKeyDown(e, keys)}
                aria-controls={listId}
                {...(selectedId ? { 'aria-activedescendant': optionDomId(listId, selectedId) } : {})}
                className="input pl-8"
              />
            </label>
            {list.isLoading
              ? <div className="flex justify-center py-6 text-fg-subtle"><Loader2 size={16} className="animate-spin" aria-label={t('tpl_loading')} /></div>
              : shown.length === 0
                ? <p className="text-sm text-fg-muted px-1 py-2" role="status">{t('tpl_no_match')}</p>
                : <TemplateListbox id={listId} label={t('tpl_list_label')} {...keys} />}
          </div>
          <section aria-label={t('tpl_preview')} className="flex-1 min-h-0 flex flex-col p-4 gap-2">
            {selectedId && <Preview template={detail.data?.id === selectedId ? detail.data : undefined} loading={detail.isLoading} />}
            <p className="text-xs text-fg-muted shrink-0">{t('tpl_attach_hint')}</p>
          </section>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-t border-line shrink-0">
        <button type="button" onClick={onManage} className="btn-ghost mr-auto">{t('tpl_manage')}</button>
        <button type="button" onClick={onClose} className="btn-secondary">{t('cancel')}</button>
        <button
          type="button"
          onClick={() => use()}
          disabled={!selectedId || detail.data?.id !== selectedId}
          className="btn-primary"
        >
          {t(mode === 'new' ? 'tpl_use' : 'tpl_insert')}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
