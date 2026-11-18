import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Save, Trash2, X, Users, Clock, MapPin, Eye, AlignLeft, Bell, CalendarClock,
  CheckCircle2, XCircle, HelpCircle, Calendar as CalendarIcon, Loader2, RefreshCw,
} from 'lucide-react';
import { Modal } from './Modal.js';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { Calendar, CalendarEvent, EventAttendee, RoomAvailability, ShowAs } from '../api/types.js';
import { currentPreferences, usePreferences, useRegional } from '../store/preferences.js';
import { instantToWallClock, wallClockToInstant } from '../lib/zonedTime.js';
import { useOwnEmail } from '../hooks/useOwnEmail.js';
import { RecurrenceField } from './calendar/RecurrenceField.js';
import { RoomPicker } from './calendar/RoomPicker.js';
import { SchedulingAssistant } from './calendar/SchedulingAssistant.js';

/**
 * Event dialog of the calendar (create & edit).
 *
 *  - Title, attendees (live PARTSTAT badge), date + time, location, rooms, notes,
 *    classification (private), "Anzeigen als", reminder (+ per e-mail), recurrence
 *  - 9.4: tab "Terminplanungs-Assistent" — attendees' free/busy for the day and
 *    suggested times; adding attendees turns the appointment into a meeting
 *    (invitations are sent by the server)
 *  - 9.4: `occurrence` edits one occurrence of a series (only its own fields);
 *    delete removes only that occurrence
 *  - Edit mode loads GET /calendar/events/:id (with canWrite flag)
 */

interface AttendeeSuggest {
  id: string;
  displayName: string;
  email: string;
}

interface Props {
  /** null = new event, otherwise event ID for edit mode */
  eventId: string | null;
  /** 9.4: original start (ISO) of the occurrence to edit; absent = the whole event / series */
  occurrence?: string | null;
  /** Default values for create mode */
  defaults?: {
    calendarId?: string;
    dtStart?: string; // ISO
    dtEnd?: string;   // ISO
    allDay?: boolean;
  };
  /** List of available calendars (for picker) */
  calendars: Calendar[];
  /** Default calendar for create when defaults.calendarId is missing */
  defaultWritableCalendarId: string;
  onClose: () => void;
}

// ─── Time picker options (every 15 min) ──────────────────────────────────────
const TIME_OPTIONS: string[] = (() => {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return out;
})();

const PARTSTAT_BADGE: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  ACCEPTED:       { icon: <CheckCircle2 size={12} />, color: 'text-success-fg bg-success-bg', label: 'Zugesagt' },
  DECLINED:       { icon: <XCircle size={12} />,      color: 'text-danger-fg bg-danger-bg',       label: 'Abgesagt' },
  TENTATIVE:      { icon: <HelpCircle size={12} />,   color: 'text-warning-fg bg-warning-bg', label: 'Vielleicht' },
  'NEEDS-ACTION': { icon: <Clock size={12} />,        color: 'text-fg-subtle bg-surface-2',      label: 'Wartet' },
};

// 9.4: "Anzeigen als" and reminder choices
const SHOW_AS: Array<[ShowAs, string]> = [['FREE', 'Frei'], ['TENTATIVE', 'Mit Vorbehalt'], ['BUSY', 'Gebucht'], ['OOF', 'Abwesend']];
const REMINDERS: Array<[number, string]> = [
  [0, 'Zum Beginn'], [5, '5 Minuten vorher'], [15, '15 Minuten vorher'], [30, '30 Minuten vorher'],
  [60, '1 Stunde vorher'], [120, '2 Stunden vorher'], [1440, '1 Tag vorher'], [2880, '2 Tage vorher'], [10080, '1 Woche vorher'],
];
const NO_REMINDER = 'none';

const isRoom = (a: EventAttendee) => a.cutype === 'ROOM' || a.cutype === 'RESOURCE';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar arithmetic on `YYYY-MM-DD` strings — no timezone involved. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/**
 * All-day range from the API / FullCalendar (`YYYY-MM-DD…`, exclusive end) →
 * dialog values (inclusive last day, as shown to the user).
 */
function allDayToParts(start: string, endExclusive: string): { startDate: string; endDate: string } {
  const startDate = start.slice(0, 10);
  const last = addDays(endExclusive.slice(0, 10), -1);
  return { startDate, endDate: last < startDate ? startDate : last };
}

