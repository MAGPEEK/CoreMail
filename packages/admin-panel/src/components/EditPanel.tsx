/**
 * Right-side edit panel with tabs for long editors (user, shared mailbox, domain).
 * Full viewport height, header and tab strip stay in view while the tab content
 * scrolls. A backdrop click does not close it (only the close button or Escape);
 * with unsaved changes in any tab the close is confirmed. All tabs stay mounted
 * so a tab keeps its draft while another one is shown. Below 768 px it is full screen.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Modal } from './Modal.js';
import { useT } from '../i18n/useT.js';
import {
  initialTab, needsDiscardConfirm, rememberTab, tabForKey, withDirty,
  type DirtyTabs, type TabMemory,
} from '../lib/editPanel.js';

export interface EditPanelTab {
  id: string;
  label: string;
  content: ReactNode;
}

/** Last tab per panel kind, kept for the browser session. */
const tabMemory: TabMemory = new Map();

type ReportDirty = (dirty: boolean) => void;
const DirtyContext = createContext<ReportDirty>(() => undefined);

/** An editor inside a tab reports its unsaved state so the panel can guard closing. */
export function useReportDirty(dirty: boolean): void {
  const report = useContext(DirtyContext);
  useEffect(() => {
    report(dirty);
    return () => report(false);
  }, [report, dirty]);
}

/** Renderless form of useReportDirty for tab content that does not own its state. */
export function ReportDirty({ dirty }: { dirty: boolean }): null {
  useReportDirty(dirty);
  return null;
}

export function EditPanel({ kind, title, subtitle, tabs, onClose }: {
  /** Panel kind, e.g. "mailbox" — the last used tab is remembered per kind. */
  kind: string;
  title: string;
  subtitle?: string;
  tabs: EditPanelTab[];
  onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const ids = useMemo(() => tabs.map((x) => x.id), [tabs]);
  const [active, setActive] = useState(() => initialTab(tabMemory, kind, ids));
  const [dirty, setDirty] = useState<DirtyTabs>(new Set());
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const select = useCallback((id: string) => {
    rememberTab(tabMemory, kind, id);
    setActive(id);
  }, [kind]);

  const requestClose = useCallback(() => {
    if (!needsDiscardConfirm(dirty) || window.confirm(t('editpanel_discard'))) onClose();
  }, [dirty, onClose]);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = tabForKey(ids, active, e.key);
    if (next === null) return;
    e.preventDefault();
    select(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <Modal
      onClose={requestClose}
      labelledBy={titleId}
      closeOnBackdrop={false}
      layout="drawer"
      overlayClassName="fixed inset-0 z-50 flex justify-end bg-scrim/40"
      className="bg-surface shadow-2xl w-full md:w-[720px] md:max-w-full h-full flex flex-col"
    >
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line">
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-semibold text-fg truncate">{title}</h2>
          {subtitle && <p className="text-xs text-fg-subtle truncate">{subtitle}</p>}
        </div>
        <button type="button" onClick={requestClose} aria-label={t('action_close')} className="btn-ghost p-1 rounded shrink-0">
          <X size={16} className="text-fg-subtle" aria-hidden="true" />
        </button>
      </div>
      <div role="tablist" aria-label={title} onKeyDown={onTabKey}
        className="flex gap-1 px-3 border-b border-line overflow-x-auto">
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button key={tab.id} type="button" role="tab" id={`${titleId}-tab-${tab.id}`}
              aria-selected={selected} aria-controls={`${titleId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              ref={(el) => { if (el) tabRefs.current.set(tab.id, el); else tabRefs.current.delete(tab.id); }}
              onClick={() => select(tab.id)}
              className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${
                selected ? 'border-accent text-accent-fg font-medium' : 'border-transparent text-fg-muted hover:text-fg'}`}>
              {tab.label}
              {dirty.has(tab.id) && <span className="sr-only"> ({t('editpanel_unsaved')})</span>}
              {dirty.has(tab.id) && <span aria-hidden="true" className="ml-1 text-warning-fg">●</span>}
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
        {tabs.map((tab) => (
          <TabPanel key={tab.id} id={`${titleId}-panel-${tab.id}`} tabButtonId={`${titleId}-tab-${tab.id}`}
            tabId={tab.id} hidden={tab.id !== active} onDirty={setDirty}>
            {tab.content}
          </TabPanel>
        ))}
      </div>
    </Modal>
  );
}

function TabPanel({ id, tabButtonId, tabId, hidden, onDirty, children }: {
  id: string;
  tabButtonId: string;
  tabId: string;
  hidden: boolean;
  onDirty: (update: (prev: DirtyTabs) => DirtyTabs) => void;
  children: ReactNode;
}) {
  const report = useCallback<ReportDirty>((isDirty) => onDirty((prev) => withDirty(prev, tabId, isDirty)), [onDirty, tabId]);
  return (
    <div role="tabpanel" id={id} aria-labelledby={tabButtonId} hidden={hidden} className="space-y-4">
      <DirtyContext.Provider value={report}>{children}</DirtyContext.Provider>
    </div>
  );
}
