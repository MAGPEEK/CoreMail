import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Save, Trash2, X, Users, Clock, MapPin, Eye, AlignLeft,
  CheckCircle2, XCircle, HelpCircle, UserPlus, Calendar as CalendarIcon,
  Loader2, RefreshCw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { Calendar, CalendarEvent, EventAttendee } from '../api/types.js';

/**
 * v3.18.27 — Outlook-Style Event-Dialog für Calendar (Create & Edit).
 *
 * Features:
 *  - Title, Attendees (mit live PARTSTAT-Badge), Date+Time-Pickers (Dropdown),
 *    Location, Classification (Public/Private/Confidential), Notes, Calendar-Select
 *  - Edit-Mode lädt Daten von GET /calendar/events/:id (mit canWrite-Flag)
 *  - Create-Mode mit Defaults aus übergebenem DateSelect-Info
 *  - Attendee-Status refresht automatisch (refetchInterval 30s)
 *  - Speichern triggert POST oder PUT, iMIP-Mails werden Backend-seitig versendet
 *  - Löschen-Button (mit Bestätigung) löscht Event + sendet CANCEL-Mails
 */

interface AttendeeSuggest {
  id: string;
  displayName: string;
  email: string;
  isGroup?: boolean;
}

interface Props {
  /** null = neues Event, sonst Event-ID für Edit-Mode */
  eventId: string | null;
  /** Default-Werte für Create-Mode */
  defaults?: {
    calendarId?: string;
    dtStart?: string; // ISO
    dtEnd?: string;   // ISO
    allDay?: boolean;
  };
  /** Liste der verfügbaren Kalender (für Picker) */
  calendars: Calendar[];
  /** Default-Cal für Create wenn defaults.calendarId fehlt */
  defaultWritableCalendarId: string;
  onClose: () => void;
}

// ─── Time-Picker Optionen (alle 15 min) ──────────────────────────────────────
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
  ACCEPTED:       { icon: <CheckCircle2 size={12} />, color: 'text-green-600 bg-green-50 dark:bg-green-500/10', label: 'Zugesagt' },
  DECLINED:       { icon: <XCircle size={12} />,      color: 'text-red-600 bg-red-50 dark:bg-red-500/10',       label: 'Abgesagt' },
  TENTATIVE:      { icon: <HelpCircle size={12} />,   color: 'text-amber-600 bg-amber-50 dark:bg-amber-500/10', label: 'Vielleicht' },
  'NEEDS-ACTION': { icon: <Clock size={12} />,        color: 'text-gray-500 bg-gray-100 dark:bg-gray-800',      label: 'Wartet' },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isoToParts(iso: string): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: '', time: '' };
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function partsToIso(date: string, time: string): string {
  if (!date) return '';
  const t = time || '00:00';
  // Local-Time-String — Browser konvertiert beim Date-Construct in lokale TZ
  return new Date(`${date}T${t}:00`).toISOString();
}

function addMinutes(iso: string, mins: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + mins);
  return d.toISOString();
}

