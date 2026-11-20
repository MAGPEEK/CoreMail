/**
 * 10.2: suggestions of a mail search field (message list + header): server
 * suggestions for the mailbox shown in the mail view, the recent searches of the
 * user and the combobox state (open, highlighted entry). The field renders
 * <SearchSuggestList> with what this hook returns; the rules live in
 * lib/searchSuggest.ts and lib/recentSearches.ts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import { useActiveMailbox } from './useActiveMailbox.js';
import { useOwnProfile } from './useUserPhoto.js';
import { mailPath } from '../lib/mailLinks.js';
import {
  SUGGEST_DEBOUNCE_MS, comboKey, keepActive, searchForPick, suggestGroups, suggestTerm,
  type MessageSuggestion, type SearchScope, type SuggestGroup, type SuggestItem, type SuggestResponse,
} from '../lib/searchSuggest.js';
import {
  addRecentSearch, browserStorage, loadRecentSearches, removeRecentSearch, saveRecentSearches,
} from '../lib/recentSearches.js';

function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The user the recent searches belong to (a restored session knows it from the profile). */
function useRecentSearchUser(): string | null {
  const userId = useAuthStore((s) => s.userId);
  const { data: profile } = useOwnProfile();
  return userId ?? profile?.id ?? null;
}

export interface SearchComboOptions {
  /** The field's text. */
  text: string;
  /** DOM id of the listbox (option ids derive from it). */
  listId: string;
  /**
   * Runs a search for exactly this term (a picked person or recent search). `scope`
   * 'all' = search the whole mailbox (a picked person); null = keep the scope.
   */
  onSearch: (term: string, scope: SearchScope | null) => void;
  /** After a picked message was opened (its deep link) — e.g. clear the field. */
  onOpenedMessage?: (message: MessageSuggestion) => void;
}

export interface SearchCombo {
  /** Spread onto the <input>: combobox role and ARIA state. */
  inputAria: Record<string, string | boolean>;
  /** Input handlers; onKeyDown answers whether it handled the key. */
  onFocus: () => void;
  onBlur: () => void;
  onTextChange: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => boolean;
  /** For <SearchSuggestList>. */
  shown: boolean;
  groups: SuggestGroup[];
  flat: SuggestItem[];
  active: number;
  optionId: (index: number) => string;
  select: (item: SuggestItem) => void;
  removeRecent: (term: string) => void;
}

export function useSearchCombobox({ text, listId, onSearch, onOpenedMessage }: SearchComboOptions): SearchCombo {
  const navigate = useNavigate();
  const mailbox = useActiveMailbox();
  const userKey = useRecentSearchUser();
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => loadRecentSearches(browserStorage(), userKey));
  useEffect(() => { setRecent(loadRecentSearches(browserStorage(), userKey)); }, [userKey]);

  // Debounced term; a newer term aborts the request of the stale one (signal), and the
  // previous answer stays on screen until the new one arrives (keepPreviousData).
  const term = useDebouncedValue(suggestTerm(text), SUGGEST_DEBOUNCE_MS);
  const { data } = useQuery({
    queryKey: ['search-suggest', mailbox.key, term],
    queryFn: ({ signal }) => api.get<SuggestResponse>(`${mailbox.base}/search/suggest?q=${encodeURIComponent(term)}`, { signal }),
    enabled: term !== '',
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });

  const { groups, flat } = useMemo(() => suggestGroups(text, data, recent), [text, data, recent]);
  const active = keepActive(activeKey, flat);
  const shown = open && flat.length > 0;
  const optionId = useCallback((index: number) => `${listId}-opt-${index}`, [listId]);

  const updateRecent = useCallback((change: (list: string[]) => string[]) => {
    setRecent((prev) => {
      const next = change(prev);
      saveRecentSearches(browserStorage(), userKey, next);
      return next;
    });
  }, [userKey]);
  const remember = useCallback((t: string) => updateRecent((l) => addRecentSearch(l, t)), [updateRecent]);
  const removeRecent = useCallback((t: string) => updateRecent((l) => removeRecentSearch(l, t)), [updateRecent]);

  const close = () => { setOpen(false); setActiveKey(null); };

  const select = (item: SuggestItem) => {
    close();
    const search = searchForPick(item);
    if (search) {
      remember(search.term);
      onSearch(search.term, search.scope);
    } else if (item.kind === 'message') {
      navigate(mailPath(mailbox.ref, item.message.folderId, item.message.id));
      onOpenedMessage?.(item.message);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    const action = comboKey(e.key, { open: shown, count: flat.length, active, kindAt: (i) => flat[i]?.kind });
    if (!action) return false;
    switch (action.type) {
      case 'move':
        e.preventDefault();
        setOpen(true);
        setActiveKey(flat[action.index]?.key ?? null);
        return true;
      case 'select':
        e.preventDefault();
        select(flat[action.index]!);
        return true;
      case 'remove': {
        e.preventDefault();
        const item = flat[action.index];
        if (item?.kind === 'recent') removeRecent(item.term);
        // the highlight moves to the entry that takes its place
        const next = flat[action.index + 1] ?? flat[action.index - 1];
        setActiveKey(next && next.kind === 'recent' ? next.key : null);
        return true;
      }
      case 'close':
        e.preventDefault();
        close();
        return true;
      case 'submit': {
        // Enter without a highlighted entry: the field runs its full search as before
        const t = text.trim();
        if (t) remember(t);
        close();
        return false;
      }
    }
  };

  const inputAria: Record<string, string | boolean> = {
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': shown,
    'aria-controls': listId,
    ...(shown && active >= 0 ? { 'aria-activedescendant': optionId(active) } : {}),
  };

  return {
    inputAria,
    onFocus: () => { setRecent(loadRecentSearches(browserStorage(), userKey)); setOpen(true); },
    onBlur: close,
    onTextChange: () => { setOpen(true); setActiveKey(null); },
    onKeyDown,
    shown, groups, flat, active, optionId, select, removeRecent,
  };
}
