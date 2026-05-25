import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import deLocale from '@fullcalendar/core/locales/de';
import enLocale from '@fullcalendar/core/locales/en-gb';
import esLocale from '@fullcalendar/core/locales/es';
import itLocale from '@fullcalendar/core/locales/it';
import type { DateSelectArg, EventClickArg } from '@fullcalendar/core';
import { api } from '../api/client.js';
import type { Calendar, CalendarEvent, Task } from '../api/types.js';
import { useUiPrefs } from '../store/ui.js';
import { useLanguageStore } from '../store/language.js';
import { useT } from '../i18n/useT.js';
import { CalendarSidebar } from '../components/CalendarSidebar.js';
import {
  CalendarToolbar,
  FILTER_DEFAULT,
  type CalendarView,
  type FilterKey,
} from '../components/CalendarToolbar.js';
import { ShareCalendarDialog } from '../components/ShareCalendarDialog.js';
import { EventEditDialog } from '../components/EventEditDialog.js';
import toast from 'react-hot-toast';

const LOCALE_MAP = { de: deLocale, en: enLocale, es: esLocale, it: itLocale };

/**
 * v3.18.27: EventEditDialog ersetzt das alte inline new-event Modal.
 * Doppelklick auf Event → Edit-Mode mit existingId; Datum-Select → Create-Mode.
 */
type EventDialogState =
  | null
  | { mode: 'create'; defaults: { calendarId?: string; dtStart?: string; dtEnd?: string; allDay?: boolean } }
  | { mode: 'edit'; eventId: string };

