/**
 * Tab strip of the open drafts at the bottom of the mail view: a click shows a
 * draft in the reading pane (the shown one goes to the strip), ✕ saves and
 * closes it. Hidden while no draft is open.
 */
import toast from 'react-hot-toast';
import { PencilLine, X } from 'lucide-react';
import { useUiStore } from '../../store/ui.js';
import { tabTitle } from '../../lib/composeTabs.js';
import { closeStripDraft } from './composeRuntime.js';
import { fmt, useT } from '../../i18n/useT.js';
import { PANE_CARD_BASE } from '../../lib/paneLayout.js';

function closeFromStrip(key: string, savedText: string, failedText: string): void {
  closeStripDraft(key).then(({ saved }) => {
    useUiStore.getState().closeCompose(key);
    if (saved) toast.success(savedText);
  }, () => toast.error(failedText));
}

export function DraftTabStrip() {
  const t = useT();
  const { tabs, activeKey } = useUiStore((s) => s.compose);
  const activate = useUiStore((s) => s.activateCompose);
  if (tabs.length === 0) return null;
  return (
    <nav aria-label={t('compose_strip_label')} className={`shrink-0 max-md:border-t bg-surface-2 ${PANE_CARD_BASE} px-2 py-1 coremail-no-print`}>
      <ul className="flex gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const title = tabTitle(tab.subject, t('compose_no_subject'));
          const active = tab.key === activeKey;
          return (
            <li key={tab.key} className={`flex items-center max-w-[16rem] rounded border text-sm ${active ? 'bg-surface border-line-strong text-fg' : 'bg-surface-2 border-line text-fg-muted hover:bg-surface'}`}>
              <button
                type="button"
                onClick={() => activate(tab.key)}
                aria-current={active ? 'true' : undefined}
                aria-label={fmt(t('compose_strip_show'), { title })}
                className="flex items-center gap-1.5 pl-2 pr-1 py-1 min-w-0 rounded-l"
              >
                <PencilLine size={13} className="shrink-0 text-accent-fg" aria-hidden="true" />
                <span className={`truncate ${active ? 'font-semibold' : ''}`}>{title}</span>
              </button>
              <button
                type="button"
                onClick={() => closeFromStrip(tab.key, t('draft_saved_closed'), t('draft_save_failed'))}
                aria-label={fmt(t('compose_strip_close'), { title })}
                title={fmt(t('compose_strip_close'), { title })}
                className="p-1 mr-0.5 rounded text-fg-subtle hover:text-fg hover:bg-surface-3 shrink-0"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
