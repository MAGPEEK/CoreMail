import { Keyboard, Send, Check } from 'lucide-react';
import { useUiPrefs, useUiStore } from '../store/ui.js';
import { useT, fmt } from '../i18n/useT.js';
import { SEND_DELAY_OPTIONS } from '../lib/send-delay.js';
import type { ShortcutSetId } from '../lib/shortcuts.js';

type SetChoice = ShortcutSetId | 'off';

/** Settings → View: keyboard shortcut set (or off) and the undo-send delay. */
export function ViewKeyboardSettings() {
  const t = useT();
  const {
    shortcutsEnabled, shortcutSet, sendDelaySec,
    setShortcutsEnabled, setShortcutSet, setSendDelaySec,
  } = useUiPrefs();
  const setShortcutHelpOpen = useUiStore((s) => s.setShortcutHelpOpen);
  const current: SetChoice = shortcutsEnabled ? shortcutSet : 'off';

  const choices: { value: SetChoice; label: string }[] = [
    { value: 'coremail', label: t('shortcut_set_coremail') },
    { value: 'gmail', label: t('shortcut_set_gmail') },
    { value: 'off', label: t('shortcut_set_off') },
  ];
  const choose = (v: SetChoice) => {
    if (v === 'off') { setShortcutsEnabled(false); return; }
    setShortcutsEnabled(true);
    setShortcutSet(v);
  };

  return (
    <>
      {/* ── Keyboard shortcuts ─────────────────────────────────────────────── */}
      <div>
        <h3 id="view-shortcuts-heading" className="text-sm font-semibold text-fg mb-1 flex items-center gap-2">
          <Keyboard size={15} className="text-fg-subtle" aria-hidden="true" />
          {t('view_shortcuts')}
        </h3>
        <p className="text-xs text-fg-subtle mb-3">{t('view_shortcuts_hint')}</p>
        <div role="radiogroup" aria-labelledby="view-shortcuts-heading" className="space-y-2">
          {choices.map(({ value, label }) => (
            <label
              key={value}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                current === value ? 'border-accent bg-accent/5' : 'border-line hover:border-line-strong hover:bg-surface-2'
              }`}
            >
              <input
                type="radio"
                name="shortcutSet"
                value={value}
                checked={current === value}
                onChange={() => choose(value)}
                className="text-accent-fg focus:ring-accent-fg"
              />
              <span className="flex-1 text-sm font-medium text-fg">{label}</span>
              {current === value && <Check size={14} className="text-accent-fg shrink-0" aria-hidden="true" />}
            </label>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShortcutHelpOpen(true)}
          aria-keyshortcuts={shortcutsEnabled ? '?' : undefined}
          className="mt-2 text-xs text-accent-fg hover:underline"
        >
          {t('shortcut_show_list')}
        </button>
      </div>

      {/* ── Undo send ──────────────────────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold text-fg mb-1 flex items-center gap-2">
          <Send size={15} className="text-fg-subtle" aria-hidden="true" />
          <label htmlFor="send-delay-select">{t('view_send_delay')}</label>
        </h3>
        <p className="text-xs text-fg-subtle mb-3">{t('view_send_delay_hint')}</p>
        <select
          id="send-delay-select"
          value={sendDelaySec}
          onChange={(e) => setSendDelaySec(Number(e.target.value))}
          className="text-sm border border-line-strong rounded px-2 py-1.5 bg-surface focus:border-accent-fg outline-none focus-visible:ring-2 focus-visible:ring-accent-fg"
        >
          {SEND_DELAY_OPTIONS.map((s) => (
            <option key={s} value={s}>{s === 0 ? t('send_delay_off') : fmt(t('send_delay_sec'), { n: s })}</option>
          ))}
        </select>
      </div>
    </>
  );
}
