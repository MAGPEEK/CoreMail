import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Share2, Eye, UserPlus, Copy, Link as LinkIcon, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { Calendar, CalendarShare } from '../api/types.js';
import { useT } from '../i18n/useT.js';

/**
 * v3.18.14 Calendar Sharing — Dialog zum Verwalten der Freigaben eines eigenen
 * Kalenders. Wird über Sidebar-Kontextmenü „Teilen und Berechtigungen" geöffnet,
 * oder über den Toolbar-Button „Kalender teilen" (dann mit `allowCalendarPicker`).
 *
 * v3.18.18: erweitert um (1) Kalender-Picker im Header wenn aus Toolbar
 * aufgerufen, (2) CalDAV-URL-Sektion am Ende für externen Zugriff.
 *
 * Funktionen:
 *  - Benutzer-Autocomplete (reuse `/contacts?q=`)
 *  - Permission-Select: Read / Read+Write
 *  - Liste bestehender Freigaben mit Permission-Toggle und Löschen
 *  - CalDAV-URLs zum Kopieren (Account-URL + Pro-Kalender-URL)
 */

interface ContactSuggest {
  id: string;
  displayName: string;
  email: string;
  company?: string;
  isGroup?: boolean;
}

interface CalDavInfo {
  accountUrl: string;
  username: string;
  authHint: string;
  calendars: Array<{
    id: string;
    name: string;
    isDefault: boolean;
    url: string;
  }>;
}

type Perm = 'READ' | 'WRITE';

