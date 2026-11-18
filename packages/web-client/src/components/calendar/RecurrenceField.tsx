import { useMemo, useState } from 'react';
import { Repeat } from 'lucide-react';
import {
  WEEKDAYS, WEEKDAY_LABEL, buildRrule, defaultModel, describeRrule, parseRrule, recurrencePresets,
  type Freq, type RecurrenceModel, type Weekday,
} from '../../lib/recurrence.js';

/**
 * 9.4: "Wiederholen" of the event form — presets from the start date plus a full
 * editor (interval, weekdays, monthly/yearly by day or position, end). A rule the
 * editor cannot show (written by another client) is kept unless replaced.
 */
interface Props {
  /** Start date of the event (YYYY-MM-DD). */
  date: string;
  rrule: string | null;
  onChange: (rrule: string | null) => void;
  disabled?: boolean;
}

const NONE = '__none';
const CUSTOM = '__custom';
const CURRENT = '__current';
const FREQ_LABEL: Record<Freq, string> = { DAILY: 'Tag(e)', WEEKLY: 'Woche(n)', MONTHLY: 'Monat(e)', YEARLY: 'Jahr(e)' };
const POSITIONS: Array<[number, string]> = [[1, 'ersten'], [2, 'zweiten'], [3, 'dritten'], [4, 'vierten'], [-1, 'letzten']];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const SHORT: Record<Weekday, string> = { MO: 'Mo', TU: 'Di', WE: 'Mi', TH: 'Do', FR: 'Fr', SA: 'Sa', SU: 'So' };

const inputCls = 'border border-line-strong rounded px-2 py-1 text-sm bg-surface focus:outline-none focus:ring-1 focus:ring-accent-fg disabled:opacity-60';

