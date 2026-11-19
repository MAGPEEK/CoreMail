/**
 * 10.1: "Vorlagen verwalten" — the list of the user's templates (left) and an
 * editor (right): name, subject, An / Cc / Bcc (the compose recipient fields)
 * and the body (the compose editor with a small formatting bar). "Neue
 * Vorlage", "Speichern", "Löschen" (asks first). Changing the selection or
 * closing with unsaved changes asks first. Below 640 px the list and the
 * editor are shown one at a time ("Zurück zur Liste"). The body is sanitised
 * when it is loaded into the editor and again before it is saved.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorContent, type Editor } from '@tiptap/react';
import { ArrowLeft, Bold, FileText, Italic, Link2, List, ListOrdered, Loader2, Plus, Redo2, Trash2, Underline, Undo2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { Modal } from '../Modal.js';
import { PromptDialog } from '../PromptDialog.js';
import { CommandBar, type CommandItem } from '../CommandBar.js';
import { RecipientField } from '../compose/RecipientField.js';
import { TemplateListbox } from './TemplateListbox.js';
import { COMPOSE_EDITOR_CLASS, useComposeEditor } from '../../hooks/useComposeEditor.js';
import { useTemplate, useTemplateList, useTemplateWrites } from '../../hooks/useMailTemplates.js';
import {
  EMPTY_TEMPLATE_INPUT, keepSelection, templateBodyTooLarge, templateChanged, templateInputOf, templateNameProblem,
  type MailTemplate, type TemplateInput,
} from '../../lib/mailTemplates.js';
import { commitText, fromList, recipientList, type RecipientValue } from '../../lib/recipients.js';
import { quoteMailHtml } from '../../lib/mailHtml.js';
import { safeLinkUrl } from '../../lib/compose.js';
import { toastError } from '../../lib/errors.js';
import { fmt, useT } from '../../i18n/useT.js';

interface Props {
  onClose: () => void;
}

/** What the editor shows: a stored template, or a new one not saved yet. */
type Editing = { kind: 'existing'; id: string } | { kind: 'new' } | null;

interface FormState { name: string; subject: string; to: RecipientValue; cc: RecipientValue; bcc: RecipientValue }

const formOf = (t: TemplateInput): FormState => ({ name: t.name, subject: t.subject, to: fromList(t.to), cc: fromList(t.cc), bcc: fromList(t.bcc) });
const NO_UNRESOLVED = Object.freeze({});
const FIELD_LABEL = 'text-sm text-fg-muted sm:w-20 shrink-0 sm:pt-1.5';

function FormatBar({ editor, onLink }: { editor: Editor | null; onLink: () => void }) {
  const t = useT();
  const run = (fn: (e: Editor) => void) => () => { if (editor) fn(editor); };
  const item = (id: string, label: string, icon: React.ReactNode, onClick: () => void, pressed?: boolean): CommandItem => ({
    id, label, icon, iconOnly: true, onClick, ...(pressed === undefined ? {} : { pressed }), ...(editor ? {} : { disabled: true }),
  });
  const items: CommandItem[] = [
    item('bold', t('compose_bold'), <Bold size={15} />, run((e) => e.chain().focus().toggleBold().run()), !!editor?.isActive('bold')),
    item('italic', t('compose_italic'), <Italic size={15} />, run((e) => e.chain().focus().toggleItalic().run()), !!editor?.isActive('italic')),
    item('underline', t('compose_underline'), <Underline size={15} />, run((e) => e.chain().focus().toggleUnderline().run()), !!editor?.isActive('underline')),
    item('bullets', t('compose_bullets'), <List size={15} />, run((e) => e.chain().focus().toggleBulletList().run()), !!editor?.isActive('bulletList')),
    item('numbering', t('compose_numbering'), <ListOrdered size={15} />, run((e) => e.chain().focus().toggleOrderedList().run()), !!editor?.isActive('orderedList')),
    item('link', t('compose_link'), <Link2 size={15} />, onLink),
    item('undo', t('compose_undo'), <Undo2 size={15} />, run((e) => e.chain().focus().undo().run())),
    item('redo', t('compose_redo'), <Redo2 size={15} />, run((e) => e.chain().focus().redo().run())),
  ];
  return (
    <div className="px-2 py-1 rounded-t border border-b-0 border-line bg-surface-2 text-[13px] [&_[data-roving-stop]:hover]:bg-surface-3">
      <CommandBar label={t('compose_format_label')} groups={[{ id: 'format', items }]} dividers={false} />
    </div>
  );
}

