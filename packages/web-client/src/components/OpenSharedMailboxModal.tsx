import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useState, useMemo } from 'react';
import { Inbox, Search, X, ExternalLink, Lock } from 'lucide-react';
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
  FULL_ACCESS:    'bg-emerald-100 text-emerald-700',
  SEND_AS:        'bg-blue-100 text-blue-700',
  SEND_ON_BEHALF: 'bg-indigo-100 text-indigo-700',
  READ_ONLY:      'bg-gray-100 text-gray-700',
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
    // Im selben Tab öffnen — schöner als window.open für nahtlosen Wechsel.
    // Wer eine separate Ansicht möchte, kann Cmd/Ctrl+Klick → neuer Tab.
    onClose();
    navigate(`/shared-mailbox/${m.id}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div>
            <h2 className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Inbox size={17} className="text-accent" /> Weiteres Postfach öffnen
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Freigegebene Postfächer, auf die du Zugriff hast
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Postfach suchen…"
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {isLoading ? (
            <p className="text-center text-sm text-gray-400 py-12">Lade…</p>
          ) : error ? (
            <p className="text-center text-sm text-red-500 py-12">{(error as Error).message || 'Fehler beim Laden'}</p>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 px-4">
              <Inbox size={28} className="mx-auto text-gray-300 mb-2" />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {search ? `Kein Postfach gefunden für „${search}".` : 'Keine freigegebenen Postfächer verfügbar.'}
              </p>
              {!search && (
                <p className="text-xs text-gray-400 mt-1">
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
                      <Inbox size={16} className="text-accent" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {m.displayName || m.email}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{m.email}</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {m.permissions.map((p) => (
                          <span
                            key={p}
                            className={`text-[10px] px-1.5 py-0.5 rounded ${PERM_COLORS[p] ?? 'bg-gray-100 text-gray-700'}`}
                          >
                            {PERM_LABELS[p] ?? p}
                          </span>
                        ))}
                      </div>
                    </div>
                    {readable ? (
                      <ExternalLink size={14} className="text-gray-400 shrink-0" />
                    ) : (
                      <Lock size={14} className="text-gray-300 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
