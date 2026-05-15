import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Search, Pencil, Trash2, X, KeyRound, ChevronDown,
  UserCheck, UserX, Mail, Shield, HardDrive, Loader2,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';

// ── Typen ────────────────────────────────────────────────────────────────────
interface User {
  id: string; email: string; displayName: string; role: string;
  active: boolean; quotaBytes: number; usedBytes: number;
  domainId: string; createdAt: string;
}
interface Domain { id: string; name: string }

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────
function formatBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  return `${(b / 1e3).toFixed(0)} KB`;
}

const ROLES: Record<string, { label: string; color: string }> = {
  USER:                    { label: 'Benutzer',       color: 'badge-gray' },
  HELP_DESK:               { label: 'Helpdesk',       color: 'badge-blue' },
  RECIPIENT_MANAGEMENT:    { label: 'Empfänger-Mgmt', color: 'badge-blue' },
  COMPLIANCE_MANAGEMENT:   { label: 'Compliance',     color: 'badge-blue' },
  HYGIENE_MANAGEMENT:      { label: 'Schutz',         color: 'badge-blue' },
  SERVER_MANAGEMENT:       { label: 'Server',         color: 'badge-blue' },
  VIEW_ONLY_ORG:           { label: 'Nur-Lesen',      color: 'badge-gray' },
  ORGANIZATION_MANAGEMENT: { label: 'Administrator',  color: 'badge-orange' },
};

const QUOTA_OPTIONS = [
  { label: '1 GB',   value: 1_073_741_824 },
  { label: '2 GB',   value: 2_147_483_648 },
  { label: '5 GB',   value: 5_368_709_120 },
  { label: '10 GB',  value: 10_737_418_240 },
  { label: '25 GB',  value: 26_843_545_600 },
  { label: '50 GB',  value: 53_687_091_200 },
  { label: 'Unbegrenzt', value: 107_374_182_400 },
];

