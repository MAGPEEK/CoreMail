import { X } from 'lucide-react';
import type { Calendar, CalendarEvent } from '../../api/types.js';
import { instantToWallClock, localDay } from '../../lib/zonedTime.js';
import { PANE_CARD_CLASS } from '../../lib/paneLayout.js';
import { showAsBarStyle } from '../../lib/calendarShowAs.js';

/**
 * 9.4: day agenda side panel of the calendar — the events of the selected day
 * (all-day first, then by start time) next to the grid.
 */
interface Props {
  date: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  timeZone: string;
  onOpen: (ev: CalendarEvent) => void;
  onClose: () => void;
}

const SHOW_AS_LABEL: Record<string, string> = { FREE: 'Frei', TENTATIVE: 'Mit Vorbehalt', OOF: 'Abwesend' };

export function DayAgenda({ date, events, calendars, timeZone, onOpen, onClose }: Props) {
  const day = localDay(date);
  const onDay = events
    .filter((ev) => {
      if (ev.allDay) return ev.dtStart.slice(0, 10) <= day && ev.dtEnd.slice(0, 10) > day;
      const s = instantToWallClock(ev.dtStart, timeZone).date;
      const e = instantToWallClock(new Date(new Date(ev.dtEnd).getTime() - 1).toISOString(), timeZone).date;
      return s <= day && e >= day;
    })
    .sort((a, b) => (a.allDay === b.allDay ? a.dtStart.localeCompare(b.dtStart) : a.allDay ? -1 : 1));
  const heading = date.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <aside aria-label="Tagesagenda" className={`w-64 shrink-0 flex flex-col min-h-0 max-md:border-l ${PANE_CARD_CLASS}`}>
      <div className="px-3 py-2 border-b border-line flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">{heading}</h2>
        <button type="button" onClick={onClose} aria-label="Tagesagenda schließen" className="p-1 rounded text-fg-subtle hover:bg-surface-2">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <ul className="flex-1 overflow-y-auto p-2 space-y-1">
        {onDay.length === 0 && <li className="text-xs text-fg-subtle px-1 py-2">Keine Termine an diesem Tag.</li>}
        {onDay.map((ev) => {
          const cal = calendars.find((c) => c.id === ev.calendarId);
          const time = ev.allDay
            ? 'Ganztägig'
            : `${instantToWallClock(ev.dtStart, timeZone).time}–${instantToWallClock(ev.dtEnd, timeZone).time}`;
          return (
            <li key={ev.instanceId ?? ev.id}>
              <button type="button" onClick={() => onOpen(ev)} className="w-full text-left flex gap-2 px-2 py-1.5 rounded hover:bg-surface-2">
                <span className="w-1 self-stretch rounded-full shrink-0" style={showAsBarStyle(ev.showAs, cal?.color)} />
                <span className="min-w-0">
                  <span className="block text-xs text-fg-subtle">{time}{ev.showAs && SHOW_AS_LABEL[ev.showAs] ? ` · ${SHOW_AS_LABEL[ev.showAs]}` : ''}</span>
                  <span className="block text-sm text-fg truncate">{ev.summary}</span>
                  {ev.location && <span className="block text-xs text-fg-subtle truncate">{ev.location}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
