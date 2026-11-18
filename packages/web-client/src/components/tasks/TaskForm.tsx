import { useState } from 'react';
import { Save, X } from 'lucide-react';
import { Modal } from '../Modal.js';
import { RecurrenceField } from '../calendar/RecurrenceField.js';
import { RichNoteEditor } from './RichNoteEditor.js';
import type { Task, TaskStatus } from '../../api/types.js';
import { isoToLocalInput, localInputToIso } from '../../lib/datetime.js';
import { formatWorkHours, parseWorkHours } from '../../lib/taskItems.js';
import { sanitizeMailHtml } from '../../lib/mailHtml.js';

/**
 * 9.4: the full task form (create and edit): Betreff, Start, Fällig, Abschluss,
 * Status, % erledigt, Priorität, Erinnerung (+ per E-Mail), privat, Serie,
 * Gesamt- und Ist-Aufwand, Kilometer, Abrechnung, Firmen, Notiz (Rich Text).
 * Status, % and completion date are kept consistent by the server.
 */
export interface TaskPayload {
  subject: string;
  body: string;
  bodyHtml: string;
  startDate: string | null;
  dueDate: string | null;
  completedAt?: string | null;
  status: TaskStatus;
  percentComplete: number;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  reminder: string | null;
  reminderByMail: boolean;
  isPrivate: boolean;
  rrule: string | null;
  totalWorkMinutes: number | null;
  actualWorkMinutes: number | null;
  mileage: string;
  billingInfo: string;
  companies: string;
}

interface Props {
  task: Task | null;
  pending: boolean;
  onSave: (payload: TaskPayload) => void;
  onClose: () => void;
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  NOT_STARTED: 'Nicht begonnen',
  IN_PROGRESS: 'In Bearbeitung',
  COMPLETED: 'Abgeschlossen',
  WAITING: 'Wartet auf jemanden',
  DEFERRED: 'Zurückgestellt',
};
const PRIORITY_LABEL = { LOW: 'Niedrig', NORMAL: 'Normal', HIGH: 'Hoch' } as const;

const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '');
const dayToIso = (d: string): string | null => (d ? `${d}T00:00:00.000Z` : null);
const inputCls = 'w-full border border-line-strong rounded px-2 py-1.5 text-sm bg-surface focus:outline-none focus:ring-1 focus:ring-accent-fg';
const labelCls = 'block text-xs font-medium text-fg-muted mb-1';

/** Escapes plain text of a pre-9.4 task for the rich-text note. */
function textToHtml(text: string): string {
  return text ? `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>` : '';
}

