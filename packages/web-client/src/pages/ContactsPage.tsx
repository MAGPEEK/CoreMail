import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FolderOpen, Search, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { contactPath, itemIdFromPath } from '../lib/mailLinks.js';
import { api } from '../api/client.js';
import type { Contact } from '../api/types.js';
import { PageShell } from '../components/PageShell.js';
import { useUiStore } from '../store/ui.js';
import { useAuthStore } from '../store/auth.js';
import { useOwnProfile } from '../hooks/useUserPhoto.js';
import { formatRecipient } from '../lib/recipients.js';
import { contactPayload, emptyContactForm, formFromContact, type ContactDetail } from '../lib/contactForm.js';
import {
  expansionNotice, memberInput, recipientEntries,
  type ContactGroupDetail, type ContactGroupSummary, type GroupExpansion, type GroupMember,
} from '../lib/contactGroups.js';
import { categoryOptions, toggleCategory } from '../lib/itemCategories.js';
import {
  ALL_CONTACTS_VIEW, categoryCounts, contactInfoLines, countLabel, filterByCategory, isOwnContact, primaryPhone, sortContacts, telHref,
  type ContactSortKey, type DirectoryEntry, type SidebarView,
} from '../lib/contactsList.js';
import { selectionFacts, type ContactsAction, type ContactsSelectionKind } from '../lib/contactsRibbon.js';
import { useWebmailFeatures } from '../hooks/useWebmailFeatures.js';
import type { ContextMenuItem } from '../components/ContextMenu.js';
import { useCategoryDefs } from '../components/CategoryPicker.js';
import { ContactEditor } from '../components/contacts/ContactEditor.js';
import { ContactAvatar, ContactDetails } from '../components/contacts/ContactDetails.js';
import { ContactGroupDetails, ContactGroupEditor } from '../components/contacts/ContactGroupPanel.js';
import { PaneCard } from '../components/PaneCard.js';
import { ContactsRibbon } from '../components/contacts/ContactsRibbon.js';
import { ContactsSidebar } from '../components/contacts/ContactsSidebar.js';
import { EntryList, type EntryRow } from '../components/contacts/EntryList.js';
import { DirectoryDetails } from '../components/contacts/DirectoryDetails.js';
import { AboutDialog } from '../components/AboutDialog.js';

type Selection = { kind: 'contact' | 'group' | 'directory'; id: string } | null;
type Mode = 'view' | 'edit' | 'new';
/** Phones show one pane at a time; from md on all three are side by side. */
type Pane = 'nav' | 'list' | 'detail';

const GAL_LIMIT = 200;

function viewTitle(view: SidebarView): string {
  if (view.kind === 'groups') return 'Ihre Kontaktlisten';
  if (view.kind === 'directory') return 'Globales Adressbuch';
  return view.category ?? 'Ihre Kontakte';
}

