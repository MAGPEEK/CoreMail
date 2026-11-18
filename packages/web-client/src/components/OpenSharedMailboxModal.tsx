/**
 * "Weiteres Postfach öffnen" (profile menu) / "Postfach hinzufügen" (folder pane).
 * 9.3: lists every shared and delegated mailbox the user may read; opening one shows
 * it again in the folder pane (if it was hidden), expands it and switches the mail
 * view to it (/mail/<ref>). Mailboxes with send rights only are not listed —
 * they have no content to open (send as / on behalf is chosen in the compose window).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useState, useMemo } from 'react';
import { Inbox, Search, X, Users, User, EyeOff } from 'lucide-react';
import { Modal } from './Modal.js';
import { api } from '../api/client.js';
import { useUiPrefs } from '../store/ui.js';
import { toastError } from '../lib/errors.js';
import { mailPageUrl, mailboxTitle, permissionLabel, type AccessibleMailboxEntry } from '../lib/mailboxContext.js';
import { useAccessibleMailboxes, ACCESSIBLE_MAILBOXES_KEY } from '../hooks/useActiveMailbox.js';

const PERM_COLORS: Record<string, string> = {
  FULL_ACCESS:    'bg-success-bg text-success-fg',
  SEND_AS:        'bg-info-bg text-info-fg',
  SEND_ON_BEHALF: 'bg-info-bg text-info-fg',
  READ_ONLY:      'bg-surface-2 text-fg-muted',
};

export function OpenSharedMailboxModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const setMailboxExpanded = useUiPrefs((s) => s.setMailboxExpanded);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const { data: mailboxes = [], isLoading, error } = useAccessibleMailboxes();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return mailboxes;
    return mailboxes.filter((m) =>
      m.email.toLowerCase().includes(q) || (m.displayName ?? '').toLowerCase().includes(q),
    );
  }, [mailboxes, search]);

  const open = async (m: AccessibleMailboxEntry) => {
    setBusy(m.ref);
    try {
      if (m.hidden) {
        await api.patch(`/user/accessible-mailboxes/${encodeURIComponent(m.ref)}`, { hidden: false });
        await qc.invalidateQueries({ queryKey: ACCESSIBLE_MAILBOXES_KEY });
      }
      setMailboxExpanded(m.ref, true);
      onClose();
      navigate(mailPageUrl({ kind: m.kind, id: m.id }));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      onClose={onClose}
      labelledBy="open-mailbox-title"
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
      className="bg-surface rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div>
            <h2 id="open-mailbox-title" className="font-semibold text-fg flex items-center gap-2">
              <Inbox size={17} className="text-accent-fg" aria-hidden="true" /> Weiteres Postfach öffnen
            </h2>
            <p className="text-xs text-fg-subtle mt-0.5">
              Freigegebene und delegierte Postfächer, auf die du Zugriff hast
            </p>
          </div>
          <button aria-label="Schließen" onClick={onClose} className="text-fg-subtle hover:text-fg-muted">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-line shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Postfach suchen…"
              aria-label="Postfach suchen"
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-line-strong rounded bg-surface text-fg focus:outline-none focus:ring-1 focus:ring-accent-fg"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {isLoading ? (
            <p className="text-center text-sm text-fg-subtle py-12">Lade…</p>
          ) : error ? (
            <p role="alert" className="text-center text-sm text-danger-fg py-12">{(error as Error).message || 'Fehler beim Laden'}</p>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 px-4">
              <Inbox size={28} className="mx-auto text-fg-subtle mb-2" aria-hidden="true" />
              <p className="text-sm text-fg-subtle">
                {search ? `Kein Postfach gefunden für „${search}".` : 'Keine freigegebenen Postfächer verfügbar.'}
              </p>
              {!search && (
                <p className="text-xs text-fg-subtle mt-1">
                  Ein Administrator muss dir Zugriff auf ein Postfach gewähren.
                </p>
              )}
            </div>
          ) : (
            <ul className="space-y-1">
              {filtered.map((m) => {
                const Icon = m.kind === 'shared' ? Users : User;
                return (
                  <li key={m.ref}>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void open(m)}
                      className="w-full text-left p-3 rounded-lg transition-colors flex items-center gap-3 hover:bg-accent/5 disabled:opacity-60"
                    >
                      <div className="w-9 h-9 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
                        <Icon size={16} className="text-accent-fg" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-fg truncate">{mailboxTitle(m)}</p>
                        <p className="text-xs text-fg-subtle truncate">
                          {m.email} · {m.kind === 'shared' ? 'Freigegebenes Postfach' : 'Delegiertes Postfach'}
                        </p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {m.permissions.map((p) => (
                            <span
                              key={p}
                              className={`text-[10px] px-1.5 py-0.5 rounded ${PERM_COLORS[p] ?? 'bg-surface-2 text-fg-muted'}`}
                            >
                              {permissionLabel(p)}
                            </span>
                          ))}
                          {m.hidden && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-fg-muted inline-flex items-center gap-1">
                              <EyeOff size={10} aria-hidden="true" /> Ausgeblendet
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-accent-fg shrink-0">{m.hidden ? 'Hinzufügen' : 'Öffnen'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded hover:bg-surface-2"
          >
            Schließen
          </button>
        </div>
    </Modal>
  );
}
