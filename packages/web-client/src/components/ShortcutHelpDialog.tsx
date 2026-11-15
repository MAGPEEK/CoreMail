import { Fragment, useMemo } from 'react';
import { Keyboard, X } from 'lucide-react';
import { Modal } from './Modal.js';
import { useUiPrefs, useUiStore } from '../store/ui.js';
import { useT, fmt } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import {
  SHORTCUT_SETS, ACTION_GROUP, displayKeys,
  type ShortcutAction, type ShortcutGroup,
} from '../lib/shortcuts.js';

const GROUP_ORDER: ShortcutGroup[] = ['compose', 'actions', 'navigation', 'goto', 'calendar', 'general'];

export function actionLabelKey(action: ShortcutAction): TranslationKey {
  return `sc_${action.replace('.', '_')}` as TranslationKey;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function Keys({ keys, then }: { keys: string; then: string }) {
  const steps = displayKeys(keys, isMac);
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {steps.map((combo, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-[10px] text-gray-400">{then}</span>}
          {combo.map((k, j) => (
            <kbd key={j} className="min-w-[1.5rem] text-center px-1.5 py-0.5 text-[11px] font-mono rounded border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-200 shadow-[0_1px_0_rgba(0,0,0,0.1)]">{k}</kbd>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

/** `?` — lists the active shortcut set, grouped (accessible Modal). */
export function ShortcutHelpDialog() {
  const t = useT();
  const { shortcutHelpOpen, setShortcutHelpOpen } = useUiStore();
  const { shortcutSet, shortcutsEnabled } = useUiPrefs();

  const groups = useMemo(() => {
    const byAction = new Map<ShortcutAction, string[]>();
    for (const b of SHORTCUT_SETS[shortcutSet]) {
      byAction.set(b.action, [...(byAction.get(b.action) ?? []), b.keys]);
    }
    return GROUP_ORDER.map((g) => ({
      group: g,
      rows: [...byAction.entries()].filter(([a]) => ACTION_GROUP[a] === g),
    })).filter((g) => g.rows.length > 0);
  }, [shortcutSet]);

  if (!shortcutHelpOpen) return null;
  const setName = t(shortcutSet === 'gmail' ? 'shortcut_set_gmail' : 'shortcut_set_coremail');

  return (
    <Modal
      onClose={() => setShortcutHelpOpen(false)}
      labelledBy="shortcut-help-title"
      className="bg-white dark:bg-gray-900 rounded-lg shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <div>
          <h2 id="shortcut-help-title" className="text-base font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <Keyboard size={16} aria-hidden="true" /> {t('sc_help_title')}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {shortcutsEnabled ? fmt(t('sc_help_active_set'), { set: setName }) : t('sc_help_disabled')}
          </p>
        </div>
        <button aria-label={t('close')} className="btn-ghost p-1" onClick={() => setShortcutHelpOpen(false)}>
          <X size={16} />
        </button>
      </div>
      <div className="overflow-y-auto px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
        {groups.map(({ group, rows }) => (
          <section key={group} aria-labelledby={`sc-group-${group}`}>
            <h3 id={`sc-group-${group}`} className="text-xs font-semibold uppercase tracking-wide text-accent mb-2">
              {t(`sc_group_${group}` as TranslationKey)}
            </h3>
            <dl className="space-y-1.5">
              {rows.map(([action, keys]) => (
                <div key={action} className="flex items-center justify-between gap-3 text-sm">
                  <dt className="text-gray-700 dark:text-gray-200">{t(actionLabelKey(action))}</dt>
                  <dd className="flex items-center gap-1.5 shrink-0">
                    {keys.map((k, i) => (
                      <Fragment key={k}>
                        {i > 0 && <span className="text-[10px] text-gray-400">{t('sc_or')}</span>}
                        <Keys keys={k} then={t('sc_then')} />
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
