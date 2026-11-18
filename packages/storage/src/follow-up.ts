/**
 * 9.4: follow-up flags of messages ("Zur Nachverfolgung") — the pure rules.
 *
 * The flag is a property of the message row (Message.flagStatus + dates). The
 * IMAP keyword `\Flagged` (JMAP `$flagged`) stays its boolean view:
 *
 *   flagged  ⇔ \Flagged set
 *   complete → \Flagged cleared, completion time kept
 *   none     → \Flagged cleared, all dates cleared
 *
 * message-store applies these rules on every write, whichever protocol sets the
 * keyword or the flag, so the two never drift apart. Rows written before 9.4 have
 * flagStatus 'none' — {@link followUpOf} derives 'flagged' from `\Flagged` for them.
 */

export const FLAGGED_KEYWORD = '\\Flagged';

export type FollowUpStatus = 'none' | 'flagged' | 'complete';
export const FOLLOW_UP_STATUSES: readonly FollowUpStatus[] = ['none', 'flagged', 'complete'];

export interface FollowUpState {
  status: FollowUpStatus;
  startAt: Date | null;
  dueAt: Date | null;
  reminderAt: Date | null;
  completedAt: Date | null;
}

/** The message columns that hold the follow-up flag. */
export interface FollowUpColumns {
  flagStatus: FollowUpStatus;
  flagStartAt: Date | null;
  flagDueAt: Date | null;
  flagReminderAt: Date | null;
  flagCompletedAt: Date | null;
}

export interface FollowUpRow {
  flags: readonly string[];
  flagStatus?: string | null;
  flagStartAt?: Date | null;
  flagDueAt?: Date | null;
  flagReminderAt?: Date | null;
  flagCompletedAt?: Date | null;
}

export const FOLLOW_UP_SELECT = {
  flags: true, flagStatus: true, flagStartAt: true, flagDueAt: true, flagReminderAt: true, flagCompletedAt: true,
} as const;

function normStatus(v: string | null | undefined): FollowUpStatus {
  return v === 'flagged' || v === 'complete' ? v : 'none';
}

/** The effective follow-up state of a stored row (legacy rows: from `\Flagged`). */
export function followUpOf(row: FollowUpRow): FollowUpState {
  const stored = normStatus(row.flagStatus);
  const status: FollowUpStatus = stored === 'none' && row.flags.includes(FLAGGED_KEYWORD) ? 'flagged' : stored;
  return {
    status,
    startAt: status === 'none' ? null : row.flagStartAt ?? null,
    dueAt: status === 'none' ? null : row.flagDueAt ?? null,
    reminderAt: status === 'flagged' ? row.flagReminderAt ?? null : null,
    completedAt: status === 'complete' ? row.flagCompletedAt ?? null : null,
  };
}

/**
 * Normalise a requested state: 'none' drops every date, 'complete' drops the
 * reminder and gets a completion time (now when none is given), 'flagged' has no
 * completion time. A due date before the start date moves the start to the due date.
 */
export function normalizeFollowUp(state: Partial<FollowUpState> & { status: FollowUpStatus }, now: Date): FollowUpState {
  if (state.status === 'none') return { status: 'none', startAt: null, dueAt: null, reminderAt: null, completedAt: null };
  const dueAt = state.dueAt ?? null;
  let startAt = state.startAt ?? null;
  if (dueAt && startAt && startAt.getTime() > dueAt.getTime()) startAt = dueAt;
  if (state.status === 'complete') {
    return { status: 'complete', startAt, dueAt, reminderAt: null, completedAt: state.completedAt ?? now };
  }
  return { status: 'flagged', startAt, dueAt, reminderAt: state.reminderAt ?? null, completedAt: null };
}

export function followUpColumns(state: FollowUpState): FollowUpColumns {
  return {
    flagStatus: state.status,
    flagStartAt: state.startAt,
    flagDueAt: state.dueAt,
    flagReminderAt: state.reminderAt,
    flagCompletedAt: state.completedAt,
  };
}

/** The keyword list for a follow-up status (`\Flagged` exactly when flagged). */
export function flagsForFollowUp(flags: readonly string[], status: FollowUpStatus): string[] {
  const rest = flags.filter((f) => f !== FLAGGED_KEYWORD);
  return status === 'flagged' ? [...rest, FLAGGED_KEYWORD] : rest;
}

/**
 * Column changes implied by a keyword change (IMAP STORE, JMAP keywords, REST
 * flag toggles, EAS): setting `\Flagged` flags the message (dates kept, completion
 * cleared); clearing it on a flagged message clears the flag; a completed message
 * stays complete. Null when the columns already match.
 */
export function followUpAfterKeywords(row: FollowUpRow, nextFlags: readonly string[]): Partial<FollowUpColumns> | null {
  const stored = normStatus(row.flagStatus);
  const flagged = nextFlags.includes(FLAGGED_KEYWORD);
  if (flagged) {
    return stored === 'flagged' ? null : { flagStatus: 'flagged', flagCompletedAt: null };
  }
  if (stored !== 'flagged') return null;
  return followUpColumns(normalizeFollowUp({ status: 'none' }, new Date()));
}

/**
 * Bulk form of {@link followUpAfterKeywords} for one keyword list written to many
 * rows (message-store touchMessages): the stored status that changes (`from`, a
 * Prisma filter on flagStatus) and its new columns. The outcome only depends on
 * the stored status, so one `UPDATE … WHERE flagStatus …` keeps every row in step
 * without reading them.
 */
export function followUpBulkAfterKeywords(
  nextFlags: readonly string[],
): { from: { not: 'flagged' } | 'flagged'; data: Partial<FollowUpColumns> } {
  return nextFlags.includes(FLAGGED_KEYWORD)
    ? { from: { not: 'flagged' }, data: { flagStatus: 'flagged', flagCompletedAt: null } }
    : { from: 'flagged', data: followUpColumns(normalizeFollowUp({ status: 'none' }, new Date())) };
}

/** Follow-up columns of a newly created row whose keywords include `\Flagged`. */
export function followUpForNewRow(data: { flags?: unknown; flagStatus?: unknown }): Partial<FollowUpColumns> {
  if (data.flagStatus !== undefined) return {};
  const flags = Array.isArray(data.flags) ? data.flags : [];
  return flags.includes(FLAGGED_KEYWORD) ? { flagStatus: 'flagged' } : {};
}