// ── Quota-Balken ─────────────────────────────────────────────────────────────
function QuotaBar({ used, total }: { used: number; total: number }) {
  const pct = Math.min(100, total > 0 ? (used / total) * 100 : 0);
  const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : 'bg-accent';
  return (
    <div className="space-y-0.5 w-32">
      <div className="flex justify-between text-xs text-gray-500">
        <span>{formatBytes(used)}</span>
        <span>{formatBytes(total)}</span>
      </div>
      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Leeres Formular ──────────────────────────────────────────────────────────
const EMPTY_FORM = {
  email: '', displayName: '', password: '', domainId: '',
  role: 'USER', quotaBytes: 5_368_709_120,
};

// ── Hauptkomponente ──────────────────────────────────────────────────────────
export function MailboxesPage() {
  const qc = useQueryClient();
  const [search, setSearch]           = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [showCreate, setShowCreate]   = useState(false);
  const [editUser, setEditUser]       = useState<User | null>(null);
  const [showResetPw, setShowResetPw] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [form, setForm]               = useState({ ...EMPTY_FORM });
  const [localPart, setLocalPart]     = useState(''); // Teil vor @

  const { data: mailboxes = [], isLoading } = useQuery<User[]>({
    queryKey: ['admin-mailboxes'],
    queryFn:  () => api.get<User[]>('/admin/mailboxes'),
  });
  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['admin-domains'],
    queryFn:  () => api.get<Domain[]>('/admin/domains'),
  });

  // Domain-Name nachschlagen
  const domainName = (id: string) => domains.find((d) => d.id === id)?.name ?? id;

  // Erstellen
  const createMutation = useMutation({
    mutationFn: () => api.post('/admin/mailboxes', form),
    onSuccess: () => {
      toast.success(`Postfach ${form.email} erstellt`);
      void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
      setShowCreate(false);
      setForm({ ...EMPTY_FORM });
      setLocalPart('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Bearbeiten
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.put(`/admin/mailboxes/${id}`, data),
    onSuccess: () => {
      toast.success('Gespeichert');
      void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
      setEditUser(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Aktivieren / Deaktivieren
  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.put(`/admin/mailboxes/${id}`, { active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] }),
    onError: (err: Error) => toast.error(err.message),
  });

  // Löschen
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/mailboxes/${id}`),
    onSuccess: () => {
      toast.success('Postfach gelöscht');
      void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Passwort-Reset
  const resetPwMutation = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.put(`/admin/mailboxes/${id}`, { password }),
    onSuccess: () => {
      toast.success('Passwort geändert');
      setShowResetPw(null);
      setNewPassword('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Filter
  const filtered = mailboxes.filter((u) => {
    const matchSearch = !search ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.displayName.toLowerCase().includes(search.toLowerCase());
    const matchDomain = !domainFilter || u.domainId === domainFilter;
    return matchSearch && matchDomain;
  });

  // Domain-Auswahl im Create-Dialog
  function selectDomain(domainId: string) {
    const d = domains.find((x) => x.id === domainId);
    const email = localPart && d ? `${localPart}@${d.name}` : '';
    setForm({ ...form, domainId, email });
  }

  function setLocal(val: string) {
    setLocalPart(val);
    const d = domains.find((x) => x.id === form.domainId);
    setForm({ ...form, email: d ? `${val}@${d.name}` : val });
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-4">
      {/* Kopfzeile */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Benutzerverwaltung</h1>
          <p className="text-xs text-gray-400 mt-0.5">{mailboxes.length} Postfächer gesamt</p>
        </div>
        <button onClick={() => { setForm({ ...EMPTY_FORM }); setLocalPart(''); setShowCreate(true); }}
          className="btn-primary flex items-center gap-1.5">
          <Plus size={15} /> Neuer Benutzer
        </button>
      </div>

      {/* Filter-Leiste */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            className="input pl-8 w-60" placeholder="Name oder E-Mail suchen..." />
        </div>

        <div className="relative">
          <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)}
            className="input pr-8 appearance-none cursor-pointer">
            <option value="">Alle Domains</option>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({mailboxes.filter((u) => u.domainId === d.id).length})
              </option>
            ))}
          </select>
          <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>

        {(search || domainFilter) && (
          <button onClick={() => { setSearch(''); setDomainFilter(''); }}
            className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <X size={12} /> Filter löschen
          </button>
        )}
      </div>

      {/* Tabelle */}
      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['Benutzer', 'Domain', 'Rolle', 'Speicher', 'Status', 'Aktionen'].map((h) => (
                <th key={h} className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center">
                <Loader2 size={20} className="animate-spin mx-auto text-gray-400" />
              </td></tr>
            )}
            {!isLoading && filtered.map((u) => {
              const role = ROLES[u.role] ?? { label: u.role, color: 'badge-gray' };
              return (
                <tr key={u.id} className={`hover:bg-gray-50 transition-colors ${!u.active ? 'opacity-60' : ''}`}>
                  {/* Benutzer */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
                        <span className="text-xs font-semibold text-accent">
                          {u.displayName.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium text-gray-800 text-sm">{u.displayName}</p>
                        <p className="text-xs text-gray-400 flex items-center gap-1">
                          <Mail size={10} />{u.email}
                        </p>
                      </div>
                    </div>
                  </td>

                  {/* Domain */}
                  <td className="px-4 py-3">
                    <span className="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                      {domainName(u.domainId)}
                    </span>
                  </td>

                  {/* Rolle */}
                  <td className="px-4 py-3">
                    <span className={`badge text-xs ${role.color} flex items-center gap-1 w-fit`}>
                      {u.role === 'ORGANIZATION_MANAGEMENT' && <Shield size={10} />}
                      {role.label}
                    </span>
                  </td>

                  {/* Speicher */}
                  <td className="px-4 py-3">
                    <QuotaBar used={u.usedBytes} total={u.quotaBytes} />
                  </td>

                  {/* Status */}
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleMutation.mutate({ id: u.id, active: !u.active })}
                      className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border cursor-pointer transition-colors ${
                        u.active
                          ? 'bg-green-50 border-green-200 text-green-700 hover:bg-green-100'
                          : 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'
                      }`}
                      title={u.active ? 'Klicken zum Deaktivieren' : 'Klicken zum Aktivieren'}
                    >
                      {u.active ? <><UserCheck size={11} /> Aktiv</> : <><UserX size={11} /> Deaktiviert</>}
                    </button>
                  </td>

                  {/* Aktionen */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditUser(u)}
                        className="btn-ghost p-1.5 rounded hover:bg-gray-100"
                        title="Bearbeiten"
                      >
                        <Pencil size={13} className="text-gray-500" />
                      </button>
                      <button
                        onClick={() => { setShowResetPw(u); setNewPassword(''); }}
                        className="btn-ghost p-1.5 rounded hover:bg-blue-50"
                        title="Passwort zurücksetzen"
                      >
                        <KeyRound size={13} className="text-blue-500" />
                      </button>
                      <button
                        onClick={() => { if (confirm(`Postfach "${u.email}" wirklich löschen?`)) deleteMutation.mutate(u.id); }}
                        className="btn-ghost p-1.5 rounded hover:bg-red-50"
                        title="Löschen"
                      >
                        <Trash2 size={13} className="text-red-500" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!isLoading && filtered.length === 0 && (
              <tr><td colSpan={6} className="py-10 text-center text-gray-400 text-sm">
                {search || domainFilter ? 'Keine Treffer für diesen Filter' : 'Noch keine Benutzer angelegt'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Dialog: Neuer Benutzer ──────────────────────────────────────────── */}
      {showCreate && (
        <Modal title="Neuen Benutzer anlegen" onClose={() => setShowCreate(false)}>
          <div className="space-y-4">
            {/* Domain zuerst wählen */}
            <div>
              <label className="field-label">Domain <span className="text-red-500">*</span></label>
              <select className="input w-full" value={form.domainId} onChange={(e) => selectDomain(e.target.value)}>
                <option value="">Domain wählen…</option>
                {domains.map((d) => <option key={d.id} value={d.id}>@{d.name}</option>)}
              </select>
              {domains.length === 0 && (
                <p className="text-xs text-amber-600 mt-1">Keine Domains vorhanden — bitte zuerst eine Domain anlegen.</p>
              )}
            </div>

            {/* E-Mail aufgeteilt in Localpart + Domain */}
            <div>
              <label className="field-label">E-Mail-Adresse <span className="text-red-500">*</span></label>
              <div className="flex items-center gap-0">
                <input
                  className="input rounded-r-none flex-1"
                  placeholder="benutzername"
                  value={localPart}
                  onChange={(e) => setLocal(e.target.value)}
                />
                <span className="px-3 py-2 bg-gray-100 border border-l-0 border-gray-300 text-gray-500 text-sm rounded-r">
                  @{form.domainId ? domainName(form.domainId) : 'domain.com'}
                </span>
              </div>
              {form.email && <p className="text-xs text-gray-400 mt-1">→ {form.email}</p>}
            </div>

            <div>
              <label className="field-label">Anzeigename <span className="text-red-500">*</span></label>
              <input className="input w-full" placeholder="Max Mustermann"
                value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </div>

            <div>
              <label className="field-label">Passwort <span className="text-red-500">*</span></label>
              <input type="password" className="input w-full" placeholder="Mindestens 8 Zeichen"
                value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              {form.password && form.password.length < 8 && (
                <p className="text-xs text-red-500 mt-1">Passwort zu kurz (min. 8 Zeichen)</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Rolle</label>
                <select className="input w-full" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {Object.entries(ROLES).map(([value, { label }]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label flex items-center gap-1"><HardDrive size={12} /> Speicherkontingent</label>
                <select className="input w-full" value={form.quotaBytes}
                  onChange={(e) => setForm({ ...form, quotaBytes: parseInt(e.target.value) })}>
                  {QUOTA_OPTIONS.map((q) => (
                    <option key={q.value} value={q.value}>{q.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <button onClick={() => setShowCreate(false)} className="btn-secondary">Abbrechen</button>
            <button
              onClick={() => createMutation.mutate()}
              disabled={!form.email || !form.password || form.password.length < 8 || !form.domainId || !form.displayName || createMutation.isPending}
              className="btn-primary disabled:opacity-50 flex items-center gap-2"
            >
              {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              Benutzer erstellen
            </button>
          </div>
        </Modal>
      )}

      {/* ── Dialog: Bearbeiten ─────────────────────────────────────────────── */}
      {editUser && (
        <Modal title={`Benutzer bearbeiten — ${editUser.email}`} onClose={() => setEditUser(null)}>
          <EditForm user={editUser} domains={domains} onSave={(data) => updateMutation.mutate({ id: editUser.id, data })} isPending={updateMutation.isPending} />
        </Modal>
      )}

      {/* ── Dialog: Passwort zurücksetzen ──────────────────────────────────── */}
      {showResetPw && (
        <Modal title={`Passwort zurücksetzen — ${showResetPw.email}`} onClose={() => setShowResetPw(null)}>
          <div className="space-y-3">
            <p className="text-sm text-gray-600">Neues Passwort für <strong>{showResetPw.displayName}</strong> festlegen:</p>
            <input
              type="password" className="input w-full" placeholder="Neues Passwort (mind. 8 Zeichen)"
              value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
              autoFocus
            />
            {newPassword && newPassword.length < 8 && (
              <p className="text-xs text-red-500">Passwort zu kurz (min. 8 Zeichen)</p>
            )}
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <button onClick={() => setShowResetPw(null)} className="btn-secondary">Abbrechen</button>
            <button
              onClick={() => resetPwMutation.mutate({ id: showResetPw.id, password: newPassword })}
              disabled={newPassword.length < 8 || resetPwMutation.isPending}
              className="btn-primary disabled:opacity-50 flex items-center gap-2"
            >
              {resetPwMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              Passwort setzen
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Modal-Wrapper ────────────────────────────────────────────────────────────
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="btn-ghost p-1 rounded hover:bg-gray-100">
            <X size={16} className="text-gray-500" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ── Edit-Formular ────────────────────────────────────────────────────────────
function EditForm({
  user, domains, onSave, isPending,
}: {
  user: User;
  domains: Domain[];
  onSave: (data: Record<string, unknown>) => void;
  isPending: boolean;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole]               = useState(user.role);
  const [quotaBytes, setQuotaBytes]   = useState(user.quotaBytes);

  const domainName = domains.find((d) => d.id === user.domainId)?.name ?? user.domainId;

  return (
    <div className="space-y-4">
      {/* E-Mail (nicht änderbar) */}
      <div>
        <label className="field-label">E-Mail-Adresse</label>
        <input className="input w-full bg-gray-50 cursor-not-allowed" value={user.email} disabled />
      </div>
      <div>
        <label className="field-label">Domain</label>
        <input className="input w-full bg-gray-50 cursor-not-allowed" value={`@${domainName}`} disabled />
      </div>
      <div>
        <label className="field-label">Anzeigename</label>
        <input className="input w-full" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="field-label">Rolle</label>
          <select className="input w-full" value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.entries(ROLES).map(([value, { label }]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label flex items-center gap-1"><HardDrive size={12} /> Kontingent</label>
          <select className="input w-full" value={quotaBytes} onChange={(e) => setQuotaBytes(parseInt(e.target.value))}>
            {QUOTA_OPTIONS.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={() => onSave({ displayName, role, quotaBytes })}
          disabled={!displayName || isPending}
          className="btn-primary disabled:opacity-50 flex items-center gap-2"
        >
          {isPending && <Loader2 size={14} className="animate-spin" />}
          Speichern
        </button>
      </div>
    </div>
  );
}
