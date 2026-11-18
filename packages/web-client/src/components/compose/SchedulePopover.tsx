/** "Senden ▾ → Senden planen …": presets (tomorrow morning / afternoon, next Monday) or a chosen time. */
import { useId, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { AnchoredPopover } from './AnchoredPopover.js';
import { defaultCustomSchedule, schedulePresets, scheduleProblem } from '../../lib/composeRules.js';
import { toLocalInput } from '../../lib/datetime.js';
import { formatLongDateTime } from '../../lib/regionalFormat.js';
import { useRegional } from '../../store/preferences.js';
import { useT } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';

interface Props {
  anchor: HTMLElement;
  onSchedule: (date: Date) => void;
  onClose: () => void;
}

export function SchedulePopover({ anchor, onSchedule, onClose }: Props) {
  const t = useT();
  const regional = useRegional();
  const inputId = useId();
  const errorId = useId();
  const [now] = useState(() => new Date());
  const [value, setValue] = useState(() => toLocalInput(defaultCustomSchedule(now)));
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const problem = scheduleProblem(value, new Date());
    if (problem) { setError(t(problem === 'invalid' ? 'compose_schedule_invalid' : 'compose_schedule_too_soon')); return; }
    onSchedule(new Date(value));
  };

  return (
    <AnchoredPopover anchor={anchor} label={t('compose_schedule_title')} onClose={onClose} className="w-80 py-2">
      <h2 className="px-3 pb-2 mb-1 text-xs font-semibold text-fg-muted border-b border-line flex items-center gap-1.5">
        <CalendarClock size={13} aria-hidden="true" /> {t('compose_schedule_title')}
      </h2>
      {schedulePresets(now).map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onSchedule(p.date)}
          className="w-full text-left px-3 py-2 hover:bg-surface-2 focus-visible:bg-surface-2 flex items-center justify-between gap-3"
        >
          <span className="text-sm text-fg font-medium">{t(`compose_preset_${p.id}` as TranslationKey)}</span>
          <span className="text-xs text-fg-subtle">{formatLongDateTime(p.date, regional)}</span>
        </button>
      ))}
      <div className="border-t border-line mt-1 pt-2 px-3 space-y-2">
        <label htmlFor={inputId} className="block text-xs text-fg-muted">{t('compose_schedule_custom')}</label>
        <input
          id={inputId}
          type="datetime-local"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          aria-invalid={error ? true : undefined}
          {...(error ? { 'aria-describedby': errorId } : {})}
          className="w-full text-sm bg-surface text-fg border border-line-strong rounded px-2 py-1.5"
        />
        {error && <p id={errorId} role="alert" className="text-xs text-danger-fg">{error}</p>}
        <button type="button" onClick={submit} className="btn-primary text-xs w-full justify-center">
          {t('compose_schedule_submit')}
        </button>
      </div>
    </AnchoredPopover>
  );
}
