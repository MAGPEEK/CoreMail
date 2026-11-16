import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useState, useMemo } from 'react';
import { Inbox, Search, X, ExternalLink, Lock } from 'lucide-react';
import { Modal } from './Modal.js';
import { api } from '../api/client.js';

interface SharedMailboxEntry {
  id:          string;
  email:       string;
  displayName: string;
  active:      boolean;
  permissions: string[]; // ['FULL_ACCESS','SEND_AS',...]
}

const PERM_LABELS: Record<string, string> = {
  FULL_ACCESS:    'Vollzugriff',
  SEND_AS:        'Senden als',
  SEND_ON_BEHALF: 'Im Auftrag',
  READ_ONLY:      'Nur Lesen',
};

const PERM_COLORS: Record<string, string> = {
  FULL_ACCESS:    'bg-success-bg text-success-fg',
  SEND_AS:        'bg-info-bg text-info-fg',
  SEND_ON_BEHALF: 'bg-info-bg text-info-fg',
  READ_ONLY:      'bg-surface-2 text-fg-muted',
};

export function OpenSharedMailboxModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  const { data: mailboxes = [], isLoading, error } = useQuery<SharedMailboxEntry[]>({
    queryKey: ['user-shared-mailboxes'],
    queryFn:  () => api.get('/user/shared-mailboxes'),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return mailboxes;
    return mailboxes.filter((m) =>
      m.email.toLowerCase().includes(q) || (m.displayName ?? '').toLowerCase().includes(q),
    );
  }, [mailboxes, search]);

  const canRead = (m: SharedMailboxEntry) =>
    m.permissions.includes('FULL_ACCESS') || m.permissions.includes('READ_ONLY');

  const open = (m: SharedMailboxEntry) => {
    if (!canRead(m)) return;
    // Open in the same tab — nicer than window.open for a seamless switch.
    // Anyone wanting a separate view can Cmd/Ctrl+click → new tab.
    onClose();
    navigate(`/shared-mailbox/${m.id}`);
  };

  return (
    <Modal
      onClose={onClose}
      label="Weiteres Postfach öffnen"
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
      className="bg-surface rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div>
            <h2 className="font-semibold text-fg flex items-center gap-2">
              <Inbox size={17} className="text-accent-fg" /> Weiteres Postfach öffnen
            </h2>
            <p className="text-xs text-fg-subtle mt-0.5">
              Freigegebene Postfächer, auf die du Zugriff hast
            </p>
          </div>
          <button aria-label="Schließen" onClick={onClose} className="text-fg-subtle hover:text-fg-muted">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-line shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Postfach suchen…"
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-line-strong rounded bg-surface text-fg focus:outline-none focus:ring-1 focus:ring-accent-fg"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {isLoading ? (
            <p className="text-center text-sm text-fg-subtle py-12">Lade…</p>
          ) : error ? (
            <p className="text-center text-sm text-danger-fg py-12">{(error as Error).message || 'Fehler beim Laden'}</p>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 px-4">
              <Inbox size={28} className="mx-auto text-fg-subtle mb-2" />
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
            <div className="space-y-1">
              {filtered.map((m) => {
                const readable = canRead(m);
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={!readable}
                    onClick={() => open(m)}
                    title={
                      !readable
                        ? 'Du hast keine Lese-Berechtigung (FULL_ACCESS oder READ_ONLY)'
                        : 'Öffnen'
                    }
                    className={`w-full text-left p-3 rounded-lg transition-colors flex items-center gap-3 ${
                      readable
                        ? 'hover:bg-accent/5 cursor-pointer'
                        : 'opacity-60 cursor-not-allowed'
                    }`}
                  >
                    <div className="w-9 h-9 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
                      <Inbox size={16} className="text-accent-fg" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-fg truncate">
                        {m.displayName || m.email}
                      </p>
                      <p className="text-xs text-fg-subtle truncate">{m.email}</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {m.permissions.map((p) => (
                          <span
                            key={p}
                            className={`text-[10px] px-1.5 py-0.5 rounded ${PERM_COLORS[p] ?? 'bg-surface-2 text-fg-muted'}`}
                          >
                            {PERM_LABELS[p] ?? p}
                          </span>
                        ))}
                      </div>
                    </div>
                    {readable ? (
                      <ExternalLink size={14} className="text-fg-subtle shrink-0" />
                    ) : (
                      <Lock size={14} className="text-fg-subtle shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
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
