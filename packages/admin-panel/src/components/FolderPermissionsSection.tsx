/**
 * w3: "Ordnerberechtigungen" of a user mailbox or Shared Mailbox. Lists every
 * folder with its grantees and roles; "Bearbeiten" opens the folder's editor
 * (same model as the webmail dialog: lib/folderPermissions.ts). Saving replaces
 * the folder's list (PUT, audited). Admin mailboxes are ORGANIZATION_MANAGEMENT-only
 * — the server answers 403 FORBIDDEN, whose text is shown.
 */
import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderLock, Loader2, Trash2, UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { WriteGuard } from './Can.js';
import { errorMessage } from '../lib/errors.js';
import {
  READ_OPTIONS, WRITE_OPTIONS, DELETE_OPTIONS, OTHER_OPTIONS,
  addGrantee, buildPermissionsBody, folderDisplayName, formFromRights, grantSummary, granteeLabel, hasGrantee,
  inheritedFromLabel, isFixedEntry, isRemovableEntry, permissionsChanged, removeGrantee, rightsFromForm,
  roleChoices, roleLabel, setEntryApplyToSubfolders, setEntryRights, setEntryRole,
  type FolderPermissionsOverview, type FolderPermissionsView, type PermissionEntry, type RightsForm, type RoleChoice,
} from '../lib/folderPermissions.js';

interface DirectoryUser { id: string; email: string; displayName: string }

const MAX_USER_HITS = 30;

