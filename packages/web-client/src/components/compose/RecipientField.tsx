/**
 * 9.4: recipient field with pills (An / Cc / Bcc). Typed text becomes a pill on
 * `,` `;` Enter, Tab or leaving the field; a pasted list is split. A pill shows
 * the name — click shows the full address, ✕ removes it, Backspace in the empty
 * field removes the last one. Invalid addresses and entries "Namen prüfen" could
 * not resolve are marked (the reason as tooltip and for screen readers). Suggestions come from
 * `/contacts?q=` (ARIA combobox: ↑/↓, Enter/Tab picks, Escape closes).
 * Redesign: a pill is a neutral chip with a 20 px avatar (photo or initials); its ✕ shows on hover / focus.
 * 9.5: contact groups are suggested too; picking one adds its expanded members.
 * Rules: lib/recipients.ts, lib/contactGroups.ts.
 */
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client.js';
import { Avatar } from '../Avatar.js';
import { usePhotoForAddress } from '../../hooks/useUserPhoto.js';
import {
  addEntries, backspace, commitText, commitsOnKey, formatRecipient, parseRecipient, pillLabel, removeEntry, typeText,
  type RecipientValue,
} from '../../lib/recipients.js';
import { groupIdOfSuggestion, recipientEntries, type GroupExpansion } from '../../lib/contactGroups.js';
import type { UnresolvedReason } from '../../lib/nameCheck.js';
import { fmt, useT } from '../../i18n/useT.js';

interface ContactSuggest { id: string; displayName: string; email: string; company?: string; kind?: 'group'; memberCount?: number }

const SUGGEST_DEBOUNCE_MS = 220;
const MAX_SUGGESTIONS = 8;

const UNRESOLVED_TEXT = { ambiguous: 'compose_name_ambiguous', notFound: 'compose_name_not_found' } as const;

function RecipientPill({ entry, unresolved, onRemove }: { entry: string; unresolved: UnresolvedReason | undefined; onRemove: () => void }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const r = parseRecipient(entry);
  const label = pillLabel(r);
  const full = r.name ? `${r.name} <${r.address}>` : r.address;
  const problem = unresolved ? t(UNRESOLVED_TEXT[unresolved]) : r.valid ? null : t('compose_recipient_invalid');
  const photoUrl = usePhotoForAddress(r.address);
  const tone = problem ? 'bg-danger-bg border-danger-line text-danger-fg' : 'bg-surface-3 border-transparent text-fg';
  return (
    <li className={`group inline-flex items-center max-w-full h-6 rounded-full border text-[13px] ${tone}`}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        title={problem ? `${full} – ${problem}` : full}
        className="flex items-center gap-1.5 pl-0.5 pr-1 min-w-0 h-full rounded-l-full"
      >
        <Avatar seed={r.address || label} name={r.name || null} photoUrl={photoUrl} size="chip" />
        <span className="truncate max-w-[18rem]">
          {expanded ? full : label}
          {problem && <span className="sr-only">{`, ${problem}`}</span>}
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={fmt(t('compose_remove_recipient'), { name: label })}
        title={fmt(t('compose_remove_recipient'), { name: label })}
        className="pr-1.5 pl-0.5 h-full rounded-r-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 hover:text-danger-fg"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </li>
  );
}

function SuggestionOption({ c, id, active, onPick }: { c: ContactSuggest; id: string; active: boolean; onPick: () => void }) {
  const t = useT();
  if (groupIdOfSuggestion(c)) {
    return (
      <li
        id={id}
        role="option"
        aria-selected={active}
        onMouseDown={(e) => { e.preventDefault(); onPick(); }}
        className={`px-3 py-2 flex items-center gap-2.5 cursor-pointer ${active ? 'bg-accent/10' : 'hover:bg-surface-2'}`}
      >
        <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 bg-accent/15 text-accent-fg" aria-hidden="true">
          <Users size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-fg truncate">{c.displayName}</span>
          <span className="block text-xs text-fg-subtle truncate">
            {`${t('compose_group_label')} · ${fmt(t('compose_group_members'), { count: c.memberCount ?? 0 })}`}
          </span>
        </span>
      </li>
    );
  }
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      className={`px-3 py-2 flex items-center gap-2.5 cursor-pointer ${active ? 'bg-accent/10' : 'hover:bg-surface-2'}`}
    >
      <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 uppercase bg-accent/15 text-accent-fg" aria-hidden="true">
        {(c.displayName || c.email)[0]}
      </span>
      <span className="min-w-0 flex-1">
        {c.displayName && <span className="block text-sm font-medium text-fg truncate">{c.displayName}</span>}
        <span className={`block truncate ${c.displayName ? 'text-xs text-fg-subtle' : 'text-sm text-fg'}`}>{c.email}</span>
        {c.company && <span className="block text-xs text-fg-subtle truncate">{c.company}</span>}
      </span>
    </li>
  );
}

