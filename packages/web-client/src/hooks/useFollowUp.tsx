import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus, Check, Clock, Flag, FlagOff, Sun, Sunrise, Bell } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { ContextMenuItem } from '../components/ContextMenu.js';
import { FollowUpDialog, type FollowUpValues } from '../components/FollowUpDialog.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { toastError } from '../lib/errors.js';
import { defaultFlagReminder, flagPresetDates, type FlagPreset, type FollowUpStatus } from '../lib/followUp.js';
import { usePreferences, useRegional } from '../store/preferences.js';

/**
 * 9.4: "Kennzeichnen" — the follow-up menu of the command bar and the message
 * context menu (Heute … Kein Datum, Benutzerdefiniert, Erinnerung, erledigt,
 * löschen) and the dialog for custom dates. Own mailbox only (the API flags the
 * user's own messages); shared mailboxes keep the plain flag toggle.
 */
export interface FollowUpTarget {
  id: string;
  flagStatus: FollowUpStatus;
  flagStartAt?: string | null;
  flagDueAt?: string | null;
  flagReminderAt?: string | null;
}

const PRESETS: Array<[FlagPreset, TranslationKey, ReactNode]> = [
  ['today', 'flag_today', <Sun size={14} key="t" />],
  ['tomorrow', 'flag_tomorrow', <Sunrise size={14} key="m" />],
  ['thisWeek', 'flag_this_week', <CalendarDays size={14} key="w" />],
  ['nextWeek', 'flag_next_week', <CalendarPlus size={14} key="n" />],
  ['noDate', 'flag_no_date', <Flag size={14} key="x" />],
];

export function useFollowUp(): { menu: (targets: FollowUpTarget[]) => ContextMenuItem[]; dialog: ReactNode } {
  const t = useT();
  const qc = useQueryClient();
  const timeZone = useRegional().timeZone;
  const workDays = usePreferences((s) => s.prefs.calendar.workDays);
  const [dialog, setDialog] = useState<{ ids: string[]; initial: FollowUpValues; reminderOnly: boolean } | null>(null);

  const save = (ids: string[], body: { status: FollowUpStatus } & Partial<FollowUpValues>) =>
    api.put('/mail/follow-up', { ids, ...body })
      .then(() => {
        void qc.invalidateQueries({ queryKey: ['messages'] });
        void qc.invalidateQueries({ queryKey: ['message'] });
        void qc.invalidateQueries({ queryKey: ['follow-up'] });
      })
      .catch(toastError);

  const menu = (targets: FollowUpTarget[]): ContextMenuItem[] => {
    const ids = targets.map((m) => m.id);
    const first = targets[0];
    const anyFlag = targets.some((m) => m.flagStatus !== 'none');
    return [
      ...PRESETS.map(([preset, key, icon]): ContextMenuItem => ({
        label: t(key), icon,
        onClick: () => { void save(ids, { status: 'flagged', ...flagPresetDates(preset, new Date(), timeZone, workDays) }); },
      })),
      {
        label: t('flag_custom'), icon: <Clock size={14} />, separator: 'before',
        onClick: () => setDialog({ ids, reminderOnly: false, initial: { startAt: first?.flagStartAt ?? null, dueAt: first?.flagDueAt ?? null, reminderAt: first?.flagReminderAt ?? null } }),
      },
      {
        label: t('flag_add_reminder'), icon: <Bell size={14} />,
        onClick: () => setDialog({
          ids, reminderOnly: true,
          initial: { startAt: first?.flagStartAt ?? null, dueAt: first?.flagDueAt ?? null, reminderAt: first?.flagReminderAt ?? defaultFlagReminder(first?.flagDueAt ?? null, new Date(), timeZone) },
        }),
      },
      { label: t('flag_mark_complete'), icon: <Check size={14} />, separator: 'before', onClick: () => { void save(ids, { status: 'complete' }); } },
      ...(anyFlag ? [{ label: t('flag_clear'), icon: <FlagOff size={14} />, onClick: () => { void save(ids, { status: 'none' }); } }] : []),
    ];
  };

  const node = dialog && (
    <FollowUpDialog
      initial={dialog.initial}
      timeZone={timeZone}
      reminderOnly={dialog.reminderOnly}
      onClose={() => setDialog(null)}
      onSave={(values) => {
        const ids = dialog.ids;
        setDialog(null);
        const body = dialog.reminderOnly ? { status: 'flagged' as const, reminderAt: values.reminderAt } : { status: 'flagged' as const, ...values };
        void save(ids, body).then(() => toast.success(t('flag_saved')));
      }}
    />
  );
  return { menu, dialog: node };
}
