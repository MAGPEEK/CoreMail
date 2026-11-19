/**
 * Navigation row above the calendar grid: "Heute", previous / next and the month/year
 * label, which opens a date picker (MiniCalendar) to jump to any date.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { MiniCalendar } from '../MiniCalendar.js';

interface Props {
  /** FullCalendar's title of the visible range ("November 2026"). */
  title: string;
  selectedDate: Date;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onJump: (d: Date) => void;
}

const NAV_BTN = 'inline-flex items-center justify-center min-h-8 min-w-8 rounded text-fg-muted hover:bg-surface-2 hover:text-fg';

export function CalendarNavBar({ title, selectedDate, onToday, onPrev, onNext, onJump }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const labelRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setPickerOpen(false);
    labelRef.current?.focus();
  };

  useEffect(() => {
    if (!pickerOpen) return;
    pickerRef.current?.querySelector<HTMLElement>('button')?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pickerRef.current?.contains(t) && !labelRef.current?.contains(t)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  return (
    <div role="group" aria-label="Kalendernavigation" className="relative flex items-center gap-1 px-3 py-2 border-b border-line coremail-no-print">
      <button type="button" onClick={onToday} className="min-h-8 px-3 rounded border border-line text-sm font-medium text-fg hover:bg-surface-2">
        Heute
      </button>
      <button type="button" onClick={onPrev} aria-label="Zurück" className={NAV_BTN}><ChevronLeft size={18} aria-hidden="true" /></button>
      <button type="button" onClick={onNext} aria-label="Weiter" className={NAV_BTN}><ChevronRight size={18} aria-hidden="true" /></button>
      <button
        ref={labelRef}
        type="button"
        onClick={() => setPickerOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        className="ml-1 min-h-8 px-2 rounded text-base font-semibold text-fg hover:bg-surface-2"
      >
        {title}
      </button>
      {pickerOpen && (
        <div
          ref={pickerRef}
          role="dialog"
          aria-label="Datum wählen"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
          className="absolute left-3 top-full z-30 mt-1 w-60 pt-2 rounded-lg border border-line bg-surface shadow-xl"
        >
          <MiniCalendar selectedDate={selectedDate} onSelectDate={(d) => { onJump(d); close(); }} />
        </div>
      )}
    </div>
  );
}
