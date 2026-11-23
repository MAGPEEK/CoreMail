/**
 * 10.7: the panel of the rail bell — notifications that arrived in this session
 * (store/notifications.ts: new mail with sender / subject, reminders, calendar
 * shares). A click on an entry opens it (the mail in its mailbox, the calendar,
 * the tasks). Empty: "Keine neuen Benachrichtigungen" + a link to Settings →
 * Benachrichtigungen. A non-modal dialog next to the bell: it takes focus,
 * Escape / outside click close it and focus returns to the bell. Opening marks
 * every entry read (the badge disappears).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Bell, CalendarDays, Mail, X } from 'lucide-react';
import { useNotifications } from '../store/notifications.js';
import type { NotificationKind } from '../lib/notifications.js';
import { useRegional } from '../store/preferences.js';
import { formatListDate } from '../lib/regionalFormat.js';
import { useT } from '../i18n/useT.js';

const KIND_ICON: Record<NotificationKind, typeof Mail> = { mail: Mail, reminder: Bell, calendar: CalendarDays };
const KIND_LABEL = { mail: 'notifications_kind_mail', reminder: 'notifications_kind_reminder', calendar: 'notifications_kind_calendar' } as const;

interface Props {
  /** The bell (focus returns to it, the panel is placed next to it). */
  anchor: HTMLElement;
  onClose: () => void;
}

export function NotificationsPanel({ anchor, onClose }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const regional = useRegional();
  const items = useNotifications((s) => s.items);
  const clear = useNotifications((s) => s.clear);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  // Opening the panel reads the entries: the badge goes away
  useEffect(() => { useNotifications.getState().markAllRead(); }, [items.length]);

  // Wide screens: right of the rail, bottom-aligned with the bell; the bottom bar: above it
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const narrow = window.innerWidth < 768;
    const left = narrow ? Math.max(8, window.innerWidth - r.width - 8) : a.right + 8;
    const top = narrow ? Math.max(8, a.top - r.height - 8) : Math.max(8, Math.min(a.bottom - r.height, window.innerHeight - r.height - 8));
    setPos({ left, top });
  }, [anchor, items.length]);

  const close = () => {
    onClose();
    if (anchor.isConnected) anchor.focus();
  };

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Focus moves into the panel once when it opens; a click outside closes it
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, a')?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) onCloseRef.current();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor]);

  const open = (href: string | null) => {
    onClose();
    if (href) navigate(href);
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t('notifications_title')}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-[95] w-80 max-w-[calc(100vw-16px)] max-h-[70vh] flex flex-col bg-surface border border-line rounded-xl shadow-xl animate-fly-in"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <h2 className="flex-1 text-sm font-semibold text-fg">{t('notifications_title')}</h2>
        {items.length > 0 && (
          <button type="button" onClick={clear} className="text-xs text-accent-fg hover:underline px-1 rounded">
            {t('notifications_clear')}
          </button>
        )}
        <button type="button" onClick={close} aria-label={t('compose_close')} title={t('compose_close')}
          className="p-1 rounded text-fg-subtle hover:bg-surface-2 hover:text-fg">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {items.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <Bell size={22} className="mx-auto text-fg-subtle" aria-hidden="true" />
          <p className="mt-2 text-sm text-fg-muted">{t('notifications_empty')}</p>
          <button type="button" onClick={() => open('/settings#notifications')} className="mt-3 text-xs font-medium text-accent-fg hover:underline">
            {t('notifications_settings_link')}
          </button>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto py-1">
          {items.map((n) => {
            const Icon = KIND_ICON[n.kind];
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => open(n.href)}
                  className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-2 focus-visible:bg-surface-2"
                >
                  <Icon size={15} className="mt-0.5 shrink-0 text-accent-fg" aria-hidden="true" />
                  <span className="flex-1 min-w-0">
                    <span className="sr-only">{t(KIND_LABEL[n.kind])}: </span>
                    <span className="block text-sm font-medium text-fg truncate">{n.title}</span>
                    {n.detail && <span className="block text-xs text-fg-muted truncate">{n.detail}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-fg-subtle">{formatListDate(new Date(n.at), new Date(), regional, 'Gestern')}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > 0 && (
        <div className="border-t border-line px-3 py-2">
          <button type="button" onClick={() => open('/settings#notifications')} className="text-xs font-medium text-accent-fg hover:underline">
            {t('notifications_settings_link')}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
