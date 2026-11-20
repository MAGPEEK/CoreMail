/**
 * 10.2: the suggestion dropdown of the mail search fields (message list + header):
 * "Letzte Suchen", "Personen", "Nachrichten" as one listbox whose options the
 * field highlights through aria-activedescendant (hooks/useSearchSuggest.ts).
 * Options keep the focus in the field (mousedown is prevented) and are picked on click.
 */
import { useEffect } from 'react';
import { History, Mail, X } from 'lucide-react';
import { Avatar } from './Avatar.js';
import { fmt, useT } from '../i18n/useT.js';
import { useRegional } from '../store/preferences.js';
import { formatListDate } from '../lib/regionalFormat.js';
import type { SuggestGroup, SuggestGroupKey, SuggestItem, MessageSuggestion, PersonSuggestion } from '../lib/searchSuggest.js';
import type { TranslationKey } from '../i18n/translations.js';

const GROUP_LABEL: Record<SuggestGroupKey, TranslationKey> = {
  recent: 'search_suggest_recent',
  people: 'search_suggest_people',
  messages: 'search_suggest_messages',
};

const OPTION = 'px-3 py-1.5 flex items-center gap-2.5 cursor-pointer';
const optionTone = (active: boolean) => (active ? 'bg-accent/10' : 'hover:bg-surface-2');

interface OptionProps {
  id: string;
  active: boolean;
  onPick: () => void;
}

function RecentOption({ id, active, onPick, term, onRemove }: OptionProps & { term: string; onRemove: () => void }) {
  const t = useT();
  const label = fmt(t('search_suggest_remove_recent'), { term });
  return (
    <div id={id} role="option" aria-selected={active} onMouseDown={(e) => e.preventDefault()} onClick={onPick}
      className={`${OPTION} group ${optionTone(active)}`}>
      <History size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
      <span className="flex-1 min-w-0 truncate text-sm text-fg">{term}</span>
      {/* Mouse target only — the keyboard removes a highlighted entry with Delete */}
      <button type="button" tabIndex={-1} aria-label={label} title={label}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded text-fg-subtle hover:text-fg hover:bg-surface-2">
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

function PersonOption({ id, active, onPick, person }: OptionProps & { person: PersonSuggestion }) {
  return (
    <div id={id} role="option" aria-selected={active} onMouseDown={(e) => e.preventDefault()} onClick={onPick}
      className={`${OPTION} ${optionTone(active)}`}>
      <Avatar seed={person.address} name={person.name} size="xs" />
      <span className="min-w-0 flex-1">
        {person.name && <span className="block text-sm text-fg truncate">{person.name}</span>}
        <span className={`block truncate ${person.name ? 'text-xs text-fg-subtle' : 'text-sm text-fg'}`}>{person.address}</span>
      </span>
    </div>
  );
}

function MessageOption({ id, active, onPick, message }: OptionProps & { message: MessageSuggestion }) {
  const t = useT();
  const regional = useRegional();
  const date = formatListDate(new Date(message.date), new Date(), regional, t('search_suggest_yesterday'));
  const sender = message.fromName || message.fromAddr;
  return (
    <div id={id} role="option" aria-selected={active} onMouseDown={(e) => e.preventDefault()} onClick={onPick}
      className={`${OPTION} ${optionTone(active)}`}>
      <Mail size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="flex-1 min-w-0 truncate text-sm text-fg">{message.subject || t('search_suggest_no_subject')}</span>
          <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{date}</span>
        </span>
        <span className="block truncate text-xs text-fg-subtle">
          {sender}{message.folderName ? ` · ${message.folderName}` : ''}
        </span>
      </span>
    </div>
  );
}

export interface SearchSuggestListProps {
  id: string;
  groups: SuggestGroup[];
  flat: SuggestItem[];
  active: number;
  optionId: (index: number) => string;
  onSelect: (item: SuggestItem) => void;
  onRemoveRecent: (term: string) => void;
}

export function SearchSuggestList({ id, groups, flat, active, optionId, onSelect, onRemoveRecent }: SearchSuggestListProps) {
  const t = useT();
  // keep the highlighted entry visible while the arrow keys move through a long list
  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, optionId]);

  return (
    <div id={id} role="listbox" aria-label={t('search_suggest_label')}
      className="absolute top-full left-0 right-0 mt-1 py-1 bg-surface text-fg border border-line rounded-lg shadow-lg z-[60] max-h-[24rem] overflow-y-auto text-left">
      {groups.map((g) => (
        <div key={g.key} role="group" aria-labelledby={`${id}-${g.key}`}>
          <div id={`${id}-${g.key}`} role="presentation" className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            {t(GROUP_LABEL[g.key])}
          </div>
          {g.items.map((item) => {
            const index = flat.indexOf(item);
            const common = { id: optionId(index), active: index === active, onPick: () => onSelect(item) };
            if (item.kind === 'recent') return <RecentOption key={item.key} {...common} term={item.term} onRemove={() => onRemoveRecent(item.term)} />;
            if (item.kind === 'person') return <PersonOption key={item.key} {...common} person={item.person} />;
            return <MessageOption key={item.key} {...common} message={item.message} />;
          })}
        </div>
      ))}
    </div>
  );
}
