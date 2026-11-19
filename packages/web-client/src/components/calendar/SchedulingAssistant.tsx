import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Sparkles } from 'lucide-react';
import { api } from '../../api/client.js';
import type { FreeBusyUser, ScheduleSuggestions } from '../../api/types.js';
import { instantToWallClock, wallClockToInstant } from '../../lib/zonedTime.js';
import { BUSY_LABEL, barPosition, suggestionNote, timelineHours, type BusyKind } from '../../lib/scheduling.js';

/**
 * 9.4: scheduling assistant of the event form — one free/busy row per attendee
 * for the chosen day, the selected time as an overlay, and meeting-time
 * suggestions for the next seven days (click to take one). Attendees without a
 * calendar share show "keine Informationen" (not "frei").
 */
interface Props {
  organizerEmail: string;
  attendees: Array<{ email: string; cn?: string }>;
  /** Selected slot (ISO instants) and its day in the user's zone. */
  startIso: string;
  endIso: string;
  date: string;
  timeZone: string;
  workStart: string;
  workEnd: string;
  onPick: (startIso: string, endIso: string) => void;
}

const BAR_CLASS: Record<BusyKind, string> = {
  busy: 'bg-accent',
  tentative: 'bg-info-bg border border-info-line',
  oof: 'bg-warning',
};

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export function SchedulingAssistant(props: Props) {
  const { organizerEmail, attendees, startIso, endIso, date, timeZone, workStart, workEnd, onPick } = props;
  const dayStart = wallClockToInstant(date, '00:00', timeZone);
  const dayEnd = wallClockToInstant(addDays(date, 1), '00:00', timeZone);
  const emails = useMemo(() => [organizerEmail, ...attendees.map((a) => a.email)], [organizerEmail, attendees]);
  const durationMinutes = Math.max(5, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000));

  const { data: freeBusy, isLoading } = useQuery({
    queryKey: ['freebusy', emails.join(','), dayStart],
    queryFn: () => api.post<{ users: FreeBusyUser[] }>('/calendar/freebusy', { userEmails: emails, start: dayStart, end: dayEnd }),
    enabled: !!dayStart && !!dayEnd,
  });
  const { data: suggestions } = useQuery({
    queryKey: ['schedule-suggestions', emails.join(','), dayStart, durationMinutes],
    queryFn: () => api.post<ScheduleSuggestions>('/calendar/schedule-suggestions', {
      attendees: attendees.map((a) => a.email),
      start: dayStart, end: wallClockToInstant(addDays(date, 7), '00:00', timeZone),
      durationMinutes,
    }),
    enabled: !!dayStart,
  });

  const slot = { start: instantToWallClock(startIso, timeZone), end: instantToWallClock(endIso, timeZone) };
  const hourOf = (t: string) => Number(t.split(':')[0] ?? 0) + Number(t.split(':')[1] ?? 0) / 60;
  const hours = timelineHours(workStart, workEnd, hourOf(slot.start.time), slot.end.date === date ? hourOf(slot.end.time) : 24);
  const viewStart = new Date(wallClockToInstant(date, `${String(hours.from).padStart(2, '0')}:00`, timeZone));
  const viewEnd = hours.to >= 24 ? new Date(dayEnd) : new Date(wallClockToInstant(date, `${String(hours.to).padStart(2, '0')}:00`, timeZone));
  const selected = barPosition(startIso, endIso, viewStart, viewEnd);
  const hourMarks = Array.from({ length: hours.to - hours.from }, (_, i) => hours.from + i);

  const rows: Array<{ key: string; label: string; visible: boolean; busy: Array<{ start: string; end: string; kind: BusyKind; subject?: string }> }> =
    (freeBusy?.users ?? []).map((u, i) => ({
      key: u.email,
      label: i === 0 ? 'Ich' : (attendees.find((a) => a.email.toLowerCase() === u.email.toLowerCase())?.cn || u.displayName || u.email),
      visible: u.found && u.visible,
      busy: u.busy.map((b) => ({ start: b.start, end: b.end, kind: b.type, ...(b.subject ? { subject: b.subject } : {}) })),
    }));

  const fmtSlot = (s: { start: string; end: string }) => {
    const a = instantToWallClock(s.start, timeZone);
    const b = instantToWallClock(s.end, timeZone);
    const [y, m, d] = a.date.split('-');
    const weekday = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).toLocaleDateString('de-DE', { weekday: 'short', timeZone: 'UTC' });
    return `${weekday} ${d}.${m}. ${a.time}–${b.time}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-xs text-fg-subtle flex-wrap" aria-label="Legende">
        {(Object.keys(BUSY_LABEL) as BusyKind[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5"><span className={`inline-block w-3 h-3 rounded-sm ${BAR_CLASS[k]}`} />{BUSY_LABEL[k]}</span>
        ))}
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm border-2 border-accent-fg" />Gewählte Zeit</span>
      </div>

      {isLoading && <div className="flex items-center gap-2 text-sm text-fg-subtle"><Loader2 size={14} className="animate-spin" />Verfügbarkeit wird geladen…</div>}

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse min-w-[560px]">
          <caption className="sr-only">Verfügbarkeit am {date.split('-').reverse().join('.')}</caption>
          <thead>
            <tr>
              <th scope="col" className="text-left font-medium text-fg-subtle w-40 py-1 pr-2">Teilnehmer</th>
              <th scope="col" className="py-1">
                <div className="flex">
                  {hourMarks.map((h) => <span key={h} className="flex-1 text-left text-fg-subtle font-normal">{String(h).padStart(2, '0')}</span>)}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-line">
                <th scope="row" className="text-left font-normal text-fg-muted py-1.5 pr-2 truncate max-w-[10rem]" title={row.label}>{row.label}</th>
                <td className="py-1.5">
                  <div className="relative h-6 bg-surface-2 rounded">
                    {!row.visible && <span className="absolute inset-0 flex items-center px-2 text-fg-subtle">Keine Frei/Gebucht-Informationen</span>}
                    {row.busy.map((b, i) => {
                      const pos = barPosition(b.start, b.end, viewStart, viewEnd);
                      if (!pos) return null;
                      const text = `${BUSY_LABEL[b.kind]}${b.subject ? `: ${b.subject}` : ''} (${instantToWallClock(b.start, timeZone).time}–${instantToWallClock(b.end, timeZone).time})`;
                      return (
                        <span key={i} title={text} className={`absolute top-0.5 bottom-0.5 rounded-sm ${BAR_CLASS[b.kind]}`} style={{ left: `${pos.left}%`, width: `${pos.width}%` }}>
                          <span className="sr-only">{text}</span>
                        </span>
                      );
                    })}
                    {selected && <span aria-hidden="true" className="absolute inset-y-0 rounded border-2 border-accent-fg pointer-events-none" style={{ left: `${selected.left}%`, width: `${selected.width}%` }} />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg-muted mb-2"><Sparkles size={13} aria-hidden="true" />Vorgeschlagene Zeiten</h3>
        {suggestions && suggestions.unknown.length > 0 && (
          <p className="text-xs text-fg-subtle mb-2">Ohne Frei/Gebucht-Informationen berücksichtigt: {suggestions.unknown.join(', ')}</p>
        )}
        <ul className="flex flex-wrap gap-2">
          {(suggestions?.suggestions ?? []).map((s) => (
            <li key={s.start}>
              <button
                type="button"
                onClick={() => onPick(s.start, s.end)}
                className={`text-left px-3 py-1.5 rounded border text-xs hover:bg-surface-2 ${s.conflicts === 0 ? 'border-success-line' : 'border-line-strong'}`}
              >
                <span className="block font-medium text-fg">{fmtSlot(s)}</span>
                <span className={s.conflicts === 0 ? 'text-success-fg' : 'text-fg-subtle'}>{suggestionNote(s.conflicts, s.tentative)}</span>
              </button>
            </li>
          ))}
          {suggestions && suggestions.suggestions.length === 0 && <li className="text-xs text-fg-subtle">Keine freien Zeiten in den nächsten sieben Tagen.</li>}
        </ul>
      </div>
    </div>
  );
}
