/**
 * 9.5: a contact group ("Kontaktliste") — members, "E-Mail an Liste" (opens
 * the compose with the expanded recipients) and the editor (name, members
 * from the own contacts / the address list / other lists, plain addresses).
 * Rules: lib/contactGroups.ts.
 */
import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mail, Pencil, Plus, Trash2, Users, X } from 'lucide-react';
import { api } from '../../api/client.js';
import {
  addMember, addressMember, memberKey, memberLabel, removeMember, groupIdOfSuggestion,
  type ContactGroupDetail, type GroupMember,
} from '../../lib/contactGroups.js';

interface Suggestion { id: string; displayName: string; email: string; kind?: string }

const LABEL = 'block text-sm font-medium text-fg-muted mb-1';

/** Member list (read view and editor). */
function MemberList({ members, onRemove }: { members: readonly GroupMember[]; onRemove?: (key: string) => void }) {
  if (members.length === 0) return <p className="text-sm text-fg-subtle px-4 py-3">Noch keine Mitglieder.</p>;
  return (
    <ul className="border border-line rounded-lg divide-y divide-line" aria-label="Mitglieder">
      {members.map((m) => (
        <li key={memberKey(m)} className="flex items-center gap-3 px-4 py-2.5 text-sm">
          {m.kind === 'group' ? <Users size={14} className="text-fg-subtle shrink-0" aria-hidden="true" /> : null}
          <span className={`flex-1 min-w-0 truncate ${m.kind === 'missing' ? 'text-fg-subtle italic' : 'text-fg'}`}>{memberLabel(m)}</span>
          {onRemove && (
            <button type="button" className="btn-ghost p-1 shrink-0" aria-label={`${memberLabel(m)} entfernen`} onClick={() => onRemove(memberKey(m))}>
              <Trash2 size={13} aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ContactGroupDetails({ group, sending, onSend, onEdit, onDelete }: {
  group: ContactGroupDetail; sending: boolean; onSend: () => void; onEdit: () => void; onDelete: () => void;
}) {
  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-start gap-4 mb-6">
        <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center text-white shrink-0" aria-hidden="true">
          <Users size={26} />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-semibold text-fg leading-tight">{group.name}</h2>
          <p className="text-sm text-fg-subtle mt-0.5">Kontaktliste · {group.members.length} {group.members.length === 1 ? 'Mitglied' : 'Mitglieder'}</p>
        </div>
        <div className="flex gap-1 shrink-0">
          <button type="button" onClick={onSend} disabled={sending || group.members.length === 0} className="btn-primary text-xs flex items-center gap-1 disabled:opacity-50">
            <Mail size={13} aria-hidden="true" /> E-Mail an Liste
          </button>
          <button type="button" onClick={onEdit} className="btn-secondary text-xs flex items-center gap-1">
            <Pencil size={13} aria-hidden="true" /> Bearbeiten
          </button>
          <button type="button" onClick={onDelete} className="btn-ghost text-xs text-danger-fg flex items-center gap-1">
            <Trash2 size={13} aria-hidden="true" /> Löschen
          </button>
        </div>
      </div>
      <MemberList members={group.members} />
    </div>
  );
}

function suggestionMember(s: Suggestion): GroupMember | null {
  const groupId = groupIdOfSuggestion(s);
  if (groupId) return { kind: 'group', groupId, uid: '', name: s.displayName };
  if (s.id.startsWith('gal-')) return s.email ? { kind: 'address', email: s.email, name: s.displayName } : null;
  return { kind: 'contact', contactId: s.id, uid: '', displayName: s.displayName, email: s.email };
}

/** Search the own contacts, the address list and other lists. */
function MemberSearch({ selfId, onPick }: { selfId: string | null; onPick: (m: GroupMember) => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 220);
    return () => clearTimeout(t);
  }, [text]);
  const { data = [] } = useQuery({
    queryKey: ['contacts', 'member-search', query],
    queryFn: () => api.get<Suggestion[]>(`/contacts?q=${encodeURIComponent(query)}&groups=1`),
    enabled: query.length >= 2,
  });
  const hits = data.filter((s) => !selfId || groupIdOfSuggestion(s) !== selfId).slice(0, 8); // a list never contains itself
  return (
    <div>
      <label htmlFor={id} className={LABEL}>Kontakt oder Liste suchen</label>
      <input id={id} className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name oder E-Mail-Adresse" autoComplete="off" />
      {query.length >= 2 && (
        <ul className="mt-1 border border-line rounded-lg divide-y divide-line" aria-label="Suchergebnisse">
          {hits.length === 0 && <li className="px-3 py-2 text-sm text-fg-subtle">Keine Treffer</li>}
          {hits.map((s) => {
            const m = suggestionMember(s);
            return (
              <li key={s.id}>
                <button
                  type="button" disabled={!m}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2 disabled:opacity-50 flex items-center gap-2"
                  onClick={() => { if (m) { onPick(m); setText(''); } }}
                >
                  {groupIdOfSuggestion(s) ? <Users size={13} className="text-fg-subtle" aria-hidden="true" /> : <Plus size={13} className="text-fg-subtle" aria-hidden="true" />}
                  <span className="truncate">{s.displayName}{s.email ? ` <${s.email}>` : ''}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AddressAdder({ onAdd }: { onAdd: (m: GroupMember) => void }) {
  const nameId = useId();
  const mailId = useId();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const m = addressMember(email, name);
    if (!m) { setError('Keine gültige E-Mail-Adresse.'); return; }
    onAdd(m);
    setName('');
    setEmail('');
    setError(null);
  };
  return (
    <fieldset className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
      <legend className={LABEL}>Adresse ohne Kontakt hinzufügen</legend>
      <div>
        <label htmlFor={nameId} className="sr-only">Name</label>
        <input id={nameId} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" autoComplete="off" />
      </div>
      <div>
        <label htmlFor={mailId} className="sr-only">E-Mail-Adresse</label>
        <input
          id={mailId} type="email" className="input" value={email} placeholder="name@beispiel.de" autoComplete="off"
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${mailId}-err` : undefined}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
      </div>
      <button type="button" className="btn-secondary text-xs" onClick={add}>Hinzufügen</button>
      {error && <p id={`${mailId}-err`} className="col-span-3 text-xs text-danger-fg">{error}</p>}
    </fieldset>
  );
}

export function ContactGroupEditor({ initial, saving, onSave, onCancel }: {
  initial: ContactGroupDetail | null; saving: boolean;
  onSave: (name: string, members: GroupMember[]) => void; onCancel: () => void;
}) {
  const nameId = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [members, setMembers] = useState<GroupMember[]>(initial?.members ?? []);
  const [nameError, setNameError] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setNameError(true); return; }
    onSave(name.trim(), members);
  };
  const title = initial ? 'Kontaktliste bearbeiten' : 'Neue Kontaktliste';
  return (
    <form className="max-w-2xl p-6 space-y-5" onSubmit={submit} noValidate aria-label={title}>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        <button type="button" aria-label="Bearbeiten abbrechen" onClick={onCancel} className="btn-ghost p-1">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div>
        <label htmlFor={nameId} className={LABEL}>Name der Liste <span className="text-danger-fg" aria-hidden="true">*</span></label>
        <input
          id={nameId} className="input" value={name} required autoComplete="off"
          aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? `${nameId}-err` : undefined}
          onChange={(e) => { setName(e.target.value); setNameError(false); }}
        />
        {nameError && <p id={`${nameId}-err`} className="mt-1 text-xs text-danger-fg">Bitte einen Namen angeben.</p>}
      </div>
      <MemberSearch selfId={initial?.id ?? null} onPick={(m) => setMembers((list) => addMember(list, m))} />
      <AddressAdder onAdd={(m) => setMembers((list) => addMember(list, m))} />
      <div>
        <h3 className="text-xs font-semibold text-fg-subtle uppercase tracking-wider mb-2">Mitglieder ({members.length})</h3>
        <MemberList members={members} onRemove={(key) => setMembers((list) => removeMember(list, key))} />
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className="btn-secondary">Abbrechen</button>
        <button type="submit" disabled={saving} className="btn-primary disabled:opacity-50">Speichern</button>
      </div>
    </form>
  );
}