export function TaskForm({ task, pending, onSave, onClose }: Props) {
  const [subject, setSubject] = useState(task?.subject ?? '');
  const [startDate, setStartDate] = useState(day(task?.startDate));
  const [dueDate, setDueDate] = useState(day(task?.dueDate));
  const [completedDate, setCompletedDate] = useState(day(task?.completedAt));
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'NOT_STARTED');
  const [percent, setPercent] = useState(task?.percentComplete ?? 0);
  const [priority, setPriority] = useState<'LOW' | 'NORMAL' | 'HIGH'>(task?.priority ?? 'NORMAL');
  const [reminder, setReminder] = useState(task?.reminder ? isoToLocalInput(task.reminder) : '');
  const [reminderByMail, setReminderByMail] = useState(task?.reminderByMail ?? false);
  const [isPrivate, setIsPrivate] = useState(task?.isPrivate ?? false);
  const [rrule, setRrule] = useState<string | null>(task?.rrule ?? null);
  const [totalWork, setTotalWork] = useState(formatWorkHours(task?.totalWorkMinutes));
  const [actualWork, setActualWork] = useState(formatWorkHours(task?.actualWorkMinutes));
  const [mileage, setMileage] = useState(task?.mileage ?? '');
  const [billingInfo, setBillingInfo] = useState(task?.billingInfo ?? '');
  const [companies, setCompanies] = useState(task?.companies ?? '');
  const [note, setNote] = useState({ html: task?.bodyHtml ? sanitizeMailHtml(task.bodyHtml) : textToHtml(task?.body ?? ''), text: task?.body ?? '' });

  const total = parseWorkHours(totalWork);
  const actual = parseWorkHours(actualWork);
  const valid = subject.trim().length > 0 && total !== undefined && actual !== undefined && (!startDate || !dueDate || startDate <= dueDate);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const wasCompleted = task?.status === 'COMPLETED';
    onSave({
      subject: subject.trim(),
      body: note.text,
      bodyHtml: note.html,
      startDate: dayToIso(startDate),
      dueDate: dayToIso(dueDate),
      // the completion date only when set or changed here; status/% decide otherwise
      ...(completedDate !== day(task?.completedAt) || (status === 'COMPLETED' && !wasCompleted)
        ? { completedAt: status === 'COMPLETED' || completedDate ? dayToIso(completedDate || new Date().toISOString().slice(0, 10)) : null }
        : {}),
      status,
      percentComplete: percent,
      priority,
      reminder: reminder ? localInputToIso(reminder) : null,
      reminderByMail: !!reminder && reminderByMail,
      isPrivate,
      rrule,
      totalWorkMinutes: total ?? null,
      actualWorkMinutes: actual ?? null,
      mileage, billingInfo, companies,
    });
  };

  // status ⇄ percent in the form (the server applies the same rules)
  const changeStatus = (s: TaskStatus) => {
    setStatus(s);
    if (s === 'COMPLETED') setPercent(100);
    else if (s === 'NOT_STARTED') setPercent(0);
    else if (percent === 100) setPercent(0);
    if (s !== 'COMPLETED') setCompletedDate('');
  };
  const changePercent = (p: number) => {
    const v = Math.min(100, Math.max(0, Math.round(p)));
    setPercent(v);
    if (v === 100) setStatus('COMPLETED');
    else if (v > 0 && (status === 'NOT_STARTED' || status === 'COMPLETED')) setStatus('IN_PROGRESS');
    else if (v === 0 && status === 'IN_PROGRESS') setStatus('NOT_STARTED');
  };

  return (
    <Modal
      onClose={onClose}
      labelledBy="task-form-title"
      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
      className="bg-surface rounded-lg shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-line">
        <h2 id="task-form-title" className="text-base font-semibold text-fg">{task ? 'Aufgabe bearbeiten' : 'Neue Aufgabe'}</h2>
        <button type="button" onClick={onClose} className="text-fg-subtle hover:text-fg-muted" aria-label="Schließen"><X size={18} /></button>
      </div>
      <form onSubmit={submit} className="flex-1 overflow-y-auto p-5 space-y-4">
        <div>
          <label htmlFor="task-subject" className={labelCls}>Betreff *</label>
          <input id="task-subject" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} className={inputCls} required maxLength={500} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="task-start" className={labelCls}>Startdatum</label>
            <input id="task-start" type="date" value={startDate} max={dueDate || undefined} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="task-due" className={labelCls}>Fälligkeitsdatum</label>
            <input id="task-due" type="date" value={dueDate} min={startDate || undefined} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="task-completed" className={labelCls}>Abschlussdatum</label>
            <input id="task-completed" type="date" value={completedDate}
              onChange={(e) => { setCompletedDate(e.target.value); if (e.target.value) { setStatus('COMPLETED'); setPercent(100); } }}
              className={inputCls} />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="task-status" className={labelCls}>Status</label>
            <select id="task-status" value={status} onChange={(e) => changeStatus(e.target.value as TaskStatus)} className={inputCls}>
              {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="task-percent" className={labelCls}>% erledigt</label>
            <input id="task-percent" type="number" min={0} max={100} step={25} value={percent} onChange={(e) => changePercent(Number(e.target.value))} className={inputCls} />
          </div>
          <div>
            <label htmlFor="task-priority" className={labelCls}>Priorität</label>
            <select id="task-priority" value={priority} onChange={(e) => setPriority(e.target.value as 'LOW' | 'NORMAL' | 'HIGH')} className={inputCls}>
              {(['LOW', 'NORMAL', 'HIGH'] as const).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <div>
            <label htmlFor="task-reminder" className={labelCls}>Erinnerung</label>
            <input id="task-reminder" type="datetime-local" value={reminder} onChange={(e) => setReminder(e.target.value)} className={inputCls} />
          </div>
          <div className="flex flex-col gap-2 pb-1">
            <label className="inline-flex items-center gap-2 text-sm text-fg-muted">
              <input type="checkbox" checked={reminderByMail} disabled={!reminder} onChange={(e) => setReminderByMail(e.target.checked)} className="rounded" />
              Erinnerung auch per E-Mail
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-fg-muted">
              <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} className="rounded" />
              Privat
            </label>
          </div>
        </div>

        <RecurrenceField date={dueDate || startDate || new Date().toISOString().slice(0, 10)} rrule={rrule} onChange={setRrule} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="task-total" className={labelCls}>Gesamtaufwand (Stunden)</label>
            <input id="task-total" inputMode="decimal" value={totalWork} onChange={(e) => setTotalWork(e.target.value)} aria-invalid={total === undefined} className={inputCls} />
          </div>
          <div>
            <label htmlFor="task-actual" className={labelCls}>Ist-Aufwand (Stunden)</label>
            <input id="task-actual" inputMode="decimal" value={actualWork} onChange={(e) => setActualWork(e.target.value)} aria-invalid={actual === undefined} className={inputCls} />
          </div>
          <div>
            <label htmlFor="task-mileage" className={labelCls}>Reisekilometer</label>
            <input id="task-mileage" value={mileage} onChange={(e) => setMileage(e.target.value)} maxLength={500} className={inputCls} />
          </div>
          <div>
            <label htmlFor="task-billing" className={labelCls}>Abrechnungsinformationen</label>
            <input id="task-billing" value={billingInfo} onChange={(e) => setBillingInfo(e.target.value)} maxLength={500} className={inputCls} />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="task-companies" className={labelCls}>Firmen</label>
            <input id="task-companies" value={companies} onChange={(e) => setCompanies(e.target.value)} maxLength={500} className={inputCls} />
          </div>
        </div>

        <div>
          <span className={labelCls}>Notiz</span>
          <RichNoteEditor html={note.html} label="Notiz" onChange={(html, text) => setNote({ html, text })} />
        </div>

        {(total === undefined || actual === undefined) && <p role="alert" className="text-xs text-danger-fg">Aufwand bitte als Stunden angeben, z. B. 1,5.</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary text-xs">Abbrechen</button>
          <button type="submit" disabled={!valid || pending} className="btn-primary text-xs disabled:opacity-50 flex items-center gap-1.5">
            <Save size={13} />{pending ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
