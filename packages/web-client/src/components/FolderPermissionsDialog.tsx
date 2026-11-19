/**
 * w3: "Berechtigungen – <Ordner>" — folder permissions in the Outlook folder
 * properties layout. The list holds Standard, Anonym (fixed to "Keine") and the
 * users; the selected entry is edited through the "Berechtigungsstufe" role or
 * the individual rights (a changed checkbox switches to the matching role or
 * "Benutzerdefiniert"). Saving replaces the whole list (PUT). Model: lib/folderPermissions.ts.
 *
 * Own folders: base '/mail'; foreign folders: mailApiBase(ref), only offered
 * when the folder's myRights.administer is true.
 */
import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Shield, Trash2, UserPlus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { Modal } from './Modal.js';
import { api } from '../api/client.js';
import { toastError } from '../lib/errors.js';
import {
  READ_OPTIONS, WRITE_OPTIONS, DELETE_OPTIONS, OTHER_OPTIONS,
  addGrantee, buildPermissionsBody, directorySuggestions, formFromRights, granteeLabel, hasGrantee, inheritedFromLabel,
  isFixedEntry, isRemovableEntry, permissionsChanged, removeGrantee, rightsFromForm, roleChoices, roleLabel,
  setEntryApplyToSubfolders, setEntryRights, setEntryRole,
  type ContactSuggest, type FolderPermissionsView, type PermissionEntry, type RightsForm, type RoleChoice,
} from '../lib/folderPermissions.js';

const SUGGEST_DEBOUNCE_MS = 220;
const MAX_SUGGESTIONS = 8;