export function ContactsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const openCompose = useUiStore((s) => s.openCompose);
  const setShortcutHelpOpen = useUiStore((s) => s.setShortcutHelpOpen);
  const authEmail = useAuthStore((s) => s.email);
  const { data: profile } = useOwnProfile();
  const ownAddress = authEmail || profile?.email || '';
  const categoriesAvailable = useWebmailFeatures().features.categories;
  const categoryDefs = useCategoryDefs();
  const [view, setView] = useState<SidebarView>(ALL_CONTACTS_VIEW);
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [newKind, setNewKind] = useState<'contact' | 'group'>('contact');
  const [sort, setSort] = useState<ContactSortKey>('given');
  const [pane, setPane] = useState<Pane>('list');
  const [aboutOpen, setAboutOpen] = useState(false);

  // 9.4: /contacts/<id> shows the contact (shareable, back/forward)
  const linkedId = itemIdFromPath(location.pathname, '/contacts/');
  useEffect(() => {
    if (linkedId) { setSelection({ kind: 'contact', id: linkedId }); setView(ALL_CONTACTS_VIEW); setMode('view'); setPane('detail'); }
  }, [linkedId]);

  const searching = search.trim().length >= 2;
  const { data: allContacts } = useQuery({
    queryKey: ['contacts', 'list', ''],
    queryFn: () => api.get<Contact[]>('/contacts'),
    staleTime: 10_000,
  });
  const { data: foundContacts } = useQuery({
    queryKey: ['contacts', 'list', search],
    queryFn: () => api.get<Contact[]>(`/contacts?q=${encodeURIComponent(search)}`),
    enabled: searching,
    staleTime: 10_000,
  });
  const { data: groups } = useQuery({
    queryKey: ['contacts', 'groups'],
    queryFn: () => api.get<ContactGroupSummary[]>('/contacts/groups'),
    staleTime: 10_000,
  });
  const { data: directory } = useQuery({
    queryKey: ['contacts', 'gal', search],
    queryFn: () => api.get<{ entries: DirectoryEntry[] }>(`/contacts/gal?limit=${GAL_LIMIT}${searching ? `&q=${encodeURIComponent(search)}` : ''}`),
    enabled: view.kind === 'directory',
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
  const leaveDetail = () => { setSelection(null); setPane('list'); };

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
  const assignCategories = useMutation({
    mutationFn: (categories: string[]) => api.put<ContactDetail>(`/contacts/${contactId!}`, contactPayload({ ...formFromContact(contact!), categories })),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const deleteContact = useMutation({
    mutationFn: (id: string) => api.delete(`/contacts/${id}`),
    onSuccess: () => { toast.success('Kontakt gelöscht'); void refresh(); leaveDetail(); },
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
    onSuccess: () => { toast.success('Kontaktliste gelöscht'); void refresh(); leaveDetail(); },
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

  // ── Lists of the middle pane ────────────────────────────────────────────────
  const ownContacts = useMemo(() => (allContacts ?? []).filter(isOwnContact), [allContacts]);
  const shownContacts = useMemo(() => {
    const base = searching ? (foundContacts ?? []).filter(isOwnContact) : ownContacts;
    return sortContacts(filterByCategory(base, view.kind === 'contacts' ? view.category : null), sort);
  }, [searching, foundContacts, ownContacts, view, sort]);
  const categories = useMemo(() => categoryCounts(ownContacts), [ownContacts]);
  const q = search.trim().toLowerCase();
  const shownGroups = (groups ?? []).filter((g) => !searching || g.name.toLowerCase().includes(q));
  const directoryEntries = directory?.entries ?? [];

  const rows: EntryRow[] = view.kind === 'groups'
    ? shownGroups.map((g) => ({
      id: g.id, name: g.name, info: [countLabel(g.memberCount, 'Mitglied', 'Mitglieder')],
      avatar: <span className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-white shrink-0" aria-hidden="true"><Users size={15} /></span>,
    }))
    : view.kind === 'directory'
      ? directoryEntries.map((e) => ({
        id: e.id, name: e.displayName, info: [e.email],
        avatar: <ContactAvatar name={e.displayName} email={e.email} className="w-9 h-9 text-xs" />,
      }))
      : shownContacts.map((c) => ({
        id: c.id, name: c.displayName, info: contactInfoLines(c),
        avatar: <ContactAvatar name={c.displayName} email={c.email} className="w-9 h-9 text-xs" />,
      }));
  const emptyText = view.kind === 'groups' ? 'Keine Kontaktlisten' : view.kind === 'directory' ? 'Keine Einträge gefunden' : 'Keine Kontakte gefunden';
  const rowKind: 'contact' | 'group' | 'directory' = view.kind === 'groups' ? 'group' : view.kind === 'directory' ? 'directory' : 'contact';

  // ── Navigation / selection ──────────────────────────────────────────────────
  const changeView = (next: SidebarView) => {
    setView(next); setSelection(null); setMode('view'); setPane('list');
    if (linkedId) navigate('/contacts');
  };
  const select = (id: string) => {
    setSelection({ kind: rowKind, id }); setMode('view'); setPane('detail');
    if (rowKind === 'contact') navigate(contactPath(id));
    else if (linkedId) navigate('/contacts');
  };
  const startNew = (kind: 'contact' | 'group') => {
    if (kind === 'group') { if (view.kind !== 'groups') setView({ kind: 'groups' }); }
    else if (view.kind !== 'contacts') setView(ALL_CONTACTS_VIEW);
    setSelection(null); setNewKind(kind); setMode('new'); setPane('detail');
    if (linkedId) navigate('/contacts');
  };
  const cancel = () => { setMode('view'); if (!selection) setPane('list'); };

  // ── Ribbon ──────────────────────────────────────────────────────────────────
  const directoryEntry = selection?.kind === 'directory' ? directoryEntries.find((e) => e.id === selection.id) ?? null : null;
  const loadedContact = contact && contact.id === contactId ? contact : null;
  const loadedGroup = group && group.id === groupId ? group : null;
  const contactForm = loadedContact ? formFromContact(loadedContact) : null;
  const contactAddress = contactForm?.emails.find((e) => e.value.trim())?.value ?? null;
  const kind: ContactsSelectionKind = selection?.kind ?? 'none';
  const ribbonSelection = selectionFacts({
    kind,
    editing: mode !== 'view',
    hasRecipients: kind === 'contact' ? !!contactAddress : kind === 'group' ? (loadedGroup?.members.length ?? 0) > 0 : !!directoryEntry,
    phone: loadedContact ? primaryPhone({ ...loadedContact, phones: contactForm?.phones ?? [] }) : null,
    categoriesAvailable,
  });

  const handlers: Record<ContactsAction, () => void> = {
    newContact: () => startNew('contact'),
    newGroup: () => startNew('group'),
    edit: () => setMode('edit'),
    delete: () => {
      if (selection?.kind === 'contact') deleteContact.mutate(selection.id);
      else if (selection?.kind === 'group') deleteGroup.mutate(selection.id);
    },
    mail: () => {
      if (selection?.kind === 'group') sendToGroup.mutate(selection.id);
      else if (selection?.kind === 'directory' && directoryEntry) mailTo(directoryEntry.displayName, directoryEntry.email);
      else if (loadedContact && contactAddress) mailTo(loadedContact.displayName, contactAddress);
    },
    call: () => { if (ribbonSelection.phone) window.location.href = telHref(ribbonSelection.phone); },
    categorize: () => undefined, // opens its menu (categoryMenu)
    sortGiven: () => setSort('given'),
    sortFamily: () => setSort('family'),
    shortcuts: () => setShortcutHelpOpen(true),
    about: () => setAboutOpen(true),
  };

  const categoryMenu = (): ContextMenuItem[] => {
    const current = contactForm?.categories ?? [];
    const options = categoryOptions(categoryDefs, current);
    if (options.length === 0) return [{ label: 'Noch keine Kategorien', disabled: true }];
    return options.map((o) => ({
      label: o.name,
      checked: current.some((n) => n.toLowerCase() === o.name.toLowerCase()),
      onClick: () => assignCategories.mutate(toggleCategory(current, o.name)),
    }));
  };

  const renderPanel = () => {
    if (mode === 'new') {
      return newKind === 'contact'
        ? <ContactEditor key="new" title="Neuer Kontakt" initial={emptyContactForm()} saving={saveContact.isPending} onSave={(p) => saveContact.mutate(p)} onCancel={cancel} />
        : <ContactGroupEditor key="new-group" initial={null} saving={saveGroup.isPending} onSave={(name, members) => saveGroup.mutate({ name, members })} onCancel={cancel} />;
    }
    if (loadedContact) {
      return mode === 'edit'
        ? <ContactEditor key={loadedContact.id} title="Kontakt bearbeiten" initial={formFromContact(loadedContact)} saving={saveContact.isPending} onSave={(p) => saveContact.mutate(p)} onCancel={cancel} />
        : <ContactDetails contact={loadedContact} />;
    }
    if (loadedGroup) {
      return mode === 'edit'
        ? <ContactGroupEditor key={loadedGroup.id} initial={loadedGroup} saving={saveGroup.isPending} onSave={(name, members) => saveGroup.mutate({ name, members })} onCancel={cancel} />
        : <ContactGroupDetails group={loadedGroup} />;
    }
    if (directoryEntry) return <DirectoryDetails entry={directoryEntry} />;
    return (
      <div className="flex items-center justify-center text-fg-subtle text-sm h-full p-6 text-center">
        {view.kind === 'groups' ? 'Kontaktliste auswählen oder neu erstellen' : view.kind === 'directory' ? 'Eintrag auswählen' : 'Kontakt auswählen oder neu erstellen'}
      </div>
    );
  };

  const show = (p: Pane) => (pane === p ? 'flex' : 'hidden md:flex');
  const searchLabel = view.kind === 'groups' ? 'Kontaktlisten durchsuchen' : view.kind === 'directory' ? 'Globales Adressbuch durchsuchen' : 'Kontakte durchsuchen';
  return (
    <PageShell
      title="Kontakte"
      commandBar={<ContactsRibbon selection={ribbonSelection} handlers={handlers} sort={sort} categoryMenu={categoryMenu} />}
      ribbon
      bodyCard={false}
      bodyClassName="md:gap-2"
    >
      <PaneCard label="Kontaktordner" className={`${show('nav')} flex-1 md:flex-none md:w-60 shrink-0`}>
        <ContactsSidebar
          address={ownAddress} view={view} onView={changeView}
          contactCount={ownContacts.length} groupCount={groups?.length ?? 0} categories={categories}
        />
      </PaneCard>

      <PaneCard label={viewTitle(view)} className={`${show('list')} flex-1 md:flex-none md:w-[26rem] shrink-0`}>
        <div className="p-3 border-b border-line flex items-center gap-2">
          <button type="button" className="btn-ghost p-1.5 md:hidden shrink-0" aria-label="Ordner anzeigen" onClick={() => setPane('nav')}>
            <FolderOpen size={16} aria-hidden="true" />
          </button>
          <h2 className="text-sm font-semibold text-fg truncate shrink-0 max-w-[40%]">{viewTitle(view)}</h2>
          <div className="relative flex-1 min-w-0">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} className="input pl-8 text-xs" aria-label={searchLabel} placeholder="Suchen…" />
          </div>
        </div>
        <EntryList label={viewTitle(view)} rows={rows} selectedId={selection?.kind === rowKind ? selection.id : null} onSelect={select} empty={emptyText} />
      </PaneCard>

      <PaneCard label="Details" className={`${show('detail')} flex-1`}>
        <div className="md:hidden border-b border-line p-2">
          <button type="button" className="btn-ghost text-xs flex items-center gap-1" onClick={() => { setMode('view'); setPane('list'); }}>
            <ArrowLeft size={14} aria-hidden="true" /> Zurück zur Liste
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{renderPanel()}</div>
      </PaneCard>

      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </PageShell>
  );
}