export function TemplateManagerDialog({ onClose }: Props) {
  const t = useT();
  const id = useId();
  const list = useTemplateList();
  const templates = list.data?.templates ?? [];
  const writes = useTemplateWrites();
  const [editing, setEditing] = useState<Editing>(null);
  const [mobileView, setMobileView] = useState<'list' | 'edit'>('list');
  const [form, setForm] = useState<FormState>(formOf(EMPTY_TEMPLATE_INPUT));
  const [error, setError] = useState<string | null>(null);
  const [linkDialog, setLinkDialog] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const baseline = useRef<{ input: TemplateInput; html: string }>({ input: EMPTY_TEMPLATE_INPUT, html: '' });
  const refs = { to: useRef<HTMLInputElement>(null), cc: useRef<HTMLInputElement>(null), bcc: useRef<HTMLInputElement>(null) };
  const nameRef = useRef<HTMLInputElement>(null);
  const editor = useComposeEditor({ label: t('tpl_body'), placeholder: t('compose_body_placeholder'), onPasteImage: () => undefined });
  const selectedId = editing?.kind === 'existing' ? editing.id : null;
  const detail = useTemplate(selectedId);

  // after the Modal moved focus into the dialog: start in the list (or on "Neue Vorlage" while there is none)
  const newRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (list.isLoading) return;
    const timer = setTimeout(() => (document.getElementById(`${id}-list`) ?? newRef.current)?.focus(), 0);
    return () => clearTimeout(timer);
  }, [list.isLoading]);

  // first open: the first template is shown
  useEffect(() => {
    if (editing === null && list.data) {
      const first = keepSelection(templates, null);
      if (first) setEditing({ kind: 'existing', id: first });
    }
  }, [list.data]);

  /** Puts a template (or an empty one) into the form and the editor. */
  const load = (input: TemplateInput) => {
    setForm(formOf(input));
    setError(null);
    const html = input.bodyHtml ? quoteMailHtml(input.bodyHtml) : '';
    editor?.commands.setContent(html);
    baseline.current = { input, html: editor?.getHTML() ?? html };
  };
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!editor) return;
    if (editing?.kind === 'new' && loadedFor.current !== 'new') { loadedFor.current = 'new'; load(EMPTY_TEMPLATE_INPUT); return; }
    const d = detail.data;
    if (editing?.kind === 'existing' && d && d.id === editing.id && loadedFor.current !== `${d.id}@${d.updatedAt}`) {
      loadedFor.current = `${d.id}@${d.updatedAt}`;
      load(d);
    }
  }, [editor, editing, detail.data]);

  const current = (): TemplateInput => ({
    name: form.name,
    subject: form.subject,
    bodyHtml: editor?.getHTML() ?? '',
    bodyText: editor?.getText({ blockSeparator: '\n' }) ?? '',
    to: recipientList(commitText(form.to)),
    cc: recipientList(commitText(form.cc)),
    bcc: recipientList(commitText(form.bcc)),
  });
  const dirty = (): boolean => {
    if (!editing) return false;
    const now = current();
    return templateChanged({ ...baseline.current.input, bodyHtml: baseline.current.html }, now);
  };
  const leaveOk = () => !dirty() || window.confirm(t('tpl_discard_changes'));

  const select = (next: string) => {
    if (next === selectedId || !leaveOk()) return;
    loadedFor.current = null;
    setEditing({ kind: 'existing', id: next });
    setMobileView('edit');
  };
  const startNew = () => {
    if (!leaveOk()) return;
    loadedFor.current = null;
    setEditing({ kind: 'new' });
    setMobileView('edit');
    requestAnimationFrame(() => nameRef.current?.focus());
  };
  const close = () => { if (leaveOk()) onClose(); };

  const save = async () => {
    const input = templateInputOf(current());
    const nameProblem = templateNameProblem(input.name);
    if (nameProblem) { setError(t(nameProblem === 'empty' ? 'tpl_name_empty' : 'tpl_name_long')); nameRef.current?.focus(); return; }
    const body = { ...input, bodyHtml: quoteMailHtml(input.bodyHtml) };
    if (templateBodyTooLarge(body.bodyHtml, body.bodyText)) { setError(t('tpl_body_large')); return; }
    setError(null);
    try {
      const saved: MailTemplate = editing?.kind === 'existing'
        ? await writes.update.mutateAsync({ id: editing.id, input: body })
        : await writes.create.mutateAsync(body);
      loadedFor.current = `${saved.id}@${saved.updatedAt}`;
      load(saved);
      setEditing({ kind: 'existing', id: saved.id });
      toast.success(t('tpl_saved'));
      setAnnouncement(t('tpl_saved'));
    } catch (err) {
      toastError(err);
    }
  };

  const remove = async () => {
    if (editing?.kind !== 'existing') { loadedFor.current = null; setEditing(null); setMobileView('list'); return; }
    if (!window.confirm(fmt(t('tpl_delete_confirm'), { name: form.name || baseline.current.input.name }))) return;
    try {
      await writes.remove.mutateAsync(editing.id);
      const rest = templates.filter((x) => x.id !== editing.id);
      loadedFor.current = null;
      const next = keepSelection(rest, null);
      setEditing(next ? { kind: 'existing', id: next } : null);
      if (!next) load(EMPTY_TEMPLATE_INPUT);
      setMobileView('list');
      toast.success(t('tpl_deleted'));
      setAnnouncement(t('tpl_deleted'));
    } catch (err) {
      toastError(err);
    }
  };

  const applyLink = (url: string) => {
    const href = safeLinkUrl(url);
    if (!href || !editor) return;
    if (editor.state.selection.empty && !editor.isActive('link')) {
      editor.chain().focus().insertContent({ type: 'text', text: url.trim(), marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    setLinkDialog(null);
  };

  const busy = writes.create.isPending || writes.update.isPending || writes.remove.isPending;
  const loadingDetail = editing?.kind === 'existing' && detail.isLoading;
  const count = useMemo(() => fmt(t('tpl_count'), { n: templates.length, max: list.data?.max ?? 200 }), [templates.length, list.data?.max, t]);
  const atLimit = templates.length >= (list.data?.max ?? 200);
  const set = <K extends keyof FormState>(key: K) => (v: FormState[K]) => setForm((f) => ({ ...f, [key]: v }));

  return createPortal(
    <Modal
      onClose={close}
      labelledBy={`${id}-title`}
      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 z-[210] flex items-center justify-center bg-scrim/40 sm:p-4"
      className="bg-surface shadow-xl flex flex-col w-full h-full sm:h-[85vh] sm:max-h-[720px] sm:w-[980px] sm:max-w-full sm:rounded-lg"
    >
      <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-line shrink-0">
        <h2 id={`${id}-title`} className="text-base font-semibold text-fg">{t('tpl_manager_title')}</h2>
        <button type="button" onClick={close} aria-label={t('compose_close')} className="p-2 rounded text-fg-muted hover:text-fg hover:bg-surface-2">
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className={`flex flex-col min-h-0 w-full sm:w-[280px] shrink-0 sm:border-r border-line p-3 gap-2 ${mobileView === 'edit' ? 'max-sm:hidden' : ''}`}>
          <button ref={newRef} type="button" onClick={startNew} disabled={atLimit} className="btn-secondary justify-center shrink-0">
            <Plus size={15} aria-hidden="true" /> {t('tpl_new')}
          </button>
          <p className="text-xs text-fg-muted px-1 shrink-0">{count}</p>
          {list.isLoading
            ? <div className="flex justify-center py-6 text-fg-subtle"><Loader2 size={16} className="animate-spin" aria-label={t('tpl_loading')} /></div>
            : templates.length === 0
              ? (
                <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
                  <FileText size={24} aria-hidden="true" className="text-fg-subtle" />
                  <p className="text-sm font-semibold text-fg">{t('tpl_empty')}</p>
                  <p className="text-xs text-fg-muted">{t('tpl_empty_manager_hint')}</p>
                </div>
              )
              : <TemplateListbox id={`${id}-list`} label={t('tpl_list_label')} templates={templates} selectedId={selectedId} onSelect={select} />}
        </div>

        {!editing ? <div className="flex-1 max-sm:hidden" /> : (
        <form
          aria-label={t('tpl_editor_label')}
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className={`flex-1 min-w-0 min-h-0 flex flex-col ${mobileView === 'list' ? 'max-sm:hidden' : ''}`}
        >
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
            <button type="button" onClick={() => { if (leaveOk()) { setMobileView('list'); } }} className="btn-ghost sm:hidden -ml-2">
              <ArrowLeft size={15} aria-hidden="true" /> {t('tpl_back')}
            </button>
            {loadingDetail && <p role="status" className="text-sm text-fg-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('tpl_loading')}</p>}
            <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
              <label htmlFor={`${id}-name`} className={FIELD_LABEL}>{t('tpl_name')}</label>
              <div className="flex-1 min-w-0">
                <input
                  id={`${id}-name`}
                  ref={nameRef}
                  value={form.name}
                  maxLength={100}
                  aria-required="true"
                  aria-invalid={!!error && !!templateNameProblem(form.name)}
                  aria-describedby={error ? `${id}-error` : undefined}
                  onChange={(e) => { set('name')(e.target.value); setError(null); }}
                  className="input"
                />
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
              <label htmlFor={`${id}-subject`} className={FIELD_LABEL}>{t('compose_subject')}</label>
              <input id={`${id}-subject`} value={form.subject} maxLength={998} onChange={(e) => set('subject')(e.target.value)} className="input flex-1 min-w-0" />
            </div>
            {(['to', 'cc', 'bcc'] as const).map((field) => (
              <div key={field} className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
                <label htmlFor={`${id}-${field}`} className={FIELD_LABEL}>{t(`compose_${field}`)}</label>
                <div className="flex-1 min-w-0 border border-line-strong rounded px-2 py-1 focus-within:ring-2 focus-within:ring-accent-fg/30 focus-within:border-accent-fg">
                  <RecipientField
                    id={`${id}-${field}`}
                    label={t(`compose_${field}`)}
                    value={form[field]}
                    onChange={set(field)}
                    onAnnounce={setAnnouncement}
                    unresolved={NO_UNRESOLVED}
                    inputRef={refs[field]}
                  />
                </div>
              </div>
            ))}
            <div>
              <p className="text-sm text-fg-muted mb-1" id={`${id}-body-label`}>{t('tpl_body')}</p>
              <FormatBar editor={editor} onLink={() => setLinkDialog((editor?.getAttributes('link')['href'] as string | undefined) ?? 'https://')} />
              <div className="border border-line rounded-b bg-surface">
                <EditorContent editor={editor} className={COMPOSE_EDITOR_CLASS} />
              </div>
              <p className="text-xs text-fg-muted mt-1">{t('tpl_attach_hint')}</p>
            </div>
            {error && <p id={`${id}-error`} role="alert" className="text-sm text-danger-fg">{error}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-t border-line shrink-0">
            <button type="button" onClick={() => { void remove(); }} disabled={busy || !editing} className="btn-ghost mr-auto hover:text-danger-fg">
              <Trash2 size={15} aria-hidden="true" /> {t('tpl_delete')}
            </button>
            <button type="button" onClick={close} className="btn-secondary">{t('compose_close')}</button>
            <button type="submit" disabled={busy || loadingDetail} className="btn-primary">
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('tpl_save')}
            </button>
          </div>
        </form>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      {linkDialog !== null && (
        <PromptDialog
          title={t('compose_link_title')}
          label={t('compose_link_label')}
          initialValue={linkDialog}
          confirmText={t('compose_link_apply')}
          cancelText={t('cancel')}
          validate={(v) => (safeLinkUrl(v) ? null : t('compose_link_invalid'))}
          requiredText={t('compose_link_invalid')}
          onConfirm={applyLink}
          onCancel={() => { setLinkDialog(null); editor?.commands.focus(); }}
        />
      )}
    </Modal>,
    document.body,
  );
}
