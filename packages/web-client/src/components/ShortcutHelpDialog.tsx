import { Fragment, useMemo } from 'react';
import { Keyboard, X } from 'lucide-react';
import { Modal } from './Modal.js';
import { useUiPrefs, useUiStore } from '../store/ui.js';
import { useT, fmt } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import {
  SHORTCUT_SETS, ACTION_GROUP, COMPOSE_AREA_KEYS, displayKeys,
  type Binding, type ShortcutAction, type ShortcutGroup,
} from '../lib/shortcuts.js';

const GROUP_ORDER: ShortcutGroup[] = ['compose', 'actions', 'navigation', 'goto', 'calendar', 'general'];

export function actionLabelKey(action: ShortcutAction): TranslationKey {
  return `sc_${action.replace('.', '_')}` as TranslationKey;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function Keys({ keys, then, noMeta }: { keys: string; then: string; noMeta?: boolean | undefined }) {
  const steps = displayKeys(keys, isMac, !!noMeta);
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {steps.map((combo, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-[10px] text-fg-subtle">{then}</span>}
          {combo.map((k, j) => (
            <kbd key={j} className="min-w-[1.5rem] text-center px-1.5 py-0.5 text-[11px] font-mono rounded border border-line-strong bg-surface-2 text-fg-muted shadow-[0_1px_0_rgba(0,0,0,0.1)]">{k}</kbd>
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
    const byAction = new Map<ShortcutAction, Binding[]>();
    for (const b of SHORTCUT_SETS[shortcutSet]) {
      byAction.set(b.action, [...(byAction.get(b.action) ?? []), b]);
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
      className="bg-surface rounded-lg shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-line shrink-0">
        <div>
          <h2 id="shortcut-help-title" className="text-base font-semibold text-fg flex items-center gap-2">
            <Keyboard size={16} aria-hidden="true" /> {t('sc_help_title')}
          </h2>
          <p className="text-xs text-fg-subtle mt-0.5">
            {shortcutsEnabled ? fmt(t('sc_help_active_set'), { set: setName }) : t('sc_help_disabled')}
          </p>
          {shortcutsEnabled && (
            <p className="text-xs text-fg-subtle mt-0.5">{t('sc_help_browser_keys')}</p>
          )}
        </div>
        <button aria-label={t('close')} className="btn-ghost p-1" onClick={() => setShortcutHelpOpen(false)}>
          <X size={16} />
        </button>
      </div>
      <div className="overflow-y-auto px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
        {groups.map(({ group, rows }) => (
          <section key={group} aria-labelledby={`sc-group-${group}`}>
            <h3 id={`sc-group-${group}`} className="text-xs font-semibold uppercase tracking-wide text-accent-fg mb-2">
              {t(`sc_group_${group}` as TranslationKey)}
            </h3>
            <dl className="space-y-1.5">
              {rows.map(([action, keys]) => (
                <div key={action} className="flex items-center justify-between gap-3 text-sm">
                  <dt className="text-fg-muted">{t(actionLabelKey(action))}</dt>
                  <dd className="flex items-center gap-1.5 shrink-0">
                    {keys.map((b, i) => (
                      <Fragment key={b.keys}>
                        {i > 0 && <span className="text-[10px] text-fg-subtle">{t('sc_or')}</span>}
                        <Keys keys={b.keys} then={t('sc_then')} noMeta={b.noMeta} />
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
              {/* 9.4: keys of the compose area itself (always on) */}
              {group === 'compose' && COMPOSE_AREA_KEYS.map((k) => (
                <div key={k.keys} className="flex items-center justify-between gap-3 text-sm">
                  <dt className="text-fg-muted">{t(k.label as TranslationKey)}</dt>
                  <dd className="flex items-center gap-1.5 shrink-0"><Keys keys={k.keys} then={t('sc_then')} /></dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
