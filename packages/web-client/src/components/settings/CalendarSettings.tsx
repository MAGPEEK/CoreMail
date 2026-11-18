/** 9.4: Settings → Kalender (work week and hours, week start, time grid, reminders, duration). */
import { usePreferences } from '../../store/preferences.js';
import { useUiPrefs } from '../../store/ui.js';
import type { WeekStart } from '../../lib/preferences.js';
import { CheckField, Group, SectionHeader, SelectField } from './controls.js';

const DAYS = [
  { value: 1, label: 'Mo' }, { value: 2, label: 'Di' }, { value: 3, label: 'Mi' }, { value: 4, label: 'Do' },
  { value: 5, label: 'Fr' }, { value: 6, label: 'Sa' }, { value: 0, label: 'So' },
];
const WEEK_START: ReadonlyArray<{ value: WeekStart; label: string }> = [
  { value: 1, label: 'Montag' }, { value: 0, label: 'Sonntag' }, { value: 6, label: 'Samstag' },
];
const SLOTS = [5, 10, 15, 30, 60].map((m) => ({ value: m as 5 | 10 | 15 | 30 | 60, label: `${m} Minuten` }));
const REMINDERS = [
  { value: -1, label: 'Keine Erinnerung' }, { value: 0, label: 'Zu Beginn' }, { value: 5, label: '5 Minuten vorher' },
  { value: 10, label: '10 Minuten vorher' }, { value: 15, label: '15 Minuten vorher' }, { value: 30, label: '30 Minuten vorher' },
  { value: 60, label: '1 Stunde vorher' }, { value: 1440, label: '1 Tag vorher' },
];
const DURATIONS = [15, 30, 45, 60, 90, 120].map((m) => ({ value: m, label: m < 60 ? `${m} Minuten` : `${m / 60} Std.` }));
const HOURS = Array.from({ length: 48 }, (_, i) => {
  const v = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
  return { value: v, label: v };
});

function withCurrent<T extends string | number>(options: ReadonlyArray<{ value: T; label: string }>, current: T, label: string) {
  return options.some((o) => o.value === current) ? options : [...options, { value: current, label }];
}

export function CalendarSettings() {
  const cal = usePreferences((s) => s.prefs.calendar);
  const update = usePreferences((s) => s.update);
  // week numbers live in the older view store too (lib/preferences.ts bridge)
  const { calendarShowWeekNumbers, setCalendarShowWeekNumbers } = useUiPrefs();
  const toggleDay = (day: number) => {
    const next = cal.workDays.includes(day) ? cal.workDays.filter((d) => d !== day) : [...cal.workDays, day].sort();
    update({ calendar: { workDays: next } });
  };
  const reminder = cal.defaultReminderMinutes ?? -1;

  return (
    <section className="space-y-8">
      <SectionHeader title="Kalender" description="Arbeitszeit, Darstellung und Standardwerte für neue Termine." />

      <Group title="Arbeitszeit">
        <div role="group" aria-label="Arbeitstage" className="flex flex-wrap gap-2">
          {DAYS.map((d) => (
            <label key={d.value} className="flex items-center gap-1.5 text-sm text-fg cursor-pointer">
              <input type="checkbox" checked={cal.workDays.includes(d.value)} onChange={() => toggleDay(d.value)}
                className="rounded border-line-strong text-accent-fg focus:ring-accent-fg w-4 h-4" />
              {d.label}
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Beginn" value={cal.workStart} options={withCurrent(HOURS, cal.workStart, cal.workStart)}
            onChange={(workStart) => update({ calendar: { workStart } })} />
          <SelectField label="Ende" value={cal.workEnd} options={withCurrent(HOURS, cal.workEnd, cal.workEnd)}
            onChange={(workEnd) => update({ calendar: { workEnd } })} />
        </div>
      </Group>

      <Group title="Darstellung">
        <SelectField label="Erster Tag der Woche" value={cal.weekStart} options={WEEK_START}
          onChange={(weekStart) => update({ calendar: { weekStart } })} />
        <SelectField label="Zeitraster" value={cal.slotMinutes} options={SLOTS}
          onChange={(slotMinutes) => update({ calendar: { slotMinutes } })} />
        <CheckField label="Kalenderwochen anzeigen" checked={calendarShowWeekNumbers} onChange={setCalendarShowWeekNumbers} />
      </Group>

      <Group title="Neue Termine">
        <SelectField label="Standard-Erinnerung" value={reminder}
          options={withCurrent(REMINDERS, reminder, `${reminder} Minuten vorher`)}
          onChange={(v) => update({ calendar: { defaultReminderMinutes: v < 0 ? null : v } })}
          hint="Gilt für Termine, die Sie hier im Kalender anlegen." />
        <SelectField label="Standarddauer" value={cal.defaultEventMinutes}
          options={withCurrent(DURATIONS, cal.defaultEventMinutes, `${cal.defaultEventMinutes} Minuten`)}
          onChange={(defaultEventMinutes) => update({ calendar: { defaultEventMinutes } })} />
      </Group>
    </section>
  );
}