export function RecurrenceField({ date, rrule, onChange, disabled }: Props) {
  const presets = useMemo(() => (date ? recurrencePresets(date) : []), [date]);
  const normalized = rrule ? rrule.replace(/^RRULE:/i, '').toUpperCase() : null;
  const preset = presets.find((p) => p.rrule === normalized);
  const [editing, setEditing] = useState(false);
  const model = normalized && date ? parseRrule(normalized, date) : null;

  const selectValue = !normalized ? NONE : editing ? CUSTOM : preset ? preset.id : CURRENT;
  const onSelect = (v: string) => {
    if (v === NONE) { setEditing(false); onChange(null); return; }
    if (v === CUSTOM) { setEditing(true); if (!model) onChange(buildRrule(defaultModel(date))); return; }
    if (v === CURRENT) return;
    setEditing(false);
    const p = presets.find((x) => x.id === v);
    if (p) onChange(p.rrule);
  };
  const update = (patch: Partial<RecurrenceModel>) => {
    const base = model ?? defaultModel(date);
    onChange(buildRrule({ ...base, ...patch }));
  };

  return (
    <div className="flex items-start gap-3">
      <Repeat size={18} className="text-fg-subtle mt-2 shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0 space-y-2">
        <select
          aria-label="Wiederholen"
          value={selectValue}
          onChange={(e) => onSelect(e.target.value)}
          disabled={disabled || !date}
          className={inputCls}
        >
          <option value={NONE}>Nicht wiederholen</option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          {normalized && !preset && <option value={CURRENT}>{describeRrule(normalized, date)}</option>}
          <option value={CUSTOM}>Benutzerdefiniert …</option>
        </select>

        {editing && normalized && !model && (
          <p className="text-xs text-warning-fg">
            Diese Serie wurde mit einem anderen Programm angelegt und kann hier nicht im Detail bearbeitet werden.
            Eine Auswahl oben ersetzt die Regel.
          </p>
        )}

        {editing && model && (
          <fieldset className="border border-line rounded p-3 space-y-3 text-sm" disabled={disabled}>
            <legend className="px-1 text-xs text-fg-subtle">Serie bearbeiten</legend>
            <div className="flex items-center gap-2 flex-wrap">
              <label htmlFor="rec-interval">Wiederholen alle</label>
              <input
                id="rec-interval" type="number" min={1} max={99} value={model.interval}
                onChange={(e) => update({ interval: Math.max(1, Number(e.target.value) || 1) })}
                className={`${inputCls} w-16`}
              />
              <select aria-label="Einheit" value={model.freq} onChange={(e) => update({ ...defaultModel(date, e.target.value as Freq), interval: model.interval, end: model.end })} className={inputCls}>
                {(Object.keys(FREQ_LABEL) as Freq[]).map((f) => <option key={f} value={f}>{FREQ_LABEL[f]}</option>)}
              </select>
            </div>

            {model.freq === 'WEEKLY' && (
              <div role="group" aria-label="Wochentage" className="flex gap-1 flex-wrap">
                {WEEKDAYS.map((d) => {
                  const on = model.byDay.includes(d);
                  return (
                    <button
                      key={d} type="button" aria-pressed={on} aria-label={WEEKDAY_LABEL[d]}
                      onClick={() => {
                        const next = on ? model.byDay.filter((x) => x !== d) : [...model.byDay, d];
                        if (next.length > 0) update({ byDay: next });
                      }}
                      className={`w-9 h-8 rounded text-xs font-medium border ${on ? 'bg-accent text-white border-accent' : 'border-line-strong text-fg-muted hover:bg-surface-2'}`}
                    >
                      {SHORT[d]}
                    </button>
                  );
                })}
              </div>
            )}

            {(model.freq === 'MONTHLY' || model.freq === 'YEARLY') && (
              <div className="space-y-2">
                <label className="flex items-center gap-2 flex-wrap">
                  <input type="radio" name="rec-mode" checked={model.monthlyMode === 'day'} onChange={() => update({ monthlyMode: 'day' })} />
                  am
                  <input
                    type="number" min={1} max={31} aria-label="Tag des Monats" value={model.monthDay}
                    onChange={(e) => update({ monthlyMode: 'day', monthDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
                    className={`${inputCls} w-16`}
                  />
                  . Tag
                </label>
                <label className="flex items-center gap-2 flex-wrap">
                  <input type="radio" name="rec-mode" checked={model.monthlyMode === 'position'} onChange={() => update({ monthlyMode: 'position' })} />
                  am
                  <select aria-label="Woche des Monats" value={model.setPos} onChange={(e) => update({ monthlyMode: 'position', setPos: Number(e.target.value) })} className={inputCls}>
                    {POSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <select aria-label="Wochentag" value={model.posDay} onChange={(e) => update({ monthlyMode: 'position', posDay: e.target.value as Weekday })} className={inputCls}>
                    {WEEKDAYS.map((d) => <option key={d} value={d}>{WEEKDAY_LABEL[d]}</option>)}
                  </select>
                </label>
                {model.freq === 'YEARLY' && (
                  <label className="flex items-center gap-2">
                    im
                    <select aria-label="Monat" value={model.month} onChange={(e) => update({ month: Number(e.target.value) })} className={inputCls}>
                      {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className="text-xs text-fg-subtle">Ende</div>
              <label className="flex items-center gap-2">
                <input type="radio" name="rec-end" checked={model.end.type === 'never'} onChange={() => update({ end: { type: 'never' } })} />
                Nie
              </label>
              <label className="flex items-center gap-2 flex-wrap">
                <input type="radio" name="rec-end" checked={model.end.type === 'count'} onChange={() => update({ end: { type: 'count', count: 10 } })} />
                nach
                <input
                  type="number" min={1} max={999} aria-label="Anzahl Termine"
                  value={model.end.type === 'count' ? model.end.count : 10}
                  onChange={(e) => update({ end: { type: 'count', count: Math.max(1, Number(e.target.value) || 1) } })}
                  className={`${inputCls} w-20`}
                />
                Terminen
              </label>
              <label className="flex items-center gap-2 flex-wrap">
                <input type="radio" name="rec-end" checked={model.end.type === 'until'} onChange={() => update({ end: { type: 'until', date } })} />
                am
                <input
                  type="date" aria-label="Enddatum der Serie" min={date}
                  value={model.end.type === 'until' ? model.end.date : date}
                  onChange={(e) => e.target.value && update({ end: { type: 'until', date: e.target.value } })}
                  className={inputCls}
                />
              </label>
            </div>
            <p className="text-xs text-fg-subtle" aria-live="polite">{describeRrule(buildRrule(model), date)}</p>
          </fieldset>
        )}
      </div>
    </div>
  );
}