/** 9.4: date + time fields show the wall clock of the user's zone (Settings → Region, '' = browser). */
function isoToParts(iso: string, timeZone: string): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  // Date-only values must not go through Date (would be parsed as UTC midnight)
  if (DATE_ONLY_RE.test(iso)) return { date: iso, time: '' };
  return instantToWallClock(iso, timeZone);
}

function partsToIso(date: string, time: string, timeZone: string): string {
  return date ? wallClockToInstant(date, time || '00:00', timeZone) : '';
}

function addMinutes(iso: string, mins: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + mins);
  return d.toISOString();
}

const inputCls = 'border border-line-strong rounded px-2 py-1.5 text-sm bg-surface focus:outline-none focus:ring-1 focus:ring-accent-fg disabled:opacity-60';

// ─── Component ───────────────────────────────────────────────────────────────
export function EventEditDialog({
  eventId, occurrence = null, defaults, calendars, defaultWritableCalendarId, onClose,
}: Props) {
  const qc = useQueryClient();
  const isEdit = eventId !== null;
  const isOccurrence = isEdit && !!occurrence;
  const timeZone = useRegional().timeZone;
  const calPrefs = usePreferences((s) => s.prefs.calendar);
  const ownEmail = useOwnEmail();
  const occurrenceQuery = occurrence ? `?occurrence=${encodeURIComponent(occurrence)}` : '';

  // Edit mode: load event detail
  const { data: existing, isLoading: existingLoading, refetch: refetchEvent } = useQuery<CalendarEvent>({
    queryKey: ['event', eventId, occurrence],
    queryFn: () => api.get<CalendarEvent>(`/calendar/events/${eventId}${occurrenceQuery}`),
    enabled: isEdit,
    staleTime: 0,
  });

  // Form-State
  const [tab, setTab]                 = useState<'details' | 'scheduling'>('details');
  const [summary, setSummary]         = useState('');
  const [calendarId, setCalendarId]   = useState(defaultWritableCalendarId);
  const [startDate, setStartDate]     = useState('');
  const [startTime, setStartTime]     = useState('09:00');
  const [endDate, setEndDate]         = useState('');
  const [endTime, setEndTime]         = useState('10:00');
  const [allDay, setAllDay]           = useState(false);
  const [location, setLocation]       = useState('');
  const [description, setDescription] = useState('');
  const [classification, setClassification] = useState<'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL'>('PUBLIC');
  const [attendees, setAttendees]     = useState<EventAttendee[]>([]);
  const [attendeeInput, setAttendeeInput] = useState('');
  const [showAs, setShowAs]           = useState<ShowAs>('BUSY');
  const [reminderMinutes, setReminderMinutes] = useState<number | null>(null);
  const [reminderByMail, setReminderByMail]   = useState(false);
  const [rrule, setRrule]             = useState<string | null>(null);
  const [rooms, setRooms]             = useState<Array<{ email: string; displayName: string }>>([]);

  // Initialize form with existing or defaults — only once per open
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    if (isEdit) {
      if (!existing) return;
      initialized.current = true;
      setSummary(existing.summary ?? '');
      setCalendarId(existing.calendarId);
      if (existing.allDay) {
        const r = allDayToParts(existing.dtStart, existing.dtEnd);
        setStartDate(r.startDate);
        setEndDate(r.endDate);
      } else {
        const s = isoToParts(existing.dtStart, timeZone);
        const e = isoToParts(existing.dtEnd, timeZone);
        setStartDate(s.date); setStartTime(s.time);
        setEndDate(e.date); setEndTime(e.time);
      }
      setAllDay(existing.allDay ?? false);
      setLocation(existing.location ?? '');
      setDescription(existing.description ?? '');
      setClassification(existing.classification ?? 'PUBLIC');
      const all = existing.attendees ?? [];
      setAttendees(all.filter((a) => !isRoom(a)));
      setRooms(all.filter(isRoom).map((a) => ({ email: a.email, displayName: a.cn ?? a.email })));
      setShowAs(existing.showAs ?? 'BUSY');
      setReminderMinutes(existing.reminderMinutes ?? null);
      setReminderByMail(existing.reminderByMail ?? false);
      setRrule(existing.rrule ?? null);
    } else {
      initialized.current = true;
      setCalendarId(defaults?.calendarId ?? defaultWritableCalendarId);
      if (defaults?.allDay && defaults.dtStart && defaults.dtEnd) {
        // FullCalendar all-day selection: date strings with an exclusive end
        const r = allDayToParts(defaults.dtStart, defaults.dtEnd);
        setStartDate(r.startDate);
        setEndDate(r.endDate);
      } else {
        const start = defaults?.dtStart ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
        // 9.4: default meeting duration (Settings → Kalender)
        const end = defaults?.dtEnd ?? addMinutes(start, currentPreferences().calendar.defaultEventMinutes);
        const s = isoToParts(start, timeZone);
        const e = isoToParts(end, timeZone);
        setStartDate(s.date); if (s.time) setStartTime(s.time);
        setEndDate(e.date); if (e.time) setEndTime(e.time);
      }
      setAllDay(defaults?.allDay ?? false);
      setReminderMinutes(currentPreferences().calendar.defaultReminderMinutes);
    }
  }, [isEdit, existing, defaults, defaultWritableCalendarId, timeZone]);

  // ─── Attendee-Autocomplete ──────────────────────────────────────────────────
  const [debouncedQ, setDebouncedQ] = useState('');
  const [showSug, setShowSug] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: suggestionsRaw = [] } = useQuery<AttendeeSuggest[]>({
    queryKey: ['contact-suggest-event', debouncedQ],
    queryFn: () => api.get<AttendeeSuggest[]>(`/contacts?q=${encodeURIComponent(debouncedQ)}`),
    enabled: debouncedQ.length >= 1,
    staleTime: 30_000,
  });

  const assignedEmails = new Set(attendees.map((a) => a.email.toLowerCase()));
  const suggestions = suggestionsRaw
    .filter((s) => !assignedEmails.has(s.email.toLowerCase()))
    .slice(0, 8);

  const onAttendeeInputChange = (v: string) => {
    setAttendeeInput(v);
    setActiveIdx(0);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (v.length >= 1) {
      setShowSug(true);
      debounceTimer.current = setTimeout(() => setDebouncedQ(v), 220);
    } else {
      setShowSug(false);
      setDebouncedQ('');
    }
  };

  const addAttendee = useCallback((email: string, cn?: string) => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) return;
    if (assignedEmails.has(trimmed)) return;
    setAttendees((prev) => [...prev, { email: trimmed, cn: cn ?? trimmed, partstat: 'NEEDS-ACTION', rsvp: true }]);
    setAttendeeInput('');
    setDebouncedQ('');
    setShowSug(false);
  }, [assignedEmails]);

  const onAttendeeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && attendeeInput.includes('@'))) {
      e.preventDefault();
      if (showSug && suggestions[activeIdx]) {
        const s = suggestions[activeIdx];
        addAttendee(s.email, s.displayName);
      } else if (attendeeInput.includes('@')) {
        addAttendee(attendeeInput);
      }
    } else if (e.key === 'ArrowDown' && showSug && suggestions.length > 0) {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && showSug && suggestions.length > 0) {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // close only the suggestions, not the dialog
      setShowSug(false);
    }
  };

  const removeAttendee = (email: string) => {
    setAttendees((prev) => prev.filter((a) => a.email !== email));
  };

  // 9.4: a room added to the meeting fills an empty location
  const toggleRoom = (room: RoomAvailability, add: boolean) => {
    setRooms((prev) => (add
      ? [...prev.filter((r) => r.email !== room.email), { email: room.email, displayName: room.displayName }]
      : prev.filter((r) => r.email.toLowerCase() !== room.email.toLowerCase())));
    if (add && !location.trim()) setLocation(room.displayName);
  };

  // ─── Save Mutations ─────────────────────────────────────────────────────────
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['calendar-events'] });
    void qc.invalidateQueries({ queryKey: ['event', eventId] });
  };
  const createMut = useMutation({
    mutationFn: (body: object) => api.post('/calendar/events', body),
    onSuccess: () => {
      toast.success(attendees.length > 0 ? 'Besprechung erstellt, Einladungen werden gesendet' : 'Termin erstellt');
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMut = useMutation({
    mutationFn: (body: object) => api.put(`/calendar/events/${eventId}${occurrenceQuery}`, body),
    onSuccess: () => {
      toast.success(isOccurrence ? 'Dieses Ereignis wurde gespeichert' : 'Termin gespeichert');
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/calendar/events/${eventId}${occurrenceQuery}`),
    onSuccess: () => {
      toast.success(isOccurrence ? 'Ereignis aus der Serie gelöscht' : 'Termin gelöscht');
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSave = summary.trim().length > 0 && !!startDate && !!endDate &&
                   calendarId && (existing?.canWrite !== false || !isEdit);

  // All-day: plain dates, end EXCLUSIVE (last shown day + 1) — no UTC round-trip.
  const dtStart = allDay ? startDate : partsToIso(startDate, startTime, timeZone);
  const dtEnd   = allDay ? addDays(endDate < startDate ? startDate : endDate, 1) : partsToIso(endDate, endTime, timeZone);
  // instants of the slot for rooms and the scheduling assistant
  const slotStart = allDay ? wallClockToInstant(startDate, '00:00', timeZone) : dtStart;
  const slotEnd = allDay ? wallClockToInstant(dtEnd, '00:00', timeZone) : dtEnd;

  const handleSave = () => {
    const common = { summary: summary.trim(), dtStart, dtEnd, allDay, description, location, classification, showAs };
    if (isOccurrence) { updateMut.mutate(common); return; }
    const body = {
      ...common,
      calendarId,
      reminderMinutes,
      reminderByMail: reminderMinutes !== null && reminderByMail,
      rrule: rrule ?? null,
      rooms: rooms.map((r) => r.email),
      attendees: attendees.map((a) => ({
        email: a.email,
        ...(a.cn ? { cn: a.cn } : {}),
        ...(a.partstat ? { partstat: a.partstat } : {}),
      })),
    };
    if (isEdit) updateMut.mutate(body);
    else createMut.mutate(body);
  };

  // Pick a suggested time in the scheduling assistant
  const pickSlot = (startIso: string, endIso: string) => {
    const s = instantToWallClock(startIso, timeZone);
    const e = instantToWallClock(endIso, timeZone);
    setAllDay(false);
    setStartDate(s.date); setStartTime(s.time);
    setEndDate(e.date); setEndTime(e.time);
    setTab('details');
  };

  // v3.18.28 FIX: useMemo MUST be called before every `return` — otherwise
  // the hook order changes between renders → React crash → white
  // page. Hence all hooks moved to the top and the loading `return` AFTER the hooks.
  const readOnly = isEdit && existing?.canWrite === false;
  const currentCal = useMemo(() => calendars.find((c) => c.id === calendarId), [calendars, calendarId]);
  const roomAnswers = (existing?.attendees ?? []).filter(isRoom);
  const title = isOccurrence ? 'Ereignis der Serie bearbeiten' : isEdit ? 'Termin bearbeiten' : attendees.length > 0 ? 'Neue Besprechung' : 'Neuer Termin';

  // Loading spinner for edit mode during GET
  if (isEdit && existingLoading) {
    return (
      <div className="fixed inset-0 bg-scrim/40 flex items-center justify-center z-50">
        <div className="bg-surface rounded-lg shadow-xl p-8 text-center">
          <Loader2 size={28} className="animate-spin mx-auto text-accent-fg" />
          <p className="text-sm text-fg-subtle mt-3">Termin wird geladen…</p>
        </div>
      </div>
    );
  }

  const tabCls = (on: boolean) => `px-3 py-2 text-sm border-b-2 -mb-px ${on ? 'border-accent-fg text-accent-fg font-medium' : 'border-transparent text-fg-muted hover:text-fg'}`;

  return (
    <Modal
      onClose={onClose}
      label={title}
      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 bg-scrim/40 flex items-center justify-center z-50 p-4"
      className="bg-surface rounded-lg shadow-xl w-full max-w-3xl max-h-[92vh] flex flex-col"
    >

        {/* Header — title + refresh + close */}
        <div className="px-5 py-3 border-b border-line flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg-muted">{title}</h2>
          <div className="flex items-center gap-2">
            {readOnly && (
              <span className="text-xs text-warning-fg bg-warning-bg px-2 py-1 rounded">
                Nur Lesezugriff
              </span>
            )}
            {isEdit && (
              <button aria-label="Status der Gäste aktualisieren"
                onClick={() => void refetchEvent()}
                className="p-1.5 text-fg-subtle hover:text-accent-fg hover:bg-accent/10 rounded"
                title="Status der Gäste aktualisieren"
              >
                <RefreshCw size={14} />
              </button>
            )}
            <button onClick={onClose} className="text-fg-subtle hover:text-fg-muted text-xl leading-none px-2" aria-label="Schließen">×</button>
          </div>
        </div>

        {/* 9.4: tabs — details / scheduling assistant (not for a single occurrence) */}
        {!isOccurrence && (
          <div role="tablist" aria-label="Ansicht" className="px-5 border-b border-line flex gap-1">
            <button role="tab" type="button" aria-selected={tab === 'details'} onClick={() => setTab('details')} className={tabCls(tab === 'details')}>Termin</button>
            <button role="tab" type="button" aria-selected={tab === 'scheduling'} onClick={() => setTab('scheduling')} className={tabCls(tab === 'scheduling')}>
              <span className="inline-flex items-center gap-1.5"><CalendarClock size={14} aria-hidden="true" />Terminplanungs-Assistent</span>
            </button>
          </div>
        )}

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {tab === 'scheduling' && !isOccurrence && (
            <SchedulingAssistant
              organizerEmail={existing?.organizer || ownEmail}
              attendees={attendees}
              rooms={rooms}
              startIso={slotStart}
              endIso={slotEnd}
              date={startDate}
              timeZone={timeZone}
              workStart={calPrefs.workStart}
              workEnd={calPrefs.workEnd}
              {...(existing?.uid ? { uid: existing.uid } : {})}
              onPick={pickSlot}
            />
          )}

          {tab === 'details' && <>
          {isOccurrence && (
            <p className="text-xs text-info-fg bg-info-bg rounded px-3 py-2">
              Änderungen gelten nur für dieses Ereignis. Wiederholung, Teilnehmer, Räume und Erinnerung gehören zur Serie.
            </p>
          )}

          {/* Calendar picker (own or writable only) */}
          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: currentCal?.color ?? '#0078D4' }} />
            <select
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
              disabled={isEdit || readOnly}
              aria-label="Kalender"
              className="text-xs bg-transparent border-0 text-fg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg rounded-sm disabled:opacity-50"
            >
              {calendars.filter((c) => isEdit ? true : c.permission !== 'READ').map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.shared ? ` (geteilt von ${c.ownerDisplayName ?? c.ownerEmail ?? '?'})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Title */}
          <div>
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Titel hinzufügen"
              aria-label="Titel"
              disabled={readOnly}
              className="w-full border-b-2 border-line-strong focus:border-accent-fg text-lg font-medium bg-transparent px-1 py-2 focus:outline-none placeholder:text-fg-subtle disabled:opacity-60"
            />
          </div>

          {/* Attendees */}
          {!isOccurrence && (
          <div>
            <div className="flex items-start gap-3">
              <Users size={18} className="text-fg-subtle mt-2 shrink-0" />
              <div className="flex-1 min-w-0">
                {attendees.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {attendees.map((a) => {
                      const badge = PARTSTAT_BADGE[a.partstat ?? 'NEEDS-ACTION']!;
                      return (
                        <div key={a.email} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 bg-surface-2 rounded text-xs">
                          <span className="font-medium text-fg truncate max-w-[160px]">
                            {a.cn && a.cn !== a.email ? `${a.cn}` : a.email}
                          </span>
                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${badge.color}`} title={badge.label}>
                            {badge.icon}
                          </span>
                          {!readOnly && (
                            <button aria-label={`Gast ${a.email} entfernen`} onClick={() => removeAttendee(a.email)} className="p-0.5 text-fg-subtle hover:text-danger-fg ml-0.5">
                              <X size={11} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {!readOnly && (
                  <div className="relative">
                    <input
                      type="text"
                      value={attendeeInput}
                      onChange={(e) => onAttendeeInputChange(e.target.value)}
                      onKeyDown={onAttendeeKeyDown}
                      onBlur={() => setTimeout(() => setShowSug(false), 150)}
                      aria-label="Teilnehmer einladen"
                      placeholder={attendees.length === 0 ? 'Erforderliche Teilnehmer einladen' : 'Weiteren Teilnehmer einladen…'}
                      className="w-full border-b border-line-strong focus:border-accent-fg bg-transparent px-1 py-1.5 text-sm focus:outline-none placeholder:text-fg-subtle"
                    />
                    {showSug && suggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full mt-1 bg-surface border border-line rounded shadow-lg z-10 max-h-60 overflow-y-auto">
                        {suggestions.map((s, idx) => (
                          <button
                            key={s.id}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); addAttendee(s.email, s.displayName); }}
                            onMouseEnter={() => setActiveIdx(idx)}
                            className={`w-full text-left px-3 py-2 text-sm ${idx === activeIdx ? 'bg-accent/10' : 'hover:bg-surface-2'}`}
                          >
                            <div className="font-medium text-fg truncate">{s.displayName}</div>
                            <div className="text-xs text-fg-subtle truncate">{s.email}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {attendees.length > 0 && (
                  <p className="text-[11px] text-fg-subtle mt-1">
                    {attendees.filter((a) => a.partstat === 'ACCEPTED').length} zugesagt ·
                    {' '}{attendees.filter((a) => a.partstat === 'DECLINED').length} abgesagt ·
                    {' '}{attendees.filter((a) => a.partstat === 'TENTATIVE').length} vielleicht ·
                    {' '}{attendees.filter((a) => !a.partstat || a.partstat === 'NEEDS-ACTION').length} ausstehend
                    {!readOnly && <> · <button type="button" onClick={() => setTab('scheduling')} className="text-accent-fg hover:underline">Verfügbarkeit prüfen</button></>}
                  </p>
                )}
              </div>
            </div>
          </div>
          )}

          {/* v3.18.28: Date + time — type=time with datalist allows dropdown
              AND manual typing ("HH:MM"). Better UX than a plain <select>. */}
          <div className="flex items-start gap-3">
            <Clock size={18} className="text-fg-subtle mt-2 shrink-0" />
            <div className="flex-1 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto] gap-2 items-center">
              <input
                type="date"
                aria-label="Beginn (Datum)"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (!endDate || endDate < e.target.value) setEndDate(e.target.value);
                }}
                disabled={readOnly}
                className={inputCls}
              />
              {!allDay && (
                <input
                  type="time"
                  aria-label="Beginn (Uhrzeit)"
                  list="cal-time-options"
                  step={900}
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  disabled={readOnly}
                  className={`${inputCls} w-[110px]`}
                />
              )}
              {allDay && <span className="text-xs text-fg-subtle px-2">ganztägig</span>}
              <input
                type="date"
                aria-label="Ende (Datum)"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={readOnly}
                className={inputCls}
              />
              {!allDay && (
                <input
                  type="time"
                  aria-label="Ende (Uhrzeit)"
                  list="cal-time-options"
                  step={900}
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  disabled={readOnly}
                  className={`${inputCls} w-[110px]`}
                />
              )}
              {/* Datalist with 15-min suggestions — the browser shows them as a dropdown
                  on focus, but the user can also freely type "13:42" */}
              <datalist id="cal-time-options">
                {TIME_OPTIONS.map((t) => <option key={t} value={t} />)}
              </datalist>
              <label className="col-span-full inline-flex items-center gap-2 text-xs text-fg-subtle mt-1">
                <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} disabled={readOnly} className="rounded" />
                Ganztägig
              </label>
            </div>
          </div>

          {/* 9.4: recurrence (series only) */}
          {!isOccurrence && (
            <RecurrenceField date={startDate} rrule={rrule} onChange={setRrule} disabled={readOnly} />
          )}

          {/* Location */}
          <div className="flex items-center gap-3">
            <MapPin size={18} className="text-fg-subtle shrink-0" />
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Hinzufügen eines Raums oder Standorts"
              aria-label="Ort"
              disabled={readOnly}
              className="flex-1 border-b border-line-strong focus:border-accent-fg bg-transparent px-1 py-1.5 text-sm focus:outline-none placeholder:text-fg-subtle"
            />
          </div>

          {/* 9.4: rooms and resources (series only) */}
          {!isOccurrence && (
            <RoomPicker
              startIso={slotStart}
              endIso={slotEnd}
              selected={rooms.map((r) => r.email)}
              answers={roomAnswers}
              {...(existing?.uid ? { uid: existing.uid } : {})}
              disabled={readOnly}
              onToggle={toggleRoom}
            />
          )}

          {/* 9.4: show as, reminder, classification */}
          <div className="flex items-start gap-3">
            <Eye size={18} className="text-fg-subtle mt-2 shrink-0" />
            <div className="flex flex-wrap gap-2 items-center">
              <label className="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
                Anzeigen als
                <select value={showAs} onChange={(e) => setShowAs(e.target.value as ShowAs)} disabled={readOnly} className={inputCls}>
                  {SHOW_AS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <select
                aria-label="Sichtbarkeit"
                value={classification}
                onChange={(e) => setClassification(e.target.value as 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL')}
                disabled={readOnly}
                className={inputCls}
              >
                <option value="PUBLIC">Öffentlich (alle Details sichtbar)</option>
                <option value="PRIVATE">Privat (nur „Beschäftigt")</option>
                <option value="CONFIDENTIAL">Vertraulich (für Gäste unsichtbar)</option>
              </select>
            </div>
          </div>

          {!isOccurrence && (
            <div className="flex items-center gap-3">
              <Bell size={18} className="text-fg-subtle shrink-0" />
              <div className="flex flex-wrap gap-3 items-center">
                <select
                  aria-label="Erinnerung"
                  value={reminderMinutes === null ? NO_REMINDER : String(reminderMinutes)}
                  onChange={(e) => setReminderMinutes(e.target.value === NO_REMINDER ? null : Number(e.target.value))}
                  disabled={readOnly}
                  className={inputCls}
                >
                  <option value={NO_REMINDER}>Keine Erinnerung</option>
                  {REMINDERS.map(([v, l]) => <option key={v} value={String(v)}>{l}</option>)}
                  {reminderMinutes !== null && !REMINDERS.some(([v]) => v === reminderMinutes) && (
                    <option value={String(reminderMinutes)}>{reminderMinutes} Minuten vorher</option>
                  )}
                </select>
                <label className="inline-flex items-center gap-2 text-xs text-fg-subtle">
                  <input type="checkbox" checked={reminderByMail} onChange={(e) => setReminderByMail(e.target.checked)}
                    disabled={readOnly || reminderMinutes === null} className="rounded" />
                  Auch per E-Mail
                </label>
              </div>
            </div>
          )}

          {/* Notes / Description */}
          <div className="flex items-start gap-3">
            <AlignLeft size={18} className="text-fg-subtle mt-2 shrink-0" />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Notizen, Tagesordnung, Links zur Besprechung…"
              aria-label="Notizen"
              rows={6}
              disabled={readOnly}
              className="flex-1 border border-line-strong rounded p-2 text-sm bg-surface focus:outline-none focus:ring-1 focus:ring-accent-fg placeholder:text-fg-subtle resize-y"
            />
          </div>

          {/* Edit mode info box */}
          {isEdit && existing && (
            <div className="text-[11px] text-fg-subtle border-t border-line pt-3 flex items-center gap-3">
              <CalendarIcon size={12} />
              <span>
                Organisator: <strong className="text-fg-muted">{existing.organizer ?? '—'}</strong>
              </span>
              {(existing.sequence ?? 0) > 0 && <span>· {existing.sequence}× geändert</span>}
            </div>
          )}
          </>}
        </div>

        {/* v3.18.28: Footer with Save bottom-right + Delete left + Cancel */}
        <div className="px-5 py-3 border-t border-line bg-surface-2 flex items-center justify-between gap-2 flex-wrap">
          <div>
            {isEdit && !readOnly && (
              <button
                onClick={() => {
                  const question = isOccurrence
                    ? `Nur dieses Ereignis von „${summary}" löschen? Die übrigen Termine der Serie bleiben erhalten.`
                    : `Termin „${summary}" wirklich löschen?${attendees.length > 0 ? ' Alle Gäste erhalten eine Absage-Mail.' : ''}`;
                  if (window.confirm(question)) deleteMut.mutate();
                }}
                disabled={deleteMut.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-line-strong text-danger-fg hover:bg-danger-bg rounded disabled:opacity-50"
              >
                <Trash2 size={14} />
                {isOccurrence ? 'Dieses Ereignis löschen' : 'Löschen'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm border border-line-strong text-fg-muted rounded hover:bg-surface-2"
            >
              Abbrechen
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave || createMut.isPending || updateMut.isPending || readOnly}
              className="flex items-center gap-1.5 px-5 py-1.5 text-sm bg-accent hover:bg-accent/90 text-white rounded font-medium disabled:opacity-50"
            >
              <Save size={14} />
              {createMut.isPending || updateMut.isPending ? 'Speichern…' : attendees.length > 0 && !isEdit ? 'Senden' : 'Speichern'}
            </button>
          </div>
        </div>
    </Modal>
  );
}