export function ShareCalendarDialog({
  calendar: initialCalendar,
  onClose,
  /** Liste eigener Kalender für Picker-Modus (Toolbar-Aufruf) */
  ownedCalendars,
}: {
  calendar: Calendar;
  onClose: () => void;
  ownedCalendars?: Calendar[];
}) {
  const qc = useQueryClient();
  const t = useT();

  // v3.18.18: Wenn ownedCalendars übergeben → Picker-Modus
  const [selectedCalId, setSelectedCalId] = useState<string>(initialCalendar.id);
  const calendar = useMemo(() => {
    if (!ownedCalendars) return initialCalendar;
    return ownedCalendars.find((c) => c.id === selectedCalId) ?? initialCalendar;
  }, [ownedCalendars, selectedCalId, initialCalendar]);

  const [search, setSearch] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [permission, setPermission] = useState<Perm>('READ');
  const [showSug, setShowSug] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Liste bestehender Freigaben für aktuell selektierten Kalender
  const { data: shares = [], isLoading: sharesLoading } = useQuery<CalendarShare[]>({
    queryKey: ['calendar-shares', calendar.id],
    queryFn: () => api.get<CalendarShare[]>(`/calendar/${calendar.id}/shares`),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  // v3.18.18: CalDAV-URLs einmal laden (für alle eigenen Kalender)
  const { data: caldavInfo } = useQuery<CalDavInfo>({
    queryKey: ['caldav-info'],
    queryFn: () => api.get<CalDavInfo>('/calendar/caldav-info'),
    staleTime: 5 * 60_000,
  });

  // Aktuelle CalDAV-URL für den selektierten Kalender finden
  const currentCalDavUrl = caldavInfo?.calendars.find((c) => c.id === calendar.id)?.url ?? '';

  // Auto-Filter: bereits zugewiesene User aus Vorschlägen ausblenden
  const assignedIds = new Set(shares.map((s) => s.granteeId));

  // Suggest-Query (nur User-Treffer)
  const { data: contacts = [] } = useQuery<ContactSuggest[]>({
    queryKey: ['contact-suggest-share', debouncedQ],
    queryFn: () => api.get<ContactSuggest[]>(`/contacts?q=${encodeURIComponent(debouncedQ)}`),
    enabled: debouncedQ.length >= 1,
    staleTime: 30_000,
  });

  const suggestions: ContactSuggest[] = contacts
    .filter((c) => c.id.startsWith('gal-') && !c.isGroup)
    .map((c) => ({ ...c, id: c.id.replace(/^gal-/, '') }))
    .filter((c) => !assignedIds.has(c.id));

  const onSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setSearch(v);
    setActiveIdx(0);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (v.length >= 1) {
      setShowSug(true);
      debounceTimer.current = setTimeout(() => setDebouncedQ(v), 220);
    } else {
      setShowSug(false);
      setDebouncedQ('');
    }
  };

  const addShare = useMutation({
    mutationFn: (vars: { granteeId: string; permission: Perm }) =>
      api.post<CalendarShare>(`/calendar/${calendar.id}/shares`, vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['calendar-shares', calendar.id] });
      void qc.invalidateQueries({ queryKey: ['calendars'] });
      setSearch(''); setDebouncedQ(''); setShowSug(false);
      toast.success('✓');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateShare = useMutation({
    mutationFn: (vars: { shareId: string; permission: Perm }) =>
      api.put<CalendarShare>(`/calendar/${calendar.id}/shares/${vars.shareId}`, {
        permission: vars.permission,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['calendar-shares', calendar.id] });
      void qc.invalidateQueries({ queryKey: ['calendars'] });
      toast.success('✓');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeShare = useMutation({
    mutationFn: (shareId: string) =>
      api.delete(`/calendar/${calendar.id}/shares/${shareId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['calendar-shares', calendar.id] });
      void qc.invalidateQueries({ queryKey: ['calendars'] });
      toast.success(t('cal_share_remove'));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pickSuggestion = useCallback((c: ContactSuggest) => {
    addShare.mutate({ granteeId: c.id, permission });
  }, [addShare, permission]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSug || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => (i + 1) % suggestions.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      const pick = suggestions[activeIdx];
      if (pick) { e.preventDefault(); pickSuggestion(pick); }
    } else if (e.key === 'Escape') {
      setShowSug(false);
    }
  };

  const copyToClipboard = async (text: string, label = 'URL') => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} kopiert`);
    } catch {
      toast.error('Kopieren fehlgeschlagen');
    }
  };

  useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
  }, []);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <Share2 size={18} className="text-accent shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t('cal_share_title')}
              </h2>
              {ownedCalendars && ownedCalendars.length > 1 ? (
                /* v3.18.18: Calendar-Picker im Header bei Toolbar-Aufruf */
                <div className="relative mt-0.5">
                  <select
                    value={selectedCalId}
                    onChange={(e) => setSelectedCalId(e.target.value)}
                    className="text-xs bg-transparent border-0 pl-0 pr-5 py-0 text-gray-500 dark:text-gray-400 focus:outline-none focus:ring-0 appearance-none cursor-pointer hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    {ownedCalendars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}{c.isDefault ? ' (Standard)' : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={11} className="absolute right-0 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                </div>
              ) : (
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ backgroundColor: calendar.color }} />
                  {calendar.name}
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none ml-2"
            aria-label="×">
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* Permission-Auswahl + Input */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('cal_share_add_user')}
            </label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <UserPlus size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  ref={inputRef}
                  type="text"
                  value={search}
                  onChange={onSearchChange}
                  onKeyDown={onKeyDown}
                  onFocus={() => { if (suggestions.length > 0) setShowSug(true); }}
                  placeholder={t('cal_share_add_user')}
                  className="w-full border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                />
                {showSug && suggestions.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-10 max-h-60 overflow-y-auto">
                    {suggestions.map((c, idx) => (
                      <button
                        key={c.id}
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); pickSuggestion(c); }}
                        onMouseEnter={() => setActiveIdx(idx)}
                        className={`w-full text-left px-3 py-2 text-sm border-b border-gray-100 dark:border-gray-700 last:border-b-0 ${idx === activeIdx ? 'bg-accent/10' : 'hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                      >
                        <div className="font-medium text-gray-900 dark:text-gray-100 truncate">{c.displayName}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{c.email}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <select
                value={permission}
                onChange={(e) => setPermission(e.target.value as Perm)}
                className="border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="READ">{t('cal_share_perm_read')}</option>
                <option value="WRITE">{t('cal_share_perm_write')}</option>
              </select>
            </div>
            {debouncedQ.length >= 1 && suggestions.length === 0 && (
              <p className="text-xs text-gray-400 mt-1.5">{t('cal_share_no_users_found')}</p>
            )}
          </div>

          {/* Bestehende Freigaben */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('cal_share_current')}
            </label>
            {sharesLoading ? (
              <p className="text-sm text-gray-400 py-2">…</p>
            ) : shares.length === 0 ? (
              <div className="border border-dashed border-gray-200 dark:border-gray-700 rounded p-4 text-center">
                <Share2 size={20} className="mx-auto text-gray-300 mb-1.5" />
                <p className="text-sm text-gray-400">{t('cal_share_empty')}</p>
              </div>
            ) : (
              <ul className="border border-gray-200 dark:border-gray-700 rounded divide-y divide-gray-100 dark:divide-gray-700">
                {shares.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="w-8 h-8 rounded-full bg-accent/10 text-accent flex items-center justify-center text-xs font-semibold shrink-0">
                      {(s.granteeDisplayName || s.granteeEmail).slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {s.granteeDisplayName}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.granteeEmail}</p>
                    </div>
                    <select
                      value={s.permission}
                      onChange={(e) => updateShare.mutate({ shareId: s.id, permission: e.target.value as Perm })}
                      disabled={updateShare.isPending}
                      className="text-xs border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                    >
                      <option value="READ">{t('cal_share_perm_read')}</option>
                      <option value="WRITE">{t('cal_share_perm_write')}</option>
                    </select>
                    <button
                      onClick={() => {
                        if (window.confirm(t('cal_share_remove_confirm'))) {
                          removeShare.mutate(s.id);
                        }
                      }}
                      disabled={removeShare.isPending}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded disabled:opacity-50"
                      aria-label={t('cal_share_remove')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Hinweis Permissions */}
          <div className="bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded p-3 text-xs text-blue-700 dark:text-blue-300">
            <div className="flex items-start gap-2">
              <Eye size={14} className="mt-0.5 shrink-0" />
              <div>
                {t('cal_share_help_read')}<br />
                {t('cal_share_help_write')}<br />
                <span className="block mt-1 text-blue-600/70 dark:text-blue-400/70">
                  {t('cal_share_help_caldav')}
                </span>
              </div>
            </div>
          </div>

          {/* v3.18.18: CalDAV-URL für externen Zugriff */}
          {caldavInfo && (
            <div className="border border-gray-200 dark:border-gray-700 rounded p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300">
                <LinkIcon size={14} className="text-accent" />
                Externer Zugriff (CalDAV)
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Für Apple Kalender, Thunderbird Lightning, DAVx⁵ usw.
              </div>

              {/* Account-URL (Auto-Discovery) */}
              <div>
                <label className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mt-2 mb-1">
                  Account-URL (Auto-Discovery, empfohlen)
                </label>
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 px-2 py-1.5 text-[11px] bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded font-mono text-gray-700 dark:text-gray-200 truncate">
                    {caldavInfo.accountUrl}
                  </code>
                  <button
                    onClick={() => copyToClipboard(caldavInfo.accountUrl, 'Account-URL')}
                    className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded shrink-0"
                    aria-label="Kopieren"
                    title="Account-URL kopieren"
                  >
                    <Copy size={13} />
                  </button>
                </div>
              </div>

              {/* Pro-Kalender-URL (nur aktuell selektierten zeigen) */}
              {currentCalDavUrl && (
                <div>
                  <label className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mt-2 mb-1">
                    Direkte URL für „{calendar.name}"
                  </label>
                  <div className="flex items-center gap-1.5">
                    <code className="flex-1 px-2 py-1.5 text-[11px] bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded font-mono text-gray-700 dark:text-gray-200 truncate">
                      {currentCalDavUrl}
                    </code>
                    <button
                      onClick={() => copyToClipboard(currentCalDavUrl, 'Kalender-URL')}
                      className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded shrink-0"
                      aria-label="Kopieren"
                      title="Kalender-URL kopieren"
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700/50">
                <div className="flex flex-col gap-0.5 text-[11px] text-gray-600 dark:text-gray-400">
                  <div><strong>Benutzer:</strong> <span className="font-mono">{caldavInfo.username}</span></div>
                  <div className="text-amber-600 dark:text-amber-400">
                    <strong>Passwort:</strong> App-Passwort erforderlich
                    (Einstellungen → Sicherheit → App-Passwörter)
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end">
          <button onClick={onClose}
            className="px-4 py-1.5 text-sm text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-800">
            {t('cal_share_done')}
          </button>
        </div>
      </div>
    </div>
  );
}
