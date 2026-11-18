import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { contactPath, itemIdFromPath } from '../lib/mailLinks.js';
import { api } from '../api/client.js';
import type { Contact } from '../api/types.js';
import { PageShell } from '../components/PageShell.js';
import { useUiStore } from '../store/ui.js';
import { formatRecipient } from '../lib/recipients.js';
import { emptyContactForm, formFromContact, type ContactDetail } from '../lib/contactForm.js';
import {
  expansionNotice, memberInput, recipientEntries,
  type ContactGroupDetail, type ContactGroupSummary, type GroupExpansion, type GroupMember,
} from '../lib/contactGroups.js';
import { ContactEditor } from '../components/contacts/ContactEditor.js';
import { ContactDetails, initials } from '../components/contacts/ContactDetails.js';
import { ContactGroupDetails, ContactGroupEditor } from '../components/contacts/ContactGroupPanel.js';

type Tab = 'contacts' | 'groups';
type Selection = { kind: 'contact'; id: string } | { kind: 'group'; id: string } | null;
type Mode = 'view' | 'edit' | 'new';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'contacts', label: 'Kontakte' },
  { id: 'groups', label: 'Kontaktlisten' },
];

export function ContactsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const openCompose = useUiStore((s) => s.openCompose);
  const [tab, setTab] = useState<Tab>('contacts');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection>(null);
  const [mode, setMode] = useState<Mode>('view');

  // 9.4: /contacts/<id> shows the contact (shareable, back/forward)
  const linkedId = itemIdFromPath(location.pathname, '/contacts/');
  useEffect(() => {
    if (linkedId) { setSelection({ kind: 'contact', id: linkedId }); setTab('contacts'); setMode('view'); }
  }, [linkedId]);

  const { data: contacts } = useQuery({
    queryKey: ['contacts', 'list', search],
    queryFn: () => api.get<Contact[]>(`/contacts${search.length >= 2 ? `?q=${encodeURIComponent(search)}` : ''}`),
    staleTime: 10_000,
  });
  const { data: groups } = useQuery({
    queryKey: ['contacts', 'groups'],
    queryFn: () => api.get<ContactGroupSummary[]>('/contacts/groups'),
    staleTime: 10_000,
  });
  const contactId = selection?.kind === 'contact' ? selection.id : null;
  const groupId = selection?.kind === 'group' ? selection.id : null;
  const { data: contact } = useQuery({
    queryKey: ['contacts', 'detail', contactId],
    queryFn: () => api.get<ContactDetail>(`/contacts/${contactId!}`),
    enabled: !!contactId,
    retry: false,
    meta: { silentError: true }, // a deleted / foreign contact just shows nothing
  });
  const { data: group } = useQuery({
    queryKey: ['contacts', 'group', groupId],
    queryFn: () => api.get<ContactGroupDetail>(`/contacts/groups/${groupId!}`),
    enabled: !!groupId,
    retry: false,
    meta: { silentError: true },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['contacts'] });
  const fail = (err: Error) => toast.error(err.message);

  const saveContact = useMutation({
    mutationFn: (payload: Record<string, unknown>) => (mode === 'new'
      ? api.post<ContactDetail>('/contacts', payload)
      : api.put<ContactDetail>(`/contacts/${contactId!}`, payload)),
    onSuccess: (c) => {
      toast.success(mode === 'new' ? 'Kontakt erstellt' : 'Kontakt gespeichert');
      void refresh();
      setSelection({ kind: 'contact', id: c.id });
      setMode('view');
    },
    onError: fail,
  });
  const deleteContact = useMutation({
    mutationFn: (id: string) => api.delete(`/contacts/${id}`),
    onSuccess: () => { toast.success('Kontakt gelöscht'); void refresh(); setSelection(null); },
    onError: fail,
  });
  const saveGroup = useMutation({
    mutationFn: ({ name, members }: { name: string; members: GroupMember[] }) => {
      const body = { name, members: members.map(memberInput) };
      return mode === 'new'
        ? api.post<ContactGroupDetail>('/contacts/groups', body)
        : api.put<ContactGroupDetail>(`/contacts/groups/${groupId!}`, body);
    },
    onSuccess: (g) => {
      toast.success(mode === 'new' ? 'Kontaktliste erstellt' : 'Kontaktliste gespeichert');
      void refresh();
      setSelection({ kind: 'group', id: g.id });
      setMode('view');
    },
    onError: fail,
  });
  const deleteGroup = useMutation({
    mutationFn: (id: string) => api.delete(`/contacts/groups/${id}`),
    onSuccess: () => { toast.success('Kontaktliste gelöscht'); void refresh(); setSelection(null); },
    onError: fail,
  });
  const sendToGroup = useMutation({
    mutationFn: (id: string) => api.get<GroupExpansion>(`/contacts/groups/${id}/expand`),
    onSuccess: (exp) => {
      const entries = recipientEntries(exp);
      if (entries.length === 0) { toast.error('Die Kontaktliste enthält keine E-Mail-Adressen.'); return; }
      openCompose({ mode: 'new', toAddrs: entries });
      navigate('/mail');
      const notice = expansionNotice(exp);
      if (notice) toast(notice);
    },
    onError: fail,
  });

  const mailTo = (name: string, address: string) => {
    openCompose({ mode: 'new', toAddrs: [formatRecipient(name, address)] });
    navigate('/mail');
  };

  const startNew = () => { setSelection(null); setMode('new'); };
  const selectContact = (id: string) => { setSelection({ kind: 'contact', id }); setMode('view'); navigate(contactPath(id)); };
  const selectGroup = (id: string) => { setSelection({ kind: 'group', id }); setMode('view'); if (linkedId) navigate('/contacts'); };
  const cancel = () => setMode('view');

  const q = search.trim().toLowerCase();
  const shownGroups = (groups ?? []).filter((g) => q.length < 2 || g.name.toLowerCase().includes(q));

  const renderPanel = () => {
    if (tab === 'contacts' && mode === 'new') {
      return <ContactEditor key="new" title="Neuer Kontakt" initial={emptyContactForm()} saving={saveContact.isPending} onSave={(p) => saveContact.mutate(p)} onCancel={cancel} />;
    }
    if (tab === 'groups' && mode === 'new') {
      return <ContactGroupEditor key="new-group" initial={null} saving={saveGroup.isPending} onSave={(name, members) => saveGroup.mutate({ name, members })} onCancel={cancel} />;
    }
    if (contactId && contact && contact.id === contactId) {
      return mode === 'edit'
        ? <ContactEditor key={contact.id} title="Kontakt bearbeiten" initial={formFromContact(contact)} saving={saveContact.isPending} onSave={(p) => saveContact.mutate(p)} onCancel={cancel} />
        : <ContactDetails contact={contact} onEdit={() => setMode('edit')} onDelete={() => deleteContact.mutate(contact.id)} onMail={(a) => mailTo(contact.displayName, a)} />;
    }
    if (groupId && group && group.id === groupId) {
      return mode === 'edit'
        ? <ContactGroupEditor key={group.id} initial={group} saving={saveGroup.isPending} onSave={(name, members) => saveGroup.mutate({ name, members })} onCancel={cancel} />
        : <ContactGroupDetails group={group} sending={sendToGroup.isPending} onSend={() => sendToGroup.mutate(group.id)} onEdit={() => setMode('edit')} onDelete={() => deleteGroup.mutate(group.id)} />;
    }
    return (
      <div className="flex-1 flex items-center justify-center text-fg-subtle text-sm h-full">
        {tab === 'contacts' ? 'Kontakt auswählen oder neu erstellen' : 'Kontaktliste auswählen oder neu erstellen'}
      </div>
    );
  };

  const newLabel = tab === 'contacts' ? 'Neuer Kontakt' : 'Neue Kontaktliste';
  return (
    <PageShell title="Kontakte">
      {/* ── Sidebar: contacts / contact groups ─────────────────────────── */}
      <div className="w-80 shrink-0 border-r border-line bg-surface flex flex-col">
        <div role="tablist" aria-label="Ansicht" className="flex border-b border-line">
          {TABS.map((t) => (
            <button
              key={t.id} type="button" role="tab" aria-selected={tab === t.id} id={`contacts-tab-${t.id}`} aria-controls="contacts-list"
              onClick={() => { setTab(t.id); setMode('view'); }}
              className={`flex-1 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id ? 'border-accent-fg text-fg' : 'border-transparent text-fg-muted hover:text-fg'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="p-3 border-b border-line flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
            <input
              value={search} onChange={(e) => setSearch(e.target.value)} className="input pl-8 text-xs"
              aria-label={tab === 'contacts' ? 'Kontakte durchsuchen' : 'Kontaktlisten durchsuchen'}
              placeholder={tab === 'contacts' ? 'Kontakt suchen…' : 'Liste suchen…'}
            />
          </div>
          <button type="button" aria-label={newLabel} title={newLabel} onClick={startNew} className="btn-primary text-xs shrink-0">
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>

        <div id="contacts-list" role="tabpanel" aria-labelledby={`contacts-tab-${tab}`} className="flex-1 overflow-y-auto">
          {tab === 'contacts' ? (
            <>
              {(contacts ?? []).map((c) => (
                <button
                  key={c.id} type="button" onClick={() => selectContact(c.id)}
                  aria-current={contactId === c.id ? 'true' : undefined}
                  className={`w-full text-left flex items-center gap-3 px-3 py-2.5 border-b border-line hover:bg-surface-2 transition-colors ${contactId === c.id ? 'bg-accent/5' : ''}`}
                >
                  <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-white text-xs font-bold shrink-0" aria-hidden="true">
                    {initials(c.displayName)}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg truncate">{c.displayName}</p>
                    <p className="text-xs text-fg-subtle truncate">{c.jobTitle || c.email}</p>
                  </div>
                </button>
              ))}
              {contacts?.length === 0 && <div className="py-8 text-center text-fg-subtle text-sm">Keine Kontakte gefunden</div>}
            </>
          ) : (
            <>
              {shownGroups.map((g) => (
                <button
                  key={g.id} type="button" onClick={() => selectGroup(g.id)}
                  aria-current={groupId === g.id ? 'true' : undefined}
                  className={`w-full text-left flex items-center gap-3 px-3 py-2.5 border-b border-line hover:bg-surface-2 transition-colors ${groupId === g.id ? 'bg-accent/5' : ''}`}
                >
                  <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-white shrink-0" aria-hidden="true">
                    <Users size={15} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg truncate">{g.name}</p>
                    <p className="text-xs text-fg-subtle">{g.memberCount} {g.memberCount === 1 ? 'Mitglied' : 'Mitglieder'}</p>
                  </div>
                </button>
              ))}
              {groups && shownGroups.length === 0 && <div className="py-8 text-center text-fg-subtle text-sm">Keine Kontaktlisten</div>}
            </>
          )}
        </div>
      </div>

      {/* ── Detail / edit panel ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto bg-surface">{renderPanel()}</div>
    </PageShell>
  );
}