export function FolderPermissionsDialog({ base, folderId, folderName, folderLabel, onClose }: {
  /** API base of the mailbox ('/mail' or mailApiBase(ref)). */
  base: string;
  folderId: string;
  /** Label shown until the server answers. */
  folderName: string;
  /** Display name of another folder of the mailbox (inherited entries); undefined when unknown. */
  folderLabel?: (folderId: string) => string | undefined;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const titleId = useId();
  const path = `${base}/folders/${encodeURIComponent(folderId)}/permissions`;
  const queryKey = ['folder-permissions', path];
  const { data: view, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => api.get<FolderPermissionsView>(path),
    staleTime: 0,
  });
  const [entries, setEntries] = useState<PermissionEntry[] | null>(null);
  const [selectedKey, setSelectedKey] = useState('default');
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (view && entries === null) setEntries(view.entries); }, [view, entries]);

  const save = useMutation({
    mutationFn: (list: PermissionEntry[]) => api.put<FolderPermissionsView>(path, buildPermissionsBody(list)),
    onSuccess: (next) => {
      qc.setQueryData(queryKey, next);
      toast.success('Berechtigungen gespeichert', { duration: 2000 });
      onClose();
    },
    onError: toastError,
  });

  const title = `Berechtigungen – ${view?.folderName ?? folderName}`;
  const selected = entries?.find((e) => e.granteeKey === selectedKey) ?? entries?.[0];
  const changed = !!view && !!entries && permissionsChanged(view.entries, entries);

  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 bg-scrim/40 flex items-center justify-center z-50 p-4"
      className="bg-surface rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
    >
      <div className="px-6 py-4 border-b border-line flex items-center gap-3">
        <Shield size={18} className="text-accent-fg shrink-0" aria-hidden="true" />
        <h2 id={titleId} className="flex-1 min-w-0 text-base font-semibold text-fg truncate">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Schließen" className="p-1 rounded text-fg-subtle hover:text-fg-muted">
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="px-6 py-4 space-y-4 overflow-y-auto">
        {isLoading && <p className="text-sm text-fg-subtle" role="status">Lade Berechtigungen…</p>}
        {isError && <p className="text-sm text-danger-fg" role="alert">Berechtigungen konnten nicht geladen werden.</p>}
        {entries && selected && (
          <>
            <GranteeList
              entries={entries}
              selectedKey={selected.granteeKey}
              onSelect={setSelectedKey}
              onRemove={(key) => { setEntries(removeGrantee(entries, key)); setSelectedKey('default'); }}
            />
            {adding ? (
              <GranteeSearch
                entries={entries}
                onPick={(c) => {
                  const next = addGrantee(entries, { email: c.email, displayName: c.displayName });
                  setEntries(next);
                  setSelectedKey(next.find((e) => hasGrantee([e], { email: c.email }))?.granteeKey ?? 'default');
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <button type="button" onClick={() => setAdding(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-line-strong rounded text-fg hover:bg-surface-2">
                <UserPlus size={14} aria-hidden="true" /> Hinzufügen…
              </button>
            )}
            <RightsEditor
              entry={selected}
              onRole={(role) => setEntries(setEntryRole(entries, selected.granteeKey, role))}
              onRights={(rights) => setEntries(setEntryRights(entries, selected.granteeKey, rights))}
              onApplyToSubfolders={(v) => setEntries(setEntryApplyToSubfolders(entries, selected.granteeKey, v))}
            />
            {view && view.inherited.length > 0 && (
              <InheritedList entries={view.inherited} folderLabel={folderLabel} />
            )}
          </>
        )}
      </div>

      <div className="px-6 py-3 border-t border-line flex justify-end gap-2">
        <button type="button" onClick={onClose}
          className="px-4 py-1.5 text-sm text-fg-muted border border-line-strong rounded hover:bg-surface-2">
          Abbrechen
        </button>
        <button type="button"
          onClick={() => entries && save.mutate(entries)}
          disabled={!changed || save.isPending}
          className="px-4 py-1.5 text-sm rounded bg-accent text-white hover:opacity-90 disabled:opacity-50">
          Speichern
        </button>
      </div>
    </Modal>
  );
}

function GranteeList({ entries, selectedKey, onSelect, onRemove }: {
  entries: PermissionEntry[];
  selectedKey: string;
  onSelect: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  const headingId = useId();
  return (
    <div>
      <h3 id={headingId} className="text-xs font-medium text-fg-muted mb-1.5">Name und Berechtigungsstufe</h3>
      <ul aria-labelledby={headingId} className="border border-line rounded divide-y divide-line max-h-48 overflow-y-auto">
        {entries.map((e) => {
          const active = e.granteeKey === selectedKey;
          const label = granteeLabel(e);
          return (
            <li key={e.granteeKey} className={`flex items-center ${active ? 'bg-accent/10' : ''}`}>
              <button type="button" aria-pressed={active} onClick={() => onSelect(e.granteeKey)}
                className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2">
                <span className={`flex-1 min-w-0 truncate ${active ? 'text-accent-fg font-medium' : 'text-fg'}`}>{label}</span>
                <span className="shrink-0 text-xs text-fg-muted">{roleLabel(e.role)}</span>
              </button>
              {isRemovableEntry(e) && (
                <button type="button" onClick={() => onRemove(e.granteeKey)}
                  aria-label={`${label} entfernen`} title="Entfernen"
                  className="shrink-0 p-1.5 mr-1 rounded text-fg-subtle hover:text-danger-fg hover:bg-danger-bg">
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Directory search (/contacts?q=, directory users only) as an ARIA combobox. */
function GranteeSearch({ entries, onPick, onCancel }: {
  entries: PermissionEntry[];
  onPick: (c: ContactSuggest) => void;
  onCancel: () => void;
}) {
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    const q = text.trim();
    if (!q) { setQuery(''); return; }
    const timer = setTimeout(() => setQuery(q), SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const { data } = useQuery({
    queryKey: ['contact-suggest', query],
    queryFn: () => api.get<ContactSuggest[]>(`/contacts?q=${encodeURIComponent(query)}`),
    enabled: query.length >= 1,
    staleTime: 30_000,
  });
  const suggestions = directorySuggestions(data ?? [], entries, MAX_SUGGESTIONS);
  const showList = text.trim().length > 0 && suggestions.length > 0;
  const optionId = (i: number) => `${listId}-o${i}`;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (!showList) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIdx((i) => (i + step + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter') {
      const s = suggestions[activeIdx];
      if (s) { e.preventDefault(); onPick(s); }
    }
  };

  return (
    <div className="relative">
      <label htmlFor={inputId} className="block text-xs font-medium text-fg-muted mb-1">Benutzer hinzufügen</label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          {...(showList ? { 'aria-activedescendant': optionId(activeIdx) } : {})}
          autoComplete="off"
          autoFocus
          value={text}
          placeholder="Name oder E-Mail-Adresse"
          onChange={(e) => { setText(e.target.value); setActiveIdx(0); }}
          onKeyDown={onKeyDown}
          className="flex-1 border border-line-strong rounded px-3 py-1.5 text-sm bg-surface text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg"
        />
        <button type="button" onClick={onCancel}
          className="px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded hover:bg-surface-2">
          Abbrechen
        </button>
      </div>
      <ul id={listId} role="listbox" aria-label="Vorschläge" hidden={!showList}
        className="absolute left-0 right-0 top-full mt-1 bg-surface border border-line rounded-md shadow-lg z-10 max-h-60 overflow-y-auto">
        {showList && suggestions.map((c, i) => (
          <li key={c.id} id={optionId(i)} role="option" aria-selected={i === activeIdx}
            onMouseDown={(e) => { e.preventDefault(); onPick(c); }}
            onMouseEnter={() => setActiveIdx(i)}
            className={`px-3 py-2 text-sm cursor-pointer ${i === activeIdx ? 'bg-accent/10' : 'hover:bg-surface-2'}`}>
            <span className="block font-medium text-fg truncate">{c.displayName || c.email}</span>
            {c.displayName && <span className="block text-xs text-fg-subtle truncate">{c.email}</span>}
          </li>
        ))}
      </ul>
      {query.length >= 1 && data && suggestions.length === 0 && (
        <p className="text-xs text-fg-subtle mt-1.5">Keine Benutzer gefunden.</p>
      )}
    </div>
  );
}

function RightsEditor({ entry, onRole, onRights, onApplyToSubfolders }: {
  entry: PermissionEntry;
  onRole: (role: RoleChoice) => void;
  onRights: (rights: number) => void;
  onApplyToSubfolders: (v: boolean) => void;
}) {
  const id = useId();
  const fixed = isFixedEntry(entry);
  const form = formFromRights(entry.rights);
  const set = (patch: Partial<RightsForm>) => onRights(rightsFromForm({ ...form, ...patch }));
  const legend = 'text-xs font-semibold text-fg-muted mb-1';
  const option = 'flex items-center gap-2 text-sm text-fg cursor-pointer select-none';

  return (
    <fieldset disabled={fixed} className="border border-line rounded p-3 space-y-3 min-w-0">
      <legend className="px-1 text-xs font-medium text-fg-muted">Berechtigungen für „{granteeLabel(entry)}"</legend>
      {fixed && <p className="text-xs text-fg-subtle">Anonym erhält für E-Mail-Ordner keine Rechte.</p>}
      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-role`} className="text-sm text-fg-muted shrink-0">Berechtigungsstufe</label>
        <select id={`${id}-role`} value={entry.role} onChange={(e) => onRole(e.target.value as RoleChoice)}
          className="flex-1 border border-line-strong rounded px-2 py-1.5 text-sm bg-surface text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg">
          {roleChoices(entry.role).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <fieldset className="min-w-0">
          <legend className={legend}>Lesen</legend>
          {READ_OPTIONS.map((o) => (
            <label key={String(o.value)} className={option}>
              <input type="radio" name={`${id}-read`} checked={form.readAll === o.value} onChange={() => set({ readAll: o.value })} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <fieldset className="min-w-0">
          <legend className={legend}>Schreiben</legend>
          {WRITE_OPTIONS.map((o) => (
            <label key={o.key} className={option}>
              <input type="checkbox" checked={form[o.key]}
                // "Alle bearbeiten" includes "Eigene bearbeiten"
                disabled={o.key === 'editOwn' && form.editAll}
                onChange={(e) => set({ [o.key]: e.target.checked })} className="rounded" />
              {o.label}
            </label>
          ))}
        </fieldset>
        <fieldset className="min-w-0">
          <legend className={legend}>Löschen</legend>
          {DELETE_OPTIONS.map((o) => (
            <label key={o.value} className={option}>
              <input type="radio" name={`${id}-delete`} checked={form.deleteLevel === o.value} onChange={() => set({ deleteLevel: o.value })} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <fieldset className="min-w-0">
          <legend className={legend}>Sonstiges</legend>
          {OTHER_OPTIONS.map((o) => (
            <label key={o.key} className={option}>
              <input type="checkbox" checked={form[o.key]} onChange={(e) => set({ [o.key]: e.target.checked })} className="rounded" />
              {o.label}
            </label>
          ))}
        </fieldset>
      </div>
      <label className={option}>
        <input type="checkbox" checked={entry.applyToSubfolders} onChange={(e) => onApplyToSubfolders(e.target.checked)} className="rounded" />
        Auch für Unterordner übernehmen
      </label>
    </fieldset>
  );
}

function InheritedList({ entries, folderLabel }: {
  entries: FolderPermissionsView['inherited'];
  folderLabel: ((folderId: string) => string | undefined) | undefined;
}) {
  const headingId = useId();
  return (
    <div className="bg-info-bg border border-info-line rounded p-3">
      <h3 id={headingId} className="text-xs font-medium text-info-fg mb-1">Geerbte Berechtigungen</h3>
      <ul aria-labelledby={headingId} className="space-y-0.5 text-xs text-info-fg">
        {entries.map((e) => (
          <li key={`${e.granteeKey}|${e.fromFolderId}`}>
            {granteeLabel(e)}: {roleLabel(e.role)} – {inheritedFromLabel(folderLabel?.(e.fromFolderId))}
          </li>
        ))}
      </ul>
    </div>
  );
}
