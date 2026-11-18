import toast from 'react-hot-toast';
import { Bell } from 'lucide-react';
import { useT } from '../i18n/useT.js';
import { useWebPush } from '../hooks/useWebPush.js';
import { availabilityHint } from '../lib/webPush.js';

/**
 * 9.4 Settings → Benachrichtigungen: Web Push for new mail on THIS device
 * (opt-in), optionally with sender and subject. Without the preview the
 * notification only says that new mail arrived (lock screens).
 */
export function NotificationsSection() {
  const t = useT();
  const push = useWebPush();
  const hint = availabilityHint(push.availability);
  const canToggle = !hint && push.enabled !== null && !push.busy;

  const run = (fn: () => Promise<void>, done: string) => {
    fn().then(() => toast.success(done), (err: unknown) => {
      toast.error(err instanceof Error && err.message ? err.message : 'Die Einstellung konnte nicht gespeichert werden');
    });
  };

  return (
    <section>
      <h2 className="text-xl font-semibold text-fg mb-1">{t('section_notifications')}</h2>
      <p className="text-sm text-fg-muted mb-6">
        Benachrichtigungen über neue Nachrichten auf diesem Gerät — auch wenn das Postfach nicht geöffnet ist.
      </p>

      {hint && <p className="text-sm text-fg-muted mb-4" role="status">{hint}</p>}

      <label className={`flex items-start gap-3 p-4 rounded-md border border-line transition-colors ${canToggle ? 'hover:border-line-strong cursor-pointer' : 'opacity-60'}`}>
        <input
          type="checkbox"
          checked={!!push.enabled}
          disabled={!canToggle}
          onChange={(e) => run(
            e.target.checked ? push.enable : push.disable,
            e.target.checked ? 'Benachrichtigungen aktiviert' : 'Benachrichtigungen deaktiviert',
          )}
          className="mt-0.5 rounded border-line-strong text-accent-fg focus:ring-accent-fg"
        />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <Bell size={16} className="text-fg-subtle" />
            <span className="text-sm font-medium text-fg">Bei neuen Nachrichten benachrichtigen</span>
          </div>
          <p className="text-xs text-fg-subtle mt-0.5">Gilt nur für diesen Browser auf diesem Gerät.</p>
        </div>
      </label>

      <label className={`mt-3 flex items-start gap-3 p-4 rounded-md border border-line transition-colors ${push.enabled && !push.busy ? 'hover:border-line-strong cursor-pointer' : 'opacity-60'}`}>
        <input
          type="checkbox"
          checked={push.showPreview}
          disabled={!push.enabled || push.busy}
          onChange={(e) => run(() => push.setShowPreview(e.target.checked), 'Einstellung gespeichert')}
          className="mt-0.5 rounded border-line-strong text-accent-fg focus:ring-accent-fg"
        />
        <div className="flex-1">
          <span className="text-sm font-medium text-fg">Absender und Betreff anzeigen</span>
          <p className="text-xs text-fg-subtle mt-0.5">
            Ohne diese Option zeigt die Benachrichtigung nur, dass eine neue Nachricht eingegangen ist.
          </p>
        </div>
      </label>
    </section>
  );
}
