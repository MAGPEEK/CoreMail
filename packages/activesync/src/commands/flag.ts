/**
 * 9.4: email:Flag ([MS-ASEMAIL] 2.2.2.34) ↔ the message's follow-up flag.
 *
 * Server → device: `<Flag/>` (empty) when not flagged; Status 2 + FlagType and the
 * tasks:* dates when flagged; Status 1 + CompleteTime/tasks:DateCompleted when
 * complete. Device → server ([MS-ASEMAIL] 3.2.5.4.2): Status 0 or an empty Flag
 * clears; Status 1 needs CompleteTime and tasks:DateCompleted; Status 2 needs
 * FlagType and the four start/due dates all set or all absent, due not before
 * start. Anything else is answered with Sync Status 6 (error in client/server
 * conversion) for that item.
 *
 * CoreMail keeps one instant per date: the local tasks:StartDate/DueDate are
 * written with the same value as their Utc* counterparts; of a device flag the Utc*
 * values are used.
 */
import { followUpOf, type FollowUpRow, type FollowUpState, type FollowUpStatus } from '@coremail/storage/follow-up';
import { CP, getChild, pel, type WbxmlElement } from '../wbxml.js';

/** FlagType text of a follow-up flag ([MS-ASEMAIL] 2.2.2.35). */
export const FLAG_TYPE = 'Flag for follow up';

/** [MS-ASCMD] Sync Status 6: error in client/server conversion (invalid item). */
export const FLAG_CONVERSION_ERROR = '6';

const E = CP.Email;
const T = CP.Tasks;
const easDate = (d: Date): string => d.toISOString();

/** The email:Flag element of a message in [MS-ASEMAIL] child order. */
export function buildFlag(state: FollowUpState): WbxmlElement {
  if (state.status === 'none') return pel(E, 'Flag', []);
  const children: WbxmlElement[] = [];
  if (state.status === 'complete') {
    const done = state.completedAt ?? new Date(0);
    children.push(pel(E, 'FlagStatus', '1'), pel(E, 'FlagType', FLAG_TYPE));
    children.push(pel(T, 'DateCompleted', easDate(done)), pel(E, 'CompleteTime', easDate(done)));
  } else {
    children.push(pel(E, 'FlagStatus', '2'), pel(E, 'FlagType', FLAG_TYPE));
  }
  const due = state.dueAt;
  const start = state.startAt ?? state.dueAt;
  if (start && due) {
    children.push(
      pel(T, 'StartDate', easDate(start)), pel(T, 'UtcStartDate', easDate(start)),
      pel(T, 'DueDate', easDate(due)), pel(T, 'UtcDueDate', easDate(due)),
    );
  }
  if (state.status === 'flagged') {
    children.push(pel(T, 'ReminderSet', state.reminderAt ? '1' : '0'));
    if (state.reminderAt) children.push(pel(T, 'ReminderTime', easDate(state.reminderAt)));
  }
  return pel(E, 'Flag', children);
}

/** email:Flag of a stored message row (legacy rows: from `\Flagged`). */
export function flagOfMessage(row: FollowUpRow): WbxmlElement {
  return buildFlag(followUpOf(row));
}

export type ClientFlag =
  | { ok: true; state: Partial<FollowUpState> & { status: FollowUpStatus } }
  | { ok: false };

function dateOf(flag: WbxmlElement, name: string): Date | null | 'invalid' {
  const child = flag.children?.find((c): c is WbxmlElement => typeof c !== 'string' && c.name === name && (c.page ?? T) === T);
  const text = child?.text?.trim();
  if (!text) return null;
  const d = new Date(text);
  return isNaN(d.getTime()) ? 'invalid' : d;
}

/** Parse the email:Flag of a client Change (Sync) into a follow-up change. */
export function parseClientFlag(flag: WbxmlElement): ClientFlag {
  const children = (flag.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string');
  if (children.length === 0) return { ok: true, state: { status: 'none' } };
  const status = getChild(flag, 'FlagStatus')?.text?.trim() ?? '';
  if (status === '0') return { ok: true, state: { status: 'none' } };

  if (status === '1') {
    const completeTime = getChild(flag, 'CompleteTime')?.text?.trim();
    const dateCompleted = dateOf(flag, 'DateCompleted');
    const completedAt = completeTime ? new Date(completeTime) : null;
    if (!completedAt || isNaN(completedAt.getTime()) || dateCompleted === null || dateCompleted === 'invalid') return { ok: false };
    return { ok: true, state: { status: 'complete', completedAt } };
  }
  if (status !== '2' || !getChild(flag, 'FlagType')?.text?.trim()) return { ok: false };

  // StartDate, UtcStartDate, DueDate and UtcDueDate: all set or all absent ([MS-ASEMAIL] 2.2.2.31)
  const dates = ['StartDate', 'UtcStartDate', 'DueDate', 'UtcDueDate'].map((n) => dateOf(flag, n));
  if (dates.includes('invalid')) return { ok: false };
  const present = dates.filter((x) => x !== null).length;
  if (present !== 0 && present !== 4) return { ok: false };
  const startAt = dates[1] as Date | null;
  const dueAt = dates[3] as Date | null;
  if (startAt && dueAt && dueAt.getTime() < startAt.getTime()) return { ok: false };
  const reminderSet = getChild(flag, 'ReminderSet')?.text?.trim() === '1';
  const reminder = reminderSet ? dateOf(flag, 'ReminderTime') : null;
  if (reminder === 'invalid') return { ok: false };
  return { ok: true, state: { status: 'flagged', startAt, dueAt, reminderAt: reminder } };
}
