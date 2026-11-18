import { useState } from 'react';
import { Modal } from './Modal.js';
import { useT } from '../i18n/useT.js';
import { instantToWallClock, wallClockToInstant } from '../lib/zonedTime.js';

/**
 * 9.4: custom follow-up flag ("Benutzerdefiniert …" / "Erinnerung hinzufügen …"):
 * start and due day plus an optional reminder time, in the user's zone.
 */
export interface FollowUpValues {
  startAt: string | null;
  dueAt: string | null;
  reminderAt: string | null;
}

interface Props {
  initial: FollowUpValues;
  timeZone: string;
  /** Show only the reminder field ("Erinnerung hinzufügen"). */
  reminderOnly?: boolean;
  onSave: (values: FollowUpValues) => void;
  onClose: () => void;
}

const inputCls = 'w-full border border-line-strong rounded px-2 py-1.5 text-sm bg-surface focus:outline-none focus:ring-1 focus:ring-accent-fg';

export function FollowUpDialog({ initial, timeZone, reminderOnly, onSave, onClose }: Props) {
  const t = useT();
  const dayOf = (iso: string | null) => (iso ? instantToWallClock(iso, timeZone).date : '');
  const [start, setStart] = useState(dayOf(initial.startAt));
  const [due, setDue] = useState(dayOf(initial.dueAt));
  const reminderParts = initial.reminderAt ? instantToWallClock(initial.reminderAt, timeZone) : { date: '', time: '09:00' };
  const [remDate, setRemDate] = useState(reminderParts.date);
  const [remTime, setRemTime] = useState(reminderParts.time || '09:00');
  const valid = !start || !due || start <= due;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const at = (d: string) => (d ? wallClockToInstant(d, '00:00', timeZone) : null);
    onSave({
      startAt: at(start || due),
      dueAt: at(due || start),
      reminderAt: remDate ? wallClockToInstant(remDate, remTime, timeZone) : null,
    });
  };

  return (
    <Modal onClose={onClose} labelledBy="followup-title" className="bg-surface rounded-lg shadow-xl w-full max-w-sm">
      <form onSubmit={submit} className="p-5 space-y-3">
        <h2 id="followup-title" className="text-sm font-semibold text-fg">{t('flag_dialog_title')}</h2>
        {!reminderOnly && (
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-fg-muted">{t('flag_start')}
              <input type="date" value={start} max={due || undefined} onChange={(e) => setStart(e.target.value)} className={`${inputCls} mt-1`} />
            </label>
            <label className="text-xs text-fg-muted">{t('flag_due')}
              <input type="date" value={due} min={start || undefined} onChange={(e) => setDue(e.target.value)} className={`${inputCls} mt-1`} />
            </label>
          </div>
        )}
        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="text-xs text-fg-muted mb-1">{t('flag_reminder')}</legend>
          <input type="date" aria-label={`${t('flag_reminder')} (Datum)`} value={remDate} onChange={(e) => setRemDate(e.target.value)} className={inputCls} />
          <input type="time" aria-label={`${t('flag_reminder')} (Uhrzeit)`} value={remTime} step={900} onChange={(e) => setRemTime(e.target.value)} disabled={!remDate} className={inputCls} />
        </fieldset>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm border border-line-strong text-fg-muted rounded hover:bg-surface-2">{t('cancel')}</button>
          <button type="submit" disabled={!valid} className="px-4 py-1.5 text-sm bg-accent text-white rounded disabled:opacity-50">{t('save')}</button>
        </div>
      </form>
    </Modal>
  );
}
