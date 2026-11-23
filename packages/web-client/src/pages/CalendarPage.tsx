import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PanelLeft, X } from 'lucide-react';
import { Modal } from '../components/Modal.js';
import { useShortcutHandlers } from '../hooks/useShortcuts.js';
import { useLayoutMode } from '../hooks/useLayoutMode.js';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import luxonPlugin from '@fullcalendar/luxon3';
import deLocale from '@fullcalendar/core/locales/de';
import enLocale from '@fullcalendar/core/locales/en-gb';
import esLocale from '@fullcalendar/core/locales/es';
import itLocale from '@fullcalendar/core/locales/it';
import type { DateSelectArg, DatesSetArg, EventClickArg } from '@fullcalendar/core';
import { api } from '../api/client.js';
import type { Calendar, CalendarEvent, Task } from '../api/types.js';
import { useUiPrefs } from '../store/ui.js';
import { useLanguageStore } from '../store/language.js';
import { useT } from '../i18n/useT.js';
import { CalendarSidebar } from '../components/CalendarSidebar.js';
import { CalendarNavBar } from '../components/calendar/CalendarNavBar.js';
import { PaneCard } from '../components/PaneCard.js';
import { FOLDER_PANE_CLASS } from '../lib/paneLayout.js';
import { parseAction, type CalendarAction } from '../lib/calendarToolbar.js';
import {
  CalendarToolbar,
  FILTER_DEFAULT,
  type CalendarView,
  type FilterKey,
} from '../components/CalendarToolbar.js';
import { ShareCalendarDialog } from '../components/ShareCalendarDialog.js';
import { EventEditDialog } from '../components/EventEditDialog.js';
import toast from 'react-hot-toast';
import { readableTextOn } from '../lib/readableText.js';
import { applyShowAsVars, showAsLook } from '../lib/calendarShowAs.js';
import { PageShell } from '../components/PageShell.js';
import { usePreferences, useRegional } from '../store/preferences.js';
import { calendarTimeZone, eventFetchRange, localDay } from '../lib/zonedTime.js';
import { businessHours, defaultWritableCalendarId, hiddenDaysForWorkWeek, slotDuration } from '../lib/calendarPrefs.js';
import { calendarEventPath, calendarOccurrencePath, itemIdFromPath, occurrenceFromSearch } from '../lib/mailLinks.js';
import { DayAgenda } from '../components/calendar/DayAgenda.js';
import { OccurrenceChoice } from '../components/calendar/OccurrenceChoice.js';
import { SAFETY_REFETCH_MS } from '../lib/realtimeEvents.js';

const LOCALE_MAP = { de: deLocale, en: enLocale, es: esLocale, it: itLocale };

/**
 * v3.18.27: EventEditDialog replaces the old inline new-event modal.
 * Double-click on event → edit mode with existingId; date select → create mode.
 */
type EventDialogState =
  | null
  | { mode: 'create'; defaults: { calendarId?: string; dtStart?: string; dtEnd?: string; allDay?: boolean } }
  | { mode: 'edit'; eventId: string; occurrence: string | null };