interface Props {
  id: string;
  /** Field name ("An"), for the pill list label. */
  label: string;
  value: RecipientValue;
  onChange: (v: RecipientValue) => void;
  /** Polite announcement (a removed recipient). */
  onAnnounce: (text: string) => void;
  /** Entries "Namen prüfen" could not resolve. */
  unresolved: Readonly<Record<string, UnresolvedReason>>;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function RecipientField({ id, label, value, onChange, onAnnounce, unresolved, inputRef }: Props) {
  const t = useT();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const q = value.text.trim();
    if (!q) { setQuery(''); return; }
    const timer = setTimeout(() => setQuery(q), SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value.text]);

  const { data } = useQuery({
    queryKey: ['contact-suggest', query],
    queryFn: () => api.get<ContactSuggest[]>(`/contacts?q=${encodeURIComponent(query)}&groups=1`),
    enabled: query.length >= 1,
    staleTime: 30_000,
  });
  const taken = new Set(value.entries.map((e) => parseRecipient(e).address.toLowerCase()));
  const suggestions = (data ?? [])
    .filter((c) => (c.email ? !taken.has(c.email.toLowerCase()) : !!groupIdOfSuggestion(c)))
    .slice(0, MAX_SUGGESTIONS);
  const showList = open && value.text.trim().length > 0 && suggestions.length > 0;
  const optionId = (i: number) => `${listId}-o${i}`;
  // The group expansion answers later: it is added to the field as it is then
  const latest = useRef(value);
  latest.current = value;

  const addGroup = async (groupId: string) => {
    try {
      const exp = await api.get<GroupExpansion>(`/contacts/groups/${encodeURIComponent(groupId)}/expand`);
      const entries = recipientEntries(exp);
      if (entries.length === 0) { toast.error(t('compose_group_empty')); return; }
      onChange({ ...latest.current, entries: addEntries(latest.current.entries, entries) });
      if (exp.skipped.length > 0) toast(fmt(t('compose_group_skipped'), { count: exp.skipped.length }));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const pick = (c: ContactSuggest) => {
    setOpen(false);
    const groupId = groupIdOfSuggestion(c);
    if (groupId) {
      onChange({ entries: value.entries, text: '' });
      void addGroup(groupId);
      return;
    }
    onChange({ entries: addEntries(value.entries, [formatRecipient(c.displayName, c.email)]), text: '' });
  };

  const remove = (index: number) => {
    const entry = value.entries[index];
    onChange(removeEntry(value, index));
    if (entry) onAnnounce(fmt(t('compose_recipient_removed'), { name: pillLabel(parseRecipient(entry)) }));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showList) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActiveIdx((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const s = suggestions[activeIdx];
        if (s) { e.preventDefault(); pick(s); return; }
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    }
    if (commitsOnKey(e.key, value.text)) {
      if (e.key !== 'Tab') e.preventDefault();
      onChange(commitText(value));
      return;
    }
    if (e.key === 'Backspace' && !value.text) {
      const r = backspace(value);
      if (!r.removed) return;
      e.preventDefault();
      onChange(r.value);
      onAnnounce(fmt(t('compose_recipient_removed'), { name: pillLabel(parseRecipient(r.removed)) }));
    }
  };

  return (
    <div className="relative flex-1 min-w-0">
      <div className="flex flex-wrap items-center gap-1 min-h-[28px] cursor-text" onClick={() => inputRef.current?.focus()}>
        {value.entries.length > 0 && (
          <ul aria-label={fmt(t('compose_recipients_of'), { field: label })} className="flex flex-wrap gap-1 max-w-full">
            {value.entries.map((entry, i) => (
              <RecipientPill key={`${entry}-${i}`} entry={entry} unresolved={unresolved[entry]} onRemove={() => remove(i)} />
            ))}
          </ul>
        )}
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          {...(showList ? { 'aria-activedescendant': optionId(activeIdx) } : {})}
          autoComplete="off"
          value={value.text}
          placeholder={value.entries.length === 0 ? t('compose_add_recipient') : ''}
          onChange={(e) => { onChange(typeText(value, e.target.value)); setOpen(true); setActiveIdx(0); }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (!/[\n,;]/.test(pasted)) return;
            e.preventDefault();
            onChange(commitText({ entries: value.entries, text: `${value.text}${pasted}` }));
          }}
          onKeyDown={onKeyDown}
          onBlur={() => { setOpen(false); if (value.text.trim()) onChange(commitText(value)); }}
          className="flex-1 min-w-[8rem] text-sm bg-transparent text-fg outline-none py-0.5 rounded-sm focus-visible:ring-2 focus-visible:ring-accent-fg"
        />
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label={t('compose_suggestions')}
        hidden={!showList}
        className="absolute top-full left-0 right-0 mt-1 bg-surface border border-line rounded-lg shadow-xl z-[60] max-h-60 overflow-y-auto"
      >
        {showList && suggestions.map((c, i) => (
          <SuggestionOption key={c.id} c={c} id={optionId(i)} active={i === activeIdx} onPick={() => pick(c)} />
        ))}
      </ul>
    </div>
  );
}