export function FolderPermissionsSection({ basePath, ownerUserId }: {
  /** /admin/mailboxes/<userId> or /admin/shared-mailboxes/<id>. */
  basePath: string;
  /** Owner of a user mailbox (always has every right, not offered as grantee). */
  ownerUserId?: string;
}) {
  const headingId = useId();
  const overviewKey = ['admin-folder-permissions', basePath];
  const { data: folders, isLoading, isError } = useQuery({
    queryKey: overviewKey,
    queryFn: () => api.get<FolderPermissionsOverview[]>(`${basePath}/folder-permissions`),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const nameOf = (id: string): string | undefined => {
    const f = folders?.find((x) => x.id === id);
    return f ? folderDisplayName(f.name) : undefined;
  };

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-center gap-2">
        <FolderLock size={14} className="text-fg-subtle" aria-hidden="true" />
        <h3 id={headingId} className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Ordnerberechtigungen</h3>
      </div>
      <p className="text-xs text-fg-subtle">
        Rechte anderer Benutzer auf einzelne Ordner dieses Postfachs. „Standard" gilt für alle Benutzer ohne eigenen Eintrag.
      </p>
      {isLoading && <p className="flex items-center gap-2 text-xs text-fg-subtle" role="status"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Lade Ordner…</p>}
      {isError && <p className="text-xs text-danger-fg" role="alert">Ordnerberechtigungen konnten nicht geladen werden.</p>}
      {folders && (
        <div className="border border-line rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line bg-surface-2">
                <th scope="col" className="text-left px-3 py-1.5 text-fg-subtle font-medium">Ordner</th>
                <th scope="col" className="text-left px-3 py-1.5 text-fg-subtle font-medium">Berechtigungen</th>
                <th scope="col" className="px-3 py-1.5"><span className="sr-only">Aktion</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {folders.map((f) => (
                <tr key={f.id} className={editing === f.id ? 'bg-accent/10' : ''}>
                  <th scope="row" className="px-3 py-1.5 text-left font-normal text-fg-muted">{folderDisplayName(f.name)}</th>
                  <td className="px-3 py-1.5 text-fg-muted">{grantSummary(f.entries)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <button type="button" onClick={() => setEditing(editing === f.id ? null : f.id)}
                      aria-expanded={editing === f.id}
                      aria-label={`Berechtigungen von ${folderDisplayName(f.name)} bearbeiten`}
                      className="text-xs text-accent-fg hover:underline">
                      Bearbeiten
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <FolderPermissionsEditor
          key={editing}
          path={`${basePath}/folders/${encodeURIComponent(editing)}/permissions`}
          overviewKey={overviewKey}
          ownerUserId={ownerUserId}
          folderLabel={nameOf}
          onDone={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function FolderPermissionsEditor({ path, overviewKey, ownerUserId, folderLabel, onDone }: {
  path: string;
  overviewKey: readonly unknown[];
  ownerUserId: string | undefined;
  folderLabel: (folderId: string) => string | undefined;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const headingId = useId();
  const { data: view, isLoading, isError } = useQuery({
    queryKey: ['admin-folder-permission', path],
    queryFn: () => api.get<FolderPermissionsView>(path),
    staleTime: 0,
  });
  const [entries, setEntries] = useState<PermissionEntry[] | null>(null);
  const [selectedKey, setSelectedKey] = useState('default');
  useEffect(() => { if (view && entries === null) setEntries(view.entries); }, [view, entries]);

  const save = useMutation({
    mutationFn: (list: PermissionEntry[]) => api.put<FolderPermissionsView>(path, buildPermissionsBody(list)),
    onSuccess: (next) => {
      qc.setQueryData(['admin-folder-permission', path], next);
      void qc.invalidateQueries({ queryKey: overviewKey });
      toast.success('Ordnerberechtigungen gespeichert');
      onDone();
    },
    onError: (e) => toast.error(`Speichern fehlgeschlagen: ${errorMessage(e)}`),
  });

  if (isLoading) return <p className="flex items-center gap-2 text-xs text-fg-subtle" role="status"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Lade Berechtigungen…</p>;
  if (isError || !view || !entries) return <p className="text-xs text-danger-fg" role="alert">Berechtigungen konnten nicht geladen werden.</p>;

  const selected = entries.find((e) => e.granteeKey === selectedKey) ?? entries[0]!;
  const changed = permissionsChanged(view.entries, entries);

  return (
    <div role="group" aria-labelledby={headingId} className="border border-line rounded-lg p-3 space-y-3">
      <h4 id={headingId} className="text-sm font-semibold text-fg">Berechtigungen – {view.folderName}</h4>
      <WriteGuard area="recipients" className="space-y-3">
        <GranteeList
          entries={entries}
          selectedKey={selected.granteeKey}
          onSelect={setSelectedKey}
          onRemove={(key) => { setEntries(removeGrantee(entries, key)); setSelectedKey('default'); }}
        />
        <UserPicker
          entries={entries}
          ownerUserId={ownerUserId}
          onPick={(u) => {
            setEntries(addGrantee(entries, u));
            setSelectedKey(`user:${u.id}`);
          }}
        />
        <RightsEditor
          entry={selected}
          onRole={(role) => setEntries(setEntryRole(entries, selected.granteeKey, role))}
          onRights={(rights) => setEntries(setEntryRights(entries, selected.granteeKey, rights))}
          onApplyToSubfolders={(v) => setEntries(setEntryApplyToSubfolders(entries, selected.granteeKey, v))}
        />
        {view.inherited.length > 0 && (
          <div className="bg-info-bg border border-info-line rounded p-3">
            <p className="text-xs font-medium text-info-fg mb-1">Geerbte Berechtigungen</p>
            <ul className="space-y-0.5 text-xs text-info-fg">
              {view.inherited.map((e) => (
                <li key={`${e.granteeKey}|${e.fromFolderId}`}>
                  {granteeLabel(e)}: {roleLabel(e.role)} – {inheritedFromLabel(folderLabel(e.fromFolderId))}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onDone} className="btn-secondary">Abbrechen</button>
          <button type="button" onClick={() => save.mutate(entries)} disabled={!changed || save.isPending}
            className="btn-primary disabled:opacity-50 flex items-center gap-2">
            {save.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            Speichern
          </button>
        </div>
      </WriteGuard>
    </div>
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
      <p id={headingId} className="field-label">Name und Berechtigungsstufe</p>
      <ul aria-labelledby={headingId} className="border border-line rounded divide-y divide-line max-h-48 overflow-y-auto">
        {entries.map((e) => {
          const active = e.granteeKey === selectedKey;
          const label = granteeLabel(e);
          return (
            <li key={e.granteeKey} className={`flex items-center ${active ? 'bg-accent/10' : ''}`}>
              <button type="button" aria-pressed={active} onClick={() => onSelect(e.granteeKey)}
                className="flex-1 min-w-0 flex items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-surface-2">
                <span className={`flex-1 min-w-0 truncate ${active ? 'text-accent-fg font-medium' : 'text-fg'}`}>{label}</span>
                <span className="shrink-0 text-xs text-fg-muted">{roleLabel(e.role)}</span>
              </button>
              {isRemovableEntry(e) && (
                <button type="button" onClick={() => onRemove(e.granteeKey)}
                  aria-label={`${label} entfernen`} title="Entfernen"
                  className="shrink-0 p-1.5 mr-1 rounded text-fg-subtle hover:text-danger-fg">
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

/** User search over the BCP user list (as the Shared Mailbox permissions dialog); sends { userId }. */
function UserPicker({ entries, ownerUserId, onPick }: {
  entries: PermissionEntry[];
  ownerUserId: string | undefined;
  onPick: (u: DirectoryUser) => void;
}) {
  const inputId = useId();
  const listId = useId();
  const [search, setSearch] = useState('');
  const { data: users = [] } = useQuery<DirectoryUser[]>({
    queryKey: ['admin-users-list-all'],
    queryFn: () => api.get<DirectoryUser[]>('/admin/mailboxes').then((r) => (Array.isArray(r) ? r : [])),
    staleTime: 60_000,
  });
  const q = search.trim().toLowerCase();
  const hits = q
    ? users.filter((u) => u.id !== ownerUserId && !hasGrantee(entries, u)
        && (u.email.toLowerCase().includes(q) || (u.displayName ?? '').toLowerCase().includes(q))).slice(0, MAX_USER_HITS)
    : [];

  return (
    <div>
      <label htmlFor={inputId} className="field-label flex items-center gap-1"><UserPlus size={12} aria-hidden="true" /> Hinzufügen…</label>
      <input id={inputId} className="input w-full" type="search" value={search} autoComplete="off"
        placeholder="Name oder E-Mail-Adresse" aria-controls={listId}
        onChange={(e) => setSearch(e.target.value)} />
      <ul id={listId} aria-label="Gefundene Benutzer" hidden={hits.length === 0}
        className="mt-1 border border-line rounded divide-y divide-line max-h-40 overflow-y-auto">
        {hits.map((u) => (
          <li key={u.id}>
            <button type="button" onClick={() => { onPick(u); setSearch(''); }}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-surface-2">
              <span className="text-fg">{u.displayName || u.email}</span>
              {u.displayName && <span className="ml-1 text-xs text-fg-subtle">({u.email})</span>}
            </button>
          </li>
        ))}
      </ul>
      {q && hits.length === 0 && <p className="mt-1 text-xs text-fg-subtle">Keine Benutzer gefunden.</p>}
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
        <select id={`${id}-role`} className="input flex-1" value={entry.role} onChange={(e) => onRole(e.target.value as RoleChoice)}>
          {roleChoices(entry.role).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
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