export function CalendarPage() {
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const { calendarShowWeekNumbers, hiddenCalendarIds } = useUiPrefs();
  const [eventDialog, setEventDialog] = useState<EventDialogState>(null);
  // 9.4: Settings → Kalender (work week, week start, time grid)
  const calPrefs = usePreferences((s) => s.prefs.calendar);
  const updatePrefs = usePreferences((s) => s.update);
  // 9.4: the grid shows wall-clock times of the chosen zone (Settings → Region)
  const regionalTimeZone = useRegional().timeZone;
  const fcTimeZone = calendarTimeZone(regionalTimeZone);
  // 9.4: /calendar/event/<id> opens the event (shareable, back/forward)
  const location = useLocation();
  const navigate = useNavigate();
  const linkedEventId = itemIdFromPath(location.pathname, '/calendar/event/');
  // 9.4: ?occurrence= opens one occurrence of a series
  const linkedOccurrence = occurrenceFromSearch(location.search);
  useEffect(() => {
    if (linkedEventId) setEventDialog({ mode: 'edit', eventId: linkedEventId, occurrence: linkedOccurrence });
    else setEventDialog((d) => (d?.mode === 'edit' ? null : d));
  }, [linkedEventId, linkedOccurrence]);
  // 9.4: a click on an occurrence asks "only this one / the whole series"
  const [occurrenceChoice, setOccurrenceChoice] = useState<{ eventId: string; occurrence: string; summary: string } | null>(null);
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // 9.5: a phone starts in the day view (the month grid does not fit 320 px)
  const compactScreen = useLayoutMode() === 'single';
  const [calendarListOpen, setCalendarListOpen] = useState(false);
  // the sheet belongs to the phone layout: it does not reopen when the screen shrinks again
  useEffect(() => { if (!compactScreen) setCalendarListOpen(false); }, [compactScreen]);
  const [initialView] = useState<CalendarView>(() => (compactScreen ? 'timeGridDay' : 'dayGridMonth'));
  const [view, setView] = useState<CalendarView>(initialView);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  // v3.18.21: Filter state lifted to the page so fcEvents are actually filtered
  const [filters, setFilters] = useState<Record<FilterKey, boolean>>(() => ({ ...FILTER_DEFAULT }));
  const calendarRef = useRef<FullCalendar | null>(null);
  // Visible FullCalendar range — the server expands recurring events only inside it
  const [visibleRange, setVisibleRange] = useState<{ start: string; end: string } | null>(null);
  // Title of the visible range for the navigation row ("November 2026")
  const [gridTitle, setGridTitle] = useState('');
  const handleDatesSet = (arg: DatesSetArg) => {
    setGridTitle(arg.view.title);
    // widened: with a named zone FullCalendar hands out UTC-coerced dates
    const next = eventFetchRange(arg.start, arg.end);
    setVisibleRange((prev) => (prev && prev.start === next.start && prev.end === next.end ? prev : next));
  };

  const changeView = (v: CalendarView) => {
    setView(v);
    const fcApi = calendarRef.current?.getApi();
    if (!fcApi) return;
    if (v === 'workWeek') fcApi.changeView('timeGridWeek');
    else fcApi.changeView(v);
  };

  const handleSelectDate = (d: Date) => {
    setSelectedDate(d);
    calendarRef.current?.getApi()?.gotoDate(localDay(d));
  };

  // Keyboard shortcuts (both sets): c new event, t today, d / w / m views
  useShortcutHandlers({
    'calendar.new': () => {
      if (eventDialog) return false;
      setEventDialog({ mode: 'create', defaults: { calendarId: defaultWritableCalId } });
      return true;
    },
    'calendar.today': () => handleSelectDate(new Date()),
    'calendar.day': () => changeView('timeGridDay'),
    'calendar.week': () => changeView('timeGridWeek'),
    'calendar.month': () => changeView('dayGridMonth'),
  });

  // Memoize hiddenDays/locale so FullCalendar does not get new props on every re-render
  const hiddenDays = useMemo(() => (view === 'workWeek' ? hiddenDaysForWorkWeek(calPrefs.workDays) : []), [view, calPrefs.workDays]);
  const fcBusinessHours = useMemo(() => businessHours(calPrefs), [calPrefs]);
  const fcLocale = useMemo(() => LOCALE_MAP[lang] ?? deLocale, [lang]);

  const { data: calendars } = useQuery({
    queryKey: ['calendars'],
    queryFn: () => api.get<Calendar[]>('/calendar'),
    // 9.4: calendar events (hooks/useRealtime.ts) invalidate the cache live —
    // a long safety refetch covers a dead connection
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: SAFETY_REFETCH_MS,
  });

  const { data: events } = useQuery({
    queryKey: ['calendar-events', visibleRange?.start, visibleRange?.end],
    queryFn: () => api.get<CalendarEvent[]>(
      `/calendar/events?start=${encodeURIComponent(visibleRange!.start)}&end=${encodeURIComponent(visibleRange!.end)}`,
    ),
    enabled: visibleRange !== null,
    placeholderData: keepPreviousData,
  });

  const { data: tasks } = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn: () => api.get<Task[]>('/tasks'),
  });

  // Default calendar for new events: prefer own default, then the first own calendar.
  // Never use shared READ-only calendars as default.
  const defaultWritableCalId = useMemo(() => defaultWritableCalendarId(calendars ?? []), [calendars]);

  // v3.18.27: Date selection in FullCalendar → create dialog
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

  // v3.18.27: Click on existing event → edit dialog (NO LONGER delete confirm).
  // The permission check is done by EventEditDialog itself via the canWrite flag in the GET response.
  const handleEventClick = (info: EventClickArg) => {
    if (info.event.id.startsWith('task-')) {
      toast(`Aufgabe: ${info.event.title.replace(/^[✓📋] /, '')}`, { icon: '📋' });
      return;
    }
    const recurrenceId = info.event.extendedProps['recurrenceId'] as string | null | undefined;
    openEvent(info.event.id, recurrenceId ?? null, info.event.title);
  };

  const openEvent = (eventId: string, recurrenceId: string | null, summary: string) => {
    if (recurrenceId) setOccurrenceChoice({ eventId, occurrence: recurrenceId, summary });
    else navigate(calendarEventPath(eventId));
  };

  // v3.18.21: Tasks only when the "Aufgaben" (tasks) filter is active
  const taskEvents = !filters['Aufgaben'] ? [] : (tasks ?? [])
    .filter((t) => !!t.dueDate)
    .map((t) => ({
      id: `task-${t.id}`,
      title: (t.status === 'COMPLETED' ? '✓ ' : '📋 ') + t.subject,
      start: t.dueDate as string,
      allDay: true,
      backgroundColor: t.status === 'COMPLETED' ? '#9ca3af' : '#f59e0b',
      borderColor: 'transparent',
      textColor: readableTextOn(t.status === 'COMPLETED' ? '#9ca3af' : '#f59e0b'),
      classNames: t.status === 'COMPLETED' ? ['opacity-60'] : [],
    }));

  const fcEvents = [
    ...(events ?? [])
      .filter((ev) => !hiddenCalendarIds.includes(ev.calendarId))
      .filter((ev) => {
        // v3.18.21: Apply filters
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
        // All-day values are dates with an exclusive end — pass YYYY-MM-DD, never a
        // UTC instant, otherwise FullCalendar shifts them by the browser offset.
        const allDay = ev.allDay === true;
        const look = showAsLook(ev.showAs, cal?.color);
        return {
          id: ev.id,
          // Instances of a series share the series id (a click opens the master)
          ...(ev.recurrenceId ? { groupId: ev.id } : {}),
          title: ev.summary,
          start: allDay ? ev.dtStart.slice(0, 10) : ev.dtStart,
          end: allDay ? ev.dtEnd.slice(0, 10) : ev.dtEnd,
          allDay,
          // "Anzeigen als": BUSY solid (black/white text, >= 4.5:1), TENTATIVE striped,
          // FREE outlined, OOF purple — lib/calendarShowAs.ts + .cm-show-* in index.css
          backgroundColor: look.backgroundColor,
          textColor: look.textColor,
          borderColor: look.borderColor,
          classNames: look.classNames,
          // READ shares: per-event editable=false (prevents drag/resize)
          editable: !isReadOnly,
          startEditable: !isReadOnly,
          durationEditable: !isReadOnly,
          extendedProps: { calendarId: ev.calendarId, isReadOnly, recurrenceId: ev.recurrenceId ?? null, showAsVars: look.cssVars },
        };
      }),
    ...taskEvents,
  ];

  const ownedCalendars = (calendars ?? []).filter((c) => !c.shared);

  const shareCalendar = () => {
    if (ownedCalendars.length === 0) {
      toast.error('Du hast noch keinen eigenen Kalender zum Teilen');
      return;
    }
    setShareDialogOpen(true);
  };

  // v3.18.21: Print only the calendar (sidebar, toolbar, app chrome hidden via print:hidden
  // in print.css). The class on <html> lets FullCalendar render full-width for the print job.
  const printCalendar = () => {
    document.documentElement.classList.add('coremail-printing');
    window.print();
    // Cleanup after the print dialog (both on cancel and after printing)
    setTimeout(() => {
      document.documentElement.classList.remove('coremail-printing');
    }, 500);
  };

  const newEvent = () => setEventDialog({ mode: 'create', defaults: { calendarId: defaultWritableCalId } });

  /** One dispatcher for every toolbar command (lib/calendarToolbar.ts); the filter popover lives in the toolbar. */
  const runToolbarAction = (action: CalendarAction) => {
    const parsed = parseAction(action);
    if (parsed.kind === 'view') { changeView(parsed.view); return; }
    if (parsed.kind === 'slot') { updatePrefs({ calendar: { slotMinutes: parsed.minutes } }); return; }
    switch (parsed.action) {
      case 'new-event': newEvent(); break;
      case 'today': handleSelectDate(new Date()); break;
      case 'share': shareCalendar(); break;
      case 'print': printCalendar(); break;
      case 'agenda': setAgendaOpen((o) => !o); break;
      case 'settings': navigate('/settings#calendar'); break;
      case 'filter': break;
    }
  };

  const fcApi = () => calendarRef.current?.getApi();

  return (
    // 10.7: no ribbon — card 1: "Neuer Termin", mini calendar, calendar list; the grid card has its own toolbar row
    <PageShell title="Kalender" header={false} bodyCard={false} bodyClassName="md:gap-2">
      {!compactScreen && (
        <div className={`shrink-0 flex ${FOLDER_PANE_CLASS}`}>
          <CalendarSidebar
            calendars={calendars ?? []}
            selectedDate={selectedDate}
            onSelectDate={handleSelectDate}
            onNewEvent={newEvent}
          />
        </div>
      )}

      {/* Main area: toolbar row + FullCalendar in a card on the canvas */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-auto">
      <PaneCard label="Kalenderraster" className="flex-1 min-h-[26rem]">
        <CalendarNavBar
          title={gridTitle}
          selectedDate={selectedDate}
          onToday={() => handleSelectDate(new Date())}
          onPrev={() => fcApi()?.prev()}
          onNext={() => fcApi()?.next()}
          onJump={handleSelectDate}
          start={compactScreen ? (
            <button
              type="button"
              id="calendar-list-toggle"
              onClick={() => setCalendarListOpen(true)}
              aria-haspopup="dialog"
              aria-label="Kalender"
              title="Kalender"
              className="inline-flex items-center justify-center w-8 h-8 rounded text-accent-fg hover:bg-surface-2 shrink-0"
            >
              <PanelLeft size={16} aria-hidden="true" />
            </button>
          ) : undefined}
          end={(
            <CalendarToolbar
              view={view}
              filters={filters}
              onFiltersChange={setFilters}
              hasOwnCalendar={ownedCalendars.length > 0}
              slotMinutes={calPrefs.slotMinutes}
              agendaOpen={agendaOpen}
              compact={compactScreen}
              onAction={runToolbarAction}
            />
          )}
        />
        <div className="flex-1 min-h-0 p-2">
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, luxonPlugin]}
          timeZone={fcTimeZone}
          initialView={initialView === 'workWeek' ? 'timeGridWeek' : initialView}
          locale={fcLocale}
          weekNumbers={calendarShowWeekNumbers}
          weekNumberCalculation="ISO"
          weekText={t('cw_short')}
          firstDay={calPrefs.weekStart}
          businessHours={fcBusinessHours}
          slotDuration={slotDuration(calPrefs.slotMinutes)}
          scrollTime={`${calPrefs.workStart}:00`}
          hiddenDays={hiddenDays}
          headerToolbar={false}
          events={fcEvents}
          selectable
          select={handleDateSelect}
          datesSet={handleDatesSet}
          eventClick={handleEventClick}
          eventDidMount={(info) => applyShowAsVars(info.el, info.event.extendedProps['showAsVars'])}
          height="100%"
        />
        </div>
      </PaneCard>
      </div>

      {/* Phones: the calendar list is a sheet (Modal: focus trap, Escape, focus returns to the button) */}
      {compactScreen && calendarListOpen && (
        <Modal
          label="Kalender"
          onClose={() => setCalendarListOpen(false)}
          className="relative h-full w-72 max-w-[90%] bg-surface-2 shadow-xl overflow-y-auto"
          overlayClassName="fixed inset-0 z-50 flex justify-start bg-scrim/50"
        >
          <button
            type="button"
            onClick={() => setCalendarListOpen(false)}
            aria-label="Schließen"
            className="absolute right-2 top-2 z-10 p-1.5 rounded text-fg-subtle hover:bg-surface-3"
          >
            <X size={16} aria-hidden="true" />
          </button>
          <CalendarSidebar
            calendars={calendars ?? []}
            selectedDate={selectedDate}
            onSelectDate={(d) => { handleSelectDate(d); setCalendarListOpen(false); }}
            onNewEvent={() => { setCalendarListOpen(false); newEvent(); }}
          />
        </Modal>
      )}

      {/* 9.4: day agenda of the selected day */}
      {agendaOpen && (
        <DayAgenda
          date={selectedDate}
          events={(events ?? []).filter((ev) => !hiddenCalendarIds.includes(ev.calendarId))}
          calendars={calendars ?? []}
          timeZone={regionalTimeZone}
          onOpen={(ev) => openEvent(ev.id, ev.recurrenceId ?? null, ev.summary)}
          onClose={() => setAgendaOpen(false)}
        />
      )}

      {occurrenceChoice && (
        <OccurrenceChoice
          summary={occurrenceChoice.summary}
          onClose={() => setOccurrenceChoice(null)}
          onChoose={(scope) => {
            const { eventId, occurrence } = occurrenceChoice;
            setOccurrenceChoice(null);
            navigate(scope === 'occurrence' ? calendarOccurrencePath(eventId, occurrence) : calendarEventPath(eventId));
          }}
        />
      )}

      {/* New event dialog */}
      {/* v3.18.27: event dialog for create & edit */}
      {eventDialog && (
        <EventEditDialog
          key={eventDialog.mode === 'edit' ? `${eventDialog.eventId}:${eventDialog.occurrence ?? ''}` : 'new'}
          eventId={eventDialog.mode === 'edit' ? eventDialog.eventId : null}
          occurrence={eventDialog.mode === 'edit' ? eventDialog.occurrence : null}
          defaults={eventDialog.mode === 'create' ? eventDialog.defaults : undefined}
          calendars={calendars ?? []}
          defaultWritableCalendarId={defaultWritableCalId}
          onClose={() => (eventDialog.mode === 'edit' && linkedEventId ? navigate('/calendar') : setEventDialog(null))}
        />
      )}

      {/* v3.18.18: Share dialog via toolbar button ("Share calendar") */}
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

    </PageShell>
  );
}
