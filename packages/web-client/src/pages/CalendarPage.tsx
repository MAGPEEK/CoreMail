import { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import deLocale from '@fullcalendar/core/locales/de';
import enLocale from '@fullcalendar/core/locales/en-gb';
import esLocale from '@fullcalendar/core/locales/es';
import itLocale from '@fullcalendar/core/locales/it';
import type { DateSelectArg, EventClickArg } from '@fullcalendar/core';
import { X } from 'lucide-react';
import { api } from '../api/client.js';
import type { Calendar, CalendarEvent } from '../api/types.js';
import { useUiPrefs } from '../store/ui.js';
import { useLanguageStore } from '../store/language.js';
import { useT } from '../i18n/useT.js';
import { CalendarSidebar } from '../components/CalendarSidebar.js';
import { CalendarToolbar, type CalendarView } from '../components/CalendarToolbar.js';
import toast from 'react-hot-toast';

const LOCALE_MAP = { de: deLocale, en: enLocale, es: esLocale, it: itLocale };

interface NewEventForm {
  summary: string;
  dtStart: string;
  dtEnd: string;
  calendarId: string;
  allDay: boolean;
}

export function CalendarPage() {
  const qc = useQueryClient();
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const { calendarShowWeekNumbers, hiddenCalendarIds } = useUiPrefs();
  const [newEvent, setNewEvent] = useState<NewEventForm | null>(null);
  const [view, setView] = useState<CalendarView>('dayGridMonth');
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
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
  });

  const { data: events } = useQuery({
    queryKey: ['calendar-events'],
    queryFn: () => api.get<CalendarEvent[]>('/calendar/events?start=2020-01-01&end=2030-12-31'),
  });

  const createMutation = useMutation({
    mutationFn: (data: NewEventForm) => api.post('/calendar/events', data),
    onSuccess: () => {
      toast.success('Termin erstellt');
      qc.invalidateQueries({ queryKey: ['calendar-events'] });
      setNewEvent(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/calendar/events/${id}`),
    onSuccess: () => {
      toast.success('Termin gelöscht');
      qc.invalidateQueries({ queryKey: ['calendar-events'] });
    },
  });

  const handleDateSelect = (info: DateSelectArg) => {
    const calId = calendars?.[0]?.id ?? '';
    setNewEvent({
      summary: '',
      dtStart: info.startStr,
      dtEnd: info.endStr,
      calendarId: calId,
      allDay: info.allDay,
    });
  };

  const handleEventClick = (info: EventClickArg) => {
    if (confirm(`Termin "${info.event.title}" löschen?`)) {
      deleteMutation.mutate(info.event.id);
    }
  };

  const fcEvents = (events ?? [])
    .filter((ev) => !hiddenCalendarIds.includes(ev.calendarId))
    .map((ev) => ({
      id: ev.id,
      title: ev.summary,
      start: ev.dtStart,
      end: ev.dtEnd,
      allDay: false,
      backgroundColor: calendars?.find((c) => c.id === ev.calendarId)?.color ?? '#0078D4',
      borderColor: 'transparent',
    }));

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
          onNewEvent={() => setNewEvent({
            summary: '',
            dtStart: '',
            dtEnd: '',
            calendarId: calendars?.[0]?.id ?? '',
            allDay: false,
          })}
          onShare={() => toast('Kalender teilen kommt bald', { icon: 'ℹ️' })}
          onPrint={() => window.print()}
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
      {newEvent && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Neuer Termin</h2>
              <button onClick={() => setNewEvent(null)} className="btn-ghost p-1"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Titel</label>
                <input className="input" value={newEvent.summary}
                  onChange={(e) => setNewEvent({ ...newEvent, summary: e.target.value })} placeholder="Terminbezeichnung" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Von</label>
                  <input type="datetime-local" className="input" value={newEvent.dtStart.slice(0, 16)}
                    onChange={(e) => setNewEvent({ ...newEvent, dtStart: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Bis</label>
                  <input type="datetime-local" className="input" value={newEvent.dtEnd.slice(0, 16)}
                    onChange={(e) => setNewEvent({ ...newEvent, dtEnd: e.target.value })} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Kalender</label>
                <select className="input" value={newEvent.calendarId}
                  onChange={(e) => setNewEvent({ ...newEvent, calendarId: e.target.value })}>
                  {(calendars ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setNewEvent(null)} className="btn-secondary">Abbrechen</button>
              <button
                onClick={() => createMutation.mutate(newEvent)}
                disabled={!newEvent.summary || !newEvent.dtStart || createMutation.isPending}
                className="btn-primary disabled:opacity-50"
              >
                {createMutation.isPending ? 'Speichern...' : 'Speichern'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