// ─── Component ───────────────────────────────────────────────────────────────
export function EventEditDialog({
  eventId, defaults, calendars, defaultWritableCalendarId, onClose,
}: Props) {
  const qc = useQueryClient();
  const isEdit = eventId !== null;

  // Edit-Mode: Event-Detail laden
  const { data: existing, isLoading: existingLoading, refetch: refetchEvent } = useQuery<CalendarEvent>({
    queryKey: ['event', eventId],
    queryFn: () => api.get<CalendarEvent>(`/calendar/events/${eventId}`),
    enabled: isEdit,
    refetchInterval: 30_000, // Attendee-Status live
    staleTime: 0,
  });

  // Form-State
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

  // Form mit existing oder defaults initialisieren — nur einmal pro Open
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    if (isEdit) {
      if (!existing) return;
      initialized.current = true;
      setSummary(existing.summary ?? '');
      setCalendarId(existing.calendarId);
      const s = isoToParts(existing.dtStart);
      const e = isoToParts(existing.dtEnd);
      setStartDate(s.date); setStartTime(s.time);
      setEndDate(e.date); setEndTime(e.time);
      setAllDay(existing.allDay ?? false);
      setLocation(existing.location ?? '');
      setDescription(existing.description ?? '');
      setClassification(existing.classification ?? 'PUBLIC');
      setAttendees(existing.attendees ?? []);
    } else {
      initialized.current = true;
      setCalendarId(defaults?.calendarId ?? defaultWritableCalendarId);
      const start = defaults?.dtStart ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const end = defaults?.dtEnd ?? addMinutes(start, 30);
      const s = isoToParts(start);
      const e = isoToParts(end);
      setStartDate(s.date); setStartTime(s.time);
      setEndDate(e.date); setEndTime(e.time);
      setAllDay(defaults?.allDay ?? false);
    }
  }, [isEdit, existing, defaults, defaultWritableCalendarId]);

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
      setShowSug(false);
    }
  };

  const removeAttendee = (email: string) => {
    setAttendees((prev) => prev.filter((a) => a.email !== email));
  };

  // ─── Save Mutations ─────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: (body: object) => api.post('/calendar/events', body),
    onSuccess: () => {
      toast.success('Termin erstellt');
      void qc.invalidateQueries({ queryKey: ['calendar-events'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMut = useMutation({
    mutationFn: (body: object) => api.put(`/calendar/events/${eventId}`, body),
    onSuccess: () => {
      toast.success('Termin gespeichert');
      void qc.invalidateQueries({ queryKey: ['calendar-events'] });
      void qc.invalidateQueries({ queryKey: ['event', eventId] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/calendar/events/${eventId}`),
    onSuccess: () => {
      toast.success('Termin gelöscht');
      void qc.invalidateQueries({ queryKey: ['calendar-events'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSave = summary.trim().length > 0 && !!startDate && !!endDate &&
                   calendarId && (existing?.canWrite !== false || !isEdit);

  const handleSave = () => {
    const dtStart = allDay ? `${startDate}T00:00:00.000Z` : partsToIso(startDate, startTime);
    const dtEnd   = allDay ? `${endDate}T23:59:59.999Z`   : partsToIso(endDate, endTime);
    const body = {
      calendarId, summary: summary.trim(),
      dtStart, dtEnd, allDay,
      description, location, classification,
      attendees: attendees.map((a) => ({
        email: a.email,
        ...(a.cn ? { cn: a.cn } : {}),
        ...(a.partstat ? { partstat: a.partstat } : {}),
      })),
    };
    if (isEdit) updateMut.mutate(body);
    else createMut.mutate(body);
  };

  // Lade-Spinner für Edit-Mode während GET
  if (isEdit && existingLoading) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl p-8 text-center">
          <Loader2 size={28} className="animate-spin mx-auto text-accent" />
          <p className="text-sm text-gray-500 mt-3">Termin wird geladen…</p>
        </div>
      </div>
    );
  }

  const readOnly = isEdit && existing?.canWrite === false;
  const currentCal = useMemo(() => calendars.find((c) => c.id === calendarId), [calendars, calendarId]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-3xl max-h-[92vh] flex flex-col">

        {/* Header — Outlook-Style Toolbar */}
        <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={!canSave || createMut.isPending || updateMut.isPending || readOnly}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-accent hover:bg-accent/90 text-white rounded font-medium disabled:opacity-50"
            >
              <Save size={14} />
              {createMut.isPending || updateMut.isPending ? 'Speichern…' : 'Speichern'}
            </button>
            {isEdit && !readOnly && (
              <button
                onClick={() => {
                  if (window.confirm(`Termin „${summary}" wirklich löschen? Alle Gäste erhalten eine Absage-Mail.`)) {
                    deleteMut.mutate();
                  }
                }}
                disabled={deleteMut.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-700 text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 rounded disabled:opacity-50"
              >
                <Trash2 size={14} />
                Löschen
              </button>
            )}
            {isEdit && (
              <button
                onClick={() => void refetchEvent()}
                className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded"
                title="Status der Gäste aktualisieren"
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {readOnly && (
              <span className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-500/10 px-2 py-1 rounded">
                Nur Lesezugriff
              </span>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none px-2" aria-label="Schließen">×</button>
          </div>
        </div>

        {/* Body — scrollbar */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

          {/* Calendar-Picker (nur eigener oder writable) */}
          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: currentCal?.color ?? '#0078D4' }} />
            <select
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
              disabled={isEdit || readOnly}
              className="text-xs bg-transparent border-0 text-gray-600 dark:text-gray-400 focus:outline-none focus:ring-0 disabled:opacity-50"
            >
              {calendars.filter((c) => isEdit ? true : c.permission !== 'READ').map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.shared ? ` (geteilt von ${c.ownerDisplayName ?? c.ownerEmail ?? '?'})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Titel */}
          <div>
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Titel hinzufügen"
              disabled={readOnly}
              className="w-full border-b-2 border-gray-200 dark:border-gray-700 focus:border-accent text-lg font-medium bg-transparent px-1 py-2 focus:outline-none placeholder:text-gray-400 dark:text-gray-100 disabled:opacity-60"
            />
          </div>

          {/* Attendees */}
          <div>
            <div className="flex items-start gap-3">
              <Users size={18} className="text-gray-400 mt-2 shrink-0" />
              <div className="flex-1 min-w-0">
                {attendees.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {attendees.map((a) => {
                      const badge = PARTSTAT_BADGE[a.partstat ?? 'NEEDS-ACTION']!;
                      return (
                        <div key={a.email} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">
                          <span className="font-medium text-gray-900 dark:text-gray-100 truncate max-w-[160px]">
                            {a.cn && a.cn !== a.email ? `${a.cn}` : a.email}
                          </span>
                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${badge.color}`} title={badge.label}>
                            {badge.icon}
                          </span>
                          {!readOnly && (
                            <button onClick={() => removeAttendee(a.email)} className="p-0.5 text-gray-400 hover:text-red-500 ml-0.5">
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
                      placeholder={attendees.length === 0 ? 'Erforderliche Teilnehmer einladen' : 'Weiteren Teilnehmer einladen…'}
                      className="w-full border-b border-gray-200 dark:border-gray-700 focus:border-accent bg-transparent px-1 py-1.5 text-sm focus:outline-none placeholder:text-gray-400 dark:text-gray-100"
                    />
                    {showSug && suggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg z-10 max-h-60 overflow-y-auto">
                        {suggestions.map((s, idx) => (
                          <button
                            key={s.id}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); addAttendee(s.email, s.displayName); }}
                            onMouseEnter={() => setActiveIdx(idx)}
                            className={`w-full text-left px-3 py-2 text-sm ${idx === activeIdx ? 'bg-accent/10' : 'hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                          >
                            <div className="font-medium text-gray-900 dark:text-gray-100 truncate">{s.displayName}</div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.email}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {attendees.length > 0 && (
                  <p className="text-[11px] text-gray-400 mt-1">
                    {attendees.filter((a) => a.partstat === 'ACCEPTED').length} zugesagt ·
                    {' '}{attendees.filter((a) => a.partstat === 'DECLINED').length} abgesagt ·
                    {' '}{attendees.filter((a) => a.partstat === 'TENTATIVE').length} vielleicht ·
                    {' '}{attendees.filter((a) => !a.partstat || a.partstat === 'NEEDS-ACTION').length} ausstehend
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Datum + Zeit (Date-Inputs + Time-Dropdowns) */}
          <div className="flex items-start gap-3">
            <Clock size={18} className="text-gray-400 mt-2 shrink-0" />
            <div className="flex-1 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto] gap-2 items-center">
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (!endDate || endDate < e.target.value) setEndDate(e.target.value);
                }}
                disabled={readOnly}
                className="border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
              />
              {!allDay && (
                <select
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  disabled={readOnly}
                  className="border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
                >
                  {TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              {allDay && <span className="text-xs text-gray-400 px-2">ganztägig</span>}
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={readOnly}
                className="border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
              />
              {!allDay && (
                <select
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  disabled={readOnly}
                  className="border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
                >
                  {TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              <label className="col-span-full inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mt-1">
                <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} disabled={readOnly} className="rounded" />
                Ganztägig
              </label>
            </div>
          </div>

          {/* Location */}
          <div className="flex items-center gap-3">
            <MapPin size={18} className="text-gray-400 shrink-0" />
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Hinzufügen eines Raums oder Standorts"
              disabled={readOnly}
              className="flex-1 border-b border-gray-200 dark:border-gray-700 focus:border-accent bg-transparent px-1 py-1.5 text-sm focus:outline-none placeholder:text-gray-400 dark:text-gray-100"
            />
          </div>

          {/* Classification */}
          <div className="flex items-center gap-3">
            <Eye size={18} className="text-gray-400 shrink-0" />
            <select
              value={classification}
              onChange={(e) => setClassification(e.target.value as 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL')}
              disabled={readOnly}
              className="border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="PUBLIC">Öffentlich (alle Details sichtbar)</option>
              <option value="PRIVATE">Privat (nur „Beschäftigt")</option>
              <option value="CONFIDENTIAL">Vertraulich (für Gäste unsichtbar)</option>
            </select>
          </div>

          {/* Notes / Description */}
          <div className="flex items-start gap-3">
            <AlignLeft size={18} className="text-gray-400 mt-2 shrink-0" />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Notizen, Tagesordnung, Links zur Besprechung…"
              rows={6}
              disabled={readOnly}
              className="flex-1 border border-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded p-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-gray-400 resize-y"
            />
          </div>

          {/* Edit-Mode-Info-Box */}
          {isEdit && existing && (
            <div className="text-[11px] text-gray-400 border-t border-gray-100 dark:border-gray-700 pt-3 flex items-center gap-3">
              <CalendarIcon size={12} />
              <span>
                Organisator: <strong className="text-gray-600 dark:text-gray-300">{existing.organizer ?? '—'}</strong>
              </span>
              {(existing.sequence ?? 0) > 0 && <span>· {existing.sequence}× geändert</span>}
              {attendees.length > 0 && <span>· Status-Updates kommen automatisch alle 30s</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Mark used to silence unused-warnings for stub-imports
void UserPlus;