export function CalendarPage() {
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const { calendarShowWeekNumbers, hiddenCalendarIds } = useUiPrefs();
  const [eventDialog, setEventDialog] = useState<EventDialogState>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [view, setView] = useState<CalendarView>('dayGridMonth');
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  // v3.18.21: Filter-State auf der Page lifted, damit fcEvents tatsächlich gefiltert werden
  const [filters, setFilters] = useState<Record<FilterKey, boolean>>(() => ({ ...FILTER_DEFAULT }));
  const calendarRef = useRef<FullCalendar | null>(null);

  const changeView = (v: CalendarView) => {
    setView(v);
    const fcApi = calendarRef.current?.getApi();
    if (!fcApi) return;
    if (v === 'workWeek') fcApi.changeView('timeGridWeek');
    else if (v === 'split') return;
    else fcApi.changeView(v);
  };

  const handleSelectDate = (d: Date) => {
    setSelectedDate(d);
    calendarRef.current?.getApi()?.gotoDate(d);
  };

  // hiddenDays/locale memoizen, damit FullCalendar nicht bei jedem Re-Render neue Props bekommt
  const hiddenDays = useMemo(() => (view === 'workWeek' ? [0, 6] : []), [view]);
  const fcLocale = useMemo(() => LOCALE_MAP[lang] ?? deLocale, [lang]);

  const { data: calendars } = useQuery({
    queryKey: ['calendars'],
    queryFn: () => api.get<Calendar[]>('/calendar'),
    // v3.18.17: SSE-Push via useMailEvents() invalidiert den Cache live —
    // 60s-Polling als Sicherheits-Fallback (falls SSE-Verbindung tot ist)
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
  });

  const { data: events } = useQuery({
    queryKey: ['calendar-events'],
    queryFn: () => api.get<CalendarEvent[]>('/calendar/events?start=2020-01-01&end=2030-12-31'),
  });

  const { data: tasks } = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn: () => api.get<Task[]>('/tasks'),
  });

  // Default-Kalender für neue Events: bevorzugt eigener Default, dann erster eigener.
  // Geteilte READ-only Kalender niemals als Default verwenden.
  const defaultWritableCalId = useMemo(() => {
    const writable = (calendars ?? []).filter((c) => c.permission !== 'READ' && !c.shared);
    return writable.find((c) => c.isDefault)?.id ?? writable[0]?.id ?? '';
  }, [calendars]);

  // v3.18.27: Datum-Auswahl im FullCalendar → Create-Dialog
  const handleDateSelect = (info: DateSelectArg) => {
    setEventDialog({
      mode: 'create',
      defaults: {
        calendarId: defaultWritableCalId,
        dtStart: info.startStr,
        dtEnd: info.endStr,
        allDay: info.allDay,
      },
    });
  };

  // v3.18.27: Klick auf existierendes Event → Edit-Dialog (NICHT mehr Delete-Confirm).
  // Permission-Check macht der EventEditDialog selbst via canWrite-Flag im GET-Response.
  const handleEventClick = (info: EventClickArg) => {
    if (info.event.id.startsWith('task-')) {
      toast(`Aufgabe: ${info.event.title.replace(/^[✓📋] /, '')}`, { icon: '📋' });
      return;
    }
    setEventDialog({ mode: 'edit', eventId: info.event.id });
  };

  // v3.18.21: Aufgaben nur wenn Filter „Aufgaben" aktiv
  const taskEvents = !filters['Aufgaben'] ? [] : (tasks ?? [])
    .filter((t) => !!t.dueDate)
    .map((t) => ({
      id: `task-${t.id}`,
      title: (t.status === 'COMPLETED' ? '✓ ' : '📋 ') + t.subject,
      start: t.dueDate as string,
      allDay: true,
      backgroundColor: t.status === 'COMPLETED' ? '#9ca3af' : '#f59e0b',
      borderColor: 'transparent',
      textColor: '#ffffff',
      classNames: t.status === 'COMPLETED' ? ['opacity-60'] : [],
    }));

  const fcEvents = [
    ...(events ?? [])
      .filter((ev) => !hiddenCalendarIds.includes(ev.calendarId))
      .filter((ev) => {
        // v3.18.21: Filter anwenden
        const cal = calendars?.find((c) => c.id === ev.calendarId);
        if (!filters['Geteilte Kalender'] && cal?.shared) return false;
        if (!filters['Wiederholende Termine'] && ev.recurring) return false;
        if (!filters['Private Termine'] && ev.classification === 'PRIVATE') return false;
        if (!filters['Vertrauliche Termine'] && ev.classification === 'CONFIDENTIAL') return false;
        return true;
      })
      .map((ev) => {
        const cal = calendars?.find((c) => c.id === ev.calendarId);
        const isReadOnly = cal?.permission === 'READ';
        return {
          id: ev.id,
          title: ev.summary,
          start: ev.dtStart,
          end: ev.dtEnd,
          allDay: false,
          backgroundColor: cal?.color ?? '#0078D4',
          borderColor: 'transparent',
          // READ-Shares: per-event editable=false (verhindert Drag/Resize)
          editable: !isReadOnly,
          startEditable: !isReadOnly,
          durationEditable: !isReadOnly,
          extendedProps: { calendarId: ev.calendarId, isReadOnly },
        };
      }),
    ...taskEvents,
  ];

  return (
    <div className="flex flex-1 overflow-hidden">
      <CalendarSidebar
        calendars={calendars ?? []}
        selectedDate={selectedDate}
        onSelectDate={handleSelectDate}
      />

      {/* Hauptbereich: Toolbar + FullCalendar */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <CalendarToolbar
          view={view}
          onChangeView={changeView}
          onNewEvent={() => setEventDialog({
            mode: 'create',
            defaults: { calendarId: defaultWritableCalId },
          })}
          onShare={() => {
            const owned = (calendars ?? []).filter((c) => !c.shared);
            if (owned.length === 0) {
              toast.error('Du hast noch keinen eigenen Kalender zum Teilen');
              return;
            }
            setShareDialogOpen(true);
          }}
          onPrint={() => {
            // v3.18.21: Nur Kalender drucken (Sidebar, Toolbar, App-Chrome via
            // print:hidden in print.css ausgeblendet). class auf <html> setzen
            // damit FullCalendar full-width für den Print-Job rendert.
            document.documentElement.classList.add('coremail-printing');
            window.print();
            // Cleanup nach Print-Dialog (sowohl bei Abbruch als auch nach Druck)
            setTimeout(() => {
              document.documentElement.classList.remove('coremail-printing');
            }, 500);
          }}
          filters={filters}
          onFiltersChange={setFilters}
        />

        <div className="flex-1 overflow-auto p-4">
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            locale={fcLocale}
            weekNumbers={calendarShowWeekNumbers}
            weekNumberCalculation="ISO"
            weekText={t('cw_short')}
            firstDay={1}
            hiddenDays={hiddenDays}
            headerToolbar={{ left: 'prev,next today', center: 'title', right: '' }}
            events={fcEvents}
            selectable
            select={handleDateSelect}
            eventClick={handleEventClick}
            height="100%"
          />
        </div>
      </div>

      {/* New event dialog */}
      {/* v3.18.27: Outlook-Style Event-Dialog für Create & Edit */}
      {eventDialog && (
        <EventEditDialog
          eventId={eventDialog.mode === 'edit' ? eventDialog.eventId : null}
          defaults={eventDialog.mode === 'create' ? eventDialog.defaults : undefined}
          calendars={calendars ?? []}
          defaultWritableCalendarId={defaultWritableCalId}
          onClose={() => setEventDialog(null)}
        />
      )}

      {/* v3.18.18: Share-Dialog via Toolbar-Button („Kalender teilen") */}
      {shareDialogOpen && (() => {
        const owned = (calendars ?? []).filter((c) => !c.shared);
        const initial = owned.find((c) => c.isDefault) ?? owned[0];
        if (!initial) return null;
        return (
          <ShareCalendarDialog
            calendar={initial}
            ownedCalendars={owned}
            onClose={() => setShareDialogOpen(false)}
          />
        );
      })()}
    </div>
  );
}
