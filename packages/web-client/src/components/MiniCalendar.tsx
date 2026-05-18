import { useState, useMemo } from 'react';
import {
  addMonths, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachDayOfInterval, isSameMonth, isSameDay, format, getISOWeek,
} from 'date-fns';
import { de as deLocale } from 'date-fns/locale';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useUiPrefs } from '../store/ui.js';

interface Props {
  /** aktuell im Hauptkalender markierter Tag */
  selectedDate: Date;
  /** Klick auf Tag — navigiert Hauptkalender zum Datum */
  onSelectDate: (d: Date) => void;
}

export function MiniCalendar({ selectedDate, onSelectDate }: Props) {
  const [cursor, setCursor] = useState<Date>(selectedDate);
  const { calendarShowWeekNumbers } = useUiPrefs();

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 });
    const end   = endOfWeek(endOfMonth(cursor),     { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [cursor]);

  // 6 Zeilen × 7 Tage = 42 Felder; days kann manchmal 35 sein
  const weeks = useMemo(() => {
    const out: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) out.push(days.slice(i, i + 7));
    return out;
  }, [days]);

  const today = new Date();

  return (
    <div className="px-2 pb-3">
      {/* Header: Monat + Navigation */}
      <div className="flex items-center justify-between px-1 mb-2">
        <button
          onClick={() => setCursor(new Date())}
          className="text-sm font-semibold text-gray-900 dark:text-gray-100 hover:text-accent transition-colors"
          title="Heute"
        >
          {format(cursor, 'MMMM yyyy', { locale: deLocale })}
        </button>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setCursor(addMonths(cursor, -1))}
            className="p-1 rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-150 active:scale-90"
            aria-label="Vorheriger Monat"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => setCursor(addMonths(cursor, 1))}
            className="p-1 rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-150 active:scale-90"
            aria-label="Nächster Monat"
          >
            <ChevronDown size={14} />
          </button>
        </div>
      </div>

      {/* Tage-Header */}
      <div
        className="grid gap-0 text-[10px] font-medium text-gray-400 dark:text-gray-500 px-0.5"
        style={{ gridTemplateColumns: calendarShowWeekNumbers ? '0.7fr repeat(7, 1fr)' : 'repeat(7, 1fr)' }}
      >
        {calendarShowWeekNumbers && <div className="text-center" />}
        {['M', 'D', 'M', 'D', 'F', 'S', 'S'].map((d, i) => (
          <div key={i} className="text-center py-1">{d}</div>
        ))}
      </div>

      {/* Wochen */}
      <div
        className="grid gap-0 text-xs"
        style={{ gridTemplateColumns: calendarShowWeekNumbers ? '0.7fr repeat(7, 1fr)' : 'repeat(7, 1fr)' }}
      >
        {weeks.map((week, wi) => (
          <div key={wi} className="contents">
            {/* KW-Spalte */}
            {calendarShowWeekNumbers && (
              <div className="flex items-center justify-center text-[10px] text-gray-400 dark:text-gray-500 py-1">
                {getISOWeek(week[0]!)}
              </div>
            )}
            {/* 7 Tage */}
            {week.map((d) => {
              const inMonth = isSameMonth(d, cursor);
              const isToday = isSameDay(d, today);
              const isSelected = isSameDay(d, selectedDate);
              return (
                <button
                  key={d.toISOString()}
                  onClick={() => onSelectDate(d)}
                  className={`aspect-square flex items-center justify-center rounded-full text-[11px] transition-all duration-150 active:scale-90 ${
                    isSelected
                      ? 'bg-accent text-white font-semibold shadow-sm'
                      : isToday
                        ? 'ring-1 ring-accent text-accent font-semibold'
                        : inMonth
                          ? 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800'
                          : 'text-gray-300 dark:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                  }`}
                >
                  {format(d, 'd')}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
