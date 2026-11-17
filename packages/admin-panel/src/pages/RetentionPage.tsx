import { useId, useState } from 'react';
import { Modal } from '../components/Modal.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Archive, Plus, Pencil, Trash2, Tag, ListChecks, Play, Loader2, Globe, User as UserIcon,
  X, Folder as FolderIcon, AlertCircle,
  Sparkles, Inbox, Send, Mail as MailIcon, ShieldCheck, FileText, Clock,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { errorMessage } from '../lib/errors.js';
import { parseRetentionDays, policyBody, tagChangePlan } from '../lib/retention.js';
import { useT } from '../i18n/useT.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type TagType   = 'DPT' | 'RPT' | 'PERSONAL';
type TagAction = 'MOVE_TO_ARCHIVE' | 'DELETE_AND_ALLOW_RECOVERY' | 'PERMANENTLY_DELETE' | 'MARK_AS_PAST_RETENTION_LIMIT';
type FolderTarget = 'INBOX'|'SENT_ITEMS'|'DELETED_ITEMS'|'JUNK_EMAIL'|'DRAFTS'|'OUTBOX'|'RECOVERABLE_ITEMS'|'ARCHIVE'|'ALL_OTHER';

interface RetentionTag {
  id: string;
  name: string;
  description: string;
  type: TagType;
  action: TagAction;
  retentionDays: number;
  folderTarget: FolderTarget | null;
  enabled: boolean;
  isSystem: boolean;
  createdAt: string;
  _count?: { policyTags: number; messages: number; folders: number };
}

interface RetentionPolicy {
  id: string;
  name: string;
  description: string;
  retentionDays: number;
  action: 'ARCHIVE' | 'DELETE' | 'MOVE_TO_FOLDER';
  targetFolder?: string;
  scope: 'ALL_ITEMS' | 'INBOX' | 'SENT_ITEMS' | 'DELETED_ITEMS' | 'JUNK';
  enabled: boolean;
  createdAt: string;
  _count?: { assignments: number };
  policyTags?: { policyId: string; tagId: string; tag: RetentionTag }[];
}

interface ManagedFolderRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  mailboxesScanned: number;
  itemsScanned: number;
  itemsArchived: number;
  itemsSoftDeleted: number;
  itemsHardDeleted: number;
  throttled: boolean;
  errorMessage: string | null;
}

interface PolicyAssignment { id: string; target: 'GLOBAL' | 'DOMAIN' | 'USER'; targetId: string; label?: string }
interface AssignTargets { domains: { id: string; name: string }[]; users: { id: string; email: string; displayName: string | null }[] }

// ─── Assignments (GLOBAL / DOMAIN / USER) ─────────────────────────────────────
function AssignmentsModal({ policy, onClose }: { policy: RetentionPolicy; onClose: () => void }) {
  const qc = useQueryClient();
  const titleId = useId();
  const [target, setTarget] = useState<'GLOBAL' | 'DOMAIN' | 'USER'>('DOMAIN');
  const [targetId, setTargetId] = useState('');
  const [q, setQ] = useState('');

  const { data: list = [], isLoading } = useQuery<PolicyAssignment[]>({
    queryKey: ['admin-retention-assignments', policy.id],
    queryFn:  () => api.get(`/admin/compliance/retention/${policy.id}/assignments`),
  });
  const { data: targets } = useQuery<AssignTargets>({
    queryKey: ['admin-retention-targets', q],
    queryFn:  () => api.get(`/admin/compliance/retention/targets?q=${encodeURIComponent(q)}`),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-retention-assignments', policy.id] });
    void qc.invalidateQueries({ queryKey: ['admin-retention'] });
  };
  const add = useMutation({
    mutationFn: () => api.post(`/admin/compliance/retention/${policy.id}/assignments`, { target, targetId: target === 'GLOBAL' ? '' : targetId }),
    onSuccess: () => { refresh(); setTargetId(''); toast.success('Zuweisung hinzugefügt'); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (aid: string) => api.delete(`/admin/compliance/retention/${policy.id}/assignments/${aid}`),
    onSuccess: () => { refresh(); toast.success('Zuweisung entfernt'); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      overlayClassName="fixed inset-0 bg-scrim/40 flex items-center justify-center z-50 p-4"
      className="bg-surface rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
    >
      <div className="px-6 py-4 border-b border-line flex items-center justify-between shrink-0">
        <h2 id={titleId} className="text-base font-semibold text-fg">Zuweisungen: {policy.name}</h2>
        <button type="button" onClick={onClose} aria-label="Schließen" className="text-fg-subtle hover:text-fg-muted"><X size={18} /></button>
      </div>
      <div className="px-6 py-4 space-y-4 overflow-y-auto">
        <p className="text-xs text-fg-subtle">Die Richtlinie gilt für alle zugewiesenen Postfächer. Ein Postfach mit mehreren Richtlinien erhält die Tags aller Richtlinien.</p>
        {isLoading ? (
          <p className="text-sm text-fg-subtle">Laden…</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-warning-fg">Keine Zuweisung — die Richtlinie wird auf kein Postfach angewendet.</p>
        ) : (
          <ul className="divide-y divide-line border border-line rounded">
            {list.map((a) => (
              <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                {a.target === 'GLOBAL' ? <Globe size={13} className="text-fg-subtle" /> : a.target === 'USER' ? <UserIcon size={13} className="text-fg-subtle" /> : <FolderIcon size={13} className="text-fg-subtle" />}
                <span className="text-xs text-fg-subtle w-16">{a.target === 'GLOBAL' ? 'Global' : a.target === 'DOMAIN' ? 'Domain' : 'Benutzer'}</span>
                <span className="flex-1 text-fg truncate">{a.label ?? (a.targetId || 'Alle Postfächer')}</span>
                <button aria-label="Zuweisung entfernen" onClick={() => remove.mutate(a.id)} disabled={remove.isPending}
                  className="p-1 text-fg-subtle hover:text-danger-fg disabled:opacity-40"><Trash2 size={13} /></button>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-line pt-4 space-y-2">
          <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide">Neue Zuweisung</p>
          <div className="flex gap-2">
            {(['GLOBAL', 'DOMAIN', 'USER'] as const).map((t) => (
              <button key={t} type="button" onClick={() => { setTarget(t); setTargetId(''); }}
                className={`px-3 py-1.5 text-xs rounded border ${target === t ? 'border-accent-fg text-accent-fg bg-accent/10' : 'border-line-strong text-fg-muted hover:bg-surface-2'}`}>
                {t === 'GLOBAL' ? 'Alle Postfächer' : t === 'DOMAIN' ? 'Domain' : 'Benutzer'}
              </button>
            ))}
          </div>
          {target === 'DOMAIN' && (
            <select aria-label="Domain" value={targetId} onChange={(e) => setTargetId(e.target.value)}
              className="w-full border border-line-strong rounded px-3 py-1.5 text-sm">
              <option value="">Domain wählen…</option>
              {(targets?.domains ?? []).map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
          )}
          {target === 'USER' && (
            <>
              <input aria-label="Benutzer suchen" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Benutzer suchen…"
                className="w-full border border-line-strong rounded px-3 py-1.5 text-sm" />
              <select aria-label="Benutzer" value={targetId} onChange={(e) => setTargetId(e.target.value)}
                className="w-full border border-line-strong rounded px-3 py-1.5 text-sm">
                <option value="">Benutzer wählen…</option>
                {(targets?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.displayName ? `${u.displayName} — ${u.email}` : u.email}</option>)}
              </select>
            </>
          )}
          <div className="flex justify-end">
            <button onClick={() => add.mutate()} disabled={add.isPending || (target !== 'GLOBAL' && !targetId)}
              className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
              <Plus size={14} /> Zuweisen
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─── Labels ──────────────────────────────────────────────────────────────────

const TAG_TYPE_LABELS: Record<TagType, string> = {
  DPT: 'Default Policy Tag', RPT: 'Retention Policy Tag', PERSONAL: 'Personal Tag',
};
const TAG_TYPE_COLORS: Record<TagType, string> = {
  DPT: 'bg-info-bg text-info-fg',
  RPT: 'bg-info-bg text-info-fg',
  PERSONAL: 'bg-warning-bg text-warning-fg',
};
const TAG_ACTION_LABELS: Record<TagAction, string> = {
  MOVE_TO_ARCHIVE: 'In Archiv verschieben',
  DELETE_AND_ALLOW_RECOVERY: 'Löschen (wiederherstellbar)',
  PERMANENTLY_DELETE: 'Endgültig löschen',
  MARK_AS_PAST_RETENTION_LIMIT: 'Nur markieren',
};
const FOLDER_TARGET_LABELS: Record<FolderTarget, string> = {
  INBOX: 'Posteingang', SENT_ITEMS: 'Gesendet', DELETED_ITEMS: 'Gelöschte Elemente',
  JUNK_EMAIL: 'Junk-E-Mail', DRAFTS: 'Entwürfe', OUTBOX: 'Postausgang',
  RECOVERABLE_ITEMS: 'Recoverable Items', ARCHIVE: 'Archiv', ALL_OTHER: 'Alle anderen Ordner',
};
const SCOPE_LABELS: Record<RetentionPolicy['scope'], string> = {
  ALL_ITEMS: 'Alle Elemente', INBOX: 'Posteingang', SENT_ITEMS: 'Gesendet',
  DELETED_ITEMS: 'Gelöschte Elemente', JUNK: 'Junk-E-Mail',
};
const LEGACY_ACTION_LABELS: Record<RetentionPolicy['action'], string> = {
  ARCHIVE: 'Archivieren', DELETE: 'Löschen', MOVE_TO_FOLDER: 'In Ordner verschieben',
};
const LEGACY_ACTION_COLORS: Record<RetentionPolicy['action'], string> = {
  ARCHIVE: 'bg-info-bg text-info-fg', DELETE: 'bg-danger-bg text-danger-fg', MOVE_TO_FOLDER: 'bg-warning-bg text-warning-fg',
};

function daysLabel(d: number): string {
  if (d <= 0) return '—';
  if (d % 365 === 0) return `${d / 365} Jahr${d / 365 !== 1 ? 'e' : ''}`;
  if (d % 30 === 0) return `${d / 30} Monat${d / 30 !== 1 ? 'e' : ''}`;
  return `${d} Tag${d !== 1 ? 'e' : ''}`;
}

// ─── Templates (typical retention scenarios) ─────────────────
// Each template consists of: a tag + a policy (bundling that tag)
// + GLOBAL assignment to all mailboxes. Created atomically with one click via
// frontend orchestration.

interface RetentionTemplate {
  id:          string;
  icon:        React.ElementType;
  iconClass:   string;
  name:        string;
  description: string;
  policyName:  string;
  tag: {
    name:          string;
    description:   string;
    type:          TagType;
    action:        TagAction;
    retentionDays: number;
    folderTarget:  FolderTarget;
  };
}

const RETENTION_TEMPLATES: RetentionTemplate[] = [
  {
    id: 'trash-30d',
    icon: Trash2, iconClass: 'text-danger-fg bg-danger-bg',
    name: 'Papierkorb nach 30 Tagen leeren',
    description: 'Verschiebt Items aus „Gelöschte Elemente" nach 30 Tagen in Recoverable Items.',
    policyName: 'Standard — Papierkorb 30 Tage',
    tag: {
      name: 'Auto-Cleanup Papierkorb (30 Tage)',
      description: 'RPT für Gelöschte Elemente',
      type: 'RPT', action: 'DELETE_AND_ALLOW_RECOVERY',
      retentionDays: 30, folderTarget: 'DELETED_ITEMS',
    },
  },
  {
    id: 'junk-14d',
    icon: ShieldCheck, iconClass: 'text-warning-fg bg-warning-bg',
    name: 'Junk nach 14 Tagen endgültig löschen',
    description: 'Spam wird nach 14 Tagen direkt in Purges verschoben — Speicherplatz frei.',
    policyName: 'Standard — Junk 14 Tage',
    tag: {
      name: 'Auto-Purge Junk (14 Tage)',
      description: 'RPT für Junk-E-Mail',
      type: 'RPT', action: 'PERMANENTLY_DELETE',
      retentionDays: 14, folderTarget: 'JUNK_EMAIL',
    },
  },
  {
    id: 'inbox-archive-1y',
    icon: Inbox, iconClass: 'text-info-fg bg-info-bg',
    name: 'Posteingang nach 1 Jahr archivieren',
    description: 'Mails im Posteingang werden nach 365 Tagen ins Archiv-Postfach verschoben.',
    policyName: 'Standard — Posteingang 1 Jahr → Archiv',
    tag: {
      name: 'Posteingang 1 Jahr → Archiv',
      description: 'RPT für Inbox',
      type: 'RPT', action: 'MOVE_TO_ARCHIVE',
      retentionDays: 365, folderTarget: 'INBOX',
    },
  },
  {
    id: 'sent-archive-2y',
    icon: Send, iconClass: 'text-info-fg bg-info-bg',
    name: 'Gesendet nach 2 Jahren archivieren',
    description: 'Items aus „Gesendet" werden nach 2 Jahren ins Archiv-Postfach verschoben.',
    policyName: 'Standard — Gesendet 2 Jahre → Archiv',
    tag: {
      name: 'Gesendet 2 Jahre → Archiv',
      description: 'RPT für Sent Items',
      type: 'RPT', action: 'MOVE_TO_ARCHIVE',
      retentionDays: 730, folderTarget: 'SENT_ITEMS',
    },
  },
  {
    id: 'drafts-90d',
    icon: FileText, iconClass: 'text-fg-muted bg-surface-2',
    name: 'Entwürfe nach 90 Tagen löschen',
    description: 'Nicht-abgesendete Entwürfe werden nach 90 Tagen in Deletions verschoben.',
    policyName: 'Standard — Entwürfe 90 Tage',
    tag: {
      name: 'Entwürfe-Cleanup 90 Tage',
      description: 'RPT für Drafts',
      type: 'RPT', action: 'DELETE_AND_ALLOW_RECOVERY',
      retentionDays: 90, folderTarget: 'DRAFTS',
    },
  },
  {
    id: 'dpt-7y-compliance',
    icon: Clock, iconClass: 'text-info-fg bg-info-bg',
    name: 'Compliance: 7 Jahre Aufbewahrung (Markierung)',
    description: 'DPT — markiert alle Items nach 7 Jahren als „über Aufbewahrungsfrist" (keine Bewegung).',
    policyName: 'Compliance — 7 Jahre Aufbewahrung',
    tag: {
      name: 'Compliance 7 Jahre',
      description: 'DPT für alle Items',
      type: 'DPT', action: 'MARK_AS_PAST_RETENTION_LIMIT',
      retentionDays: 2555, folderTarget: 'ALL_OTHER',
    },
  },
  {
    id: 'dpt-3y-archive',
    icon: Archive, iconClass: 'text-success-fg bg-success-bg',
    name: 'Standard 3 Jahre → Archiv (alle Items)',
    description: 'DPT — verschiebt alle Items nach 3 Jahren ins Archiv-Postfach.',
    policyName: 'Standard — Alle Items 3 Jahre → Archiv',
    tag: {
      name: 'Mailbox-Default 3 Jahre → Archiv',
      description: 'DPT für alle Items',
      type: 'DPT', action: 'MOVE_TO_ARCHIVE',
      retentionDays: 1095, folderTarget: 'ALL_OTHER',
    },
  },
  {
    id: 'dpt-5y-delete',
    icon: MailIcon, iconClass: 'text-danger-fg bg-danger-bg',
    name: '5 Jahre wiederherstellbar löschen',
    description: 'DPT — alle Items nach 5 Jahren in Recoverable Items\\Deletions. Compliance-tauglich.',
    policyName: 'Standard — Alle Items 5 Jahre löschen',
    tag: {
      name: 'Mailbox-Default 5 Jahre Delete',
      description: 'DPT für alle Items',
      type: 'DPT', action: 'DELETE_AND_ALLOW_RECOVERY',
      retentionDays: 1825, folderTarget: 'ALL_OTHER',
    },
  },
];

// ─── Template Picker ──────────────────────────────────────────────────────────
function TemplatePickerModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function applyTemplate(tpl: RetentionTemplate) {
    setBusyId(tpl.id);
    // 9.1.x: created objects are removed again when a later step fails (no half-applied template)
    let createdTagId: string | null = null;
    let createdPolicyId: string | null = null;
    try {
      // 1. Create tag
      const tag = await api.post<{ id: string }>('/admin/compliance/retention/tags', {
        ...tpl.tag,
        enabled: true,
      });
      createdTagId = tag.id;
      // 2. Create policy (legacy fields empty, tags control everything)
      const policy = await api.post<{ id: string }>('/admin/compliance/retention', {
        name: tpl.policyName,
        description: tpl.description,
        enabled: true,
        retentionDays: 0,
        action: 'ARCHIVE',
        scope: 'ALL_ITEMS',
      });
      createdPolicyId = policy.id;
      // 3. Attach tag to policy
      await api.post(`/admin/compliance/retention/${policy.id}/tags/${tag.id}`, {});
      // 4. GLOBAL assignment to all mailboxes
      await api.post(`/admin/compliance/retention/${policy.id}/assignments`, {
        target: 'GLOBAL', targetId: '',
      });

      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      void qc.invalidateQueries({ queryKey: ['admin-retention-tags'] });
      toast.success(`Vorlage „${tpl.name}" angewendet — Richtlinie + Tag + Zuweisung erstellt.`);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (createdPolicyId) await api.delete(`/admin/compliance/retention/${createdPolicyId}`).catch(() => undefined);
      if (createdTagId) await api.delete(`/admin/compliance/retention/tags/${createdTagId}`).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      void qc.invalidateQueries({ queryKey: ['admin-retention-tags'] });
      toast.error(`Konnte Vorlage nicht anwenden: ${msg}`);
      setBusyId(null);
    }
  }

  const titleId = useId();
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}

      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
      className="bg-surface rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div>
            <h2 id={titleId} className="font-semibold text-fg flex items-center gap-2">
              <Sparkles size={17} className="text-accent-fg" /> Aufbewahrungsrichtlinie aus Vorlage
            </h2>
            <p className="text-xs text-fg-subtle mt-0.5">
              Wähle eine Vorlage — Tag + Richtlinie + Zuweisung auf alle Postfächer werden in einem Schritt erstellt.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Schließen" className="text-fg-subtle hover:text-fg-muted"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {RETENTION_TEMPLATES.map((t) => {
              const Icon = t.icon;
              const isBusy = busyId === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => applyTemplate(t)}
                  className="text-left p-3 border border-line rounded-lg hover:border-accent-fg hover:bg-accent/5 transition-colors group disabled:opacity-50"
                >
                  <div className="flex items-start gap-2.5">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${t.iconClass}`}>
                      <Icon size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-fg mb-0.5 group-hover:text-accent-fg">{t.name}</p>
                      <p className="text-xs text-fg-muted leading-relaxed mb-1.5">{t.description}</p>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${TAG_TYPE_COLORS[t.tag.type]}`}>{t.tag.type}</span>
                        <span className="text-[10px] text-fg-subtle">
                          {TAG_ACTION_LABELS[t.tag.action]} · nach {daysLabel(t.tag.retentionDays)}
                        </span>
                      </div>
                    </div>
                    {isBusy && <div className="text-xs text-fg-subtle">Erstelle…</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-line flex items-center justify-between shrink-0">
          <p className="text-xs text-fg-subtle">
            Du kannst die erstellte Richtlinie danach beliebig anpassen.
          </p>
          <button onClick={onClose}
            className="px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded hover:bg-surface-2">
            Schließen
          </button>
        </div>
    </Modal>
  );
}

// ─── Tag Modal ────────────────────────────────────────────────────────────────

function TagModal({ tag, onClose }: { tag: RetentionTag | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = tag !== null;
  const [form, setForm] = useState({
    name:          tag?.name ?? '',
    description:   tag?.description ?? '',
    type:          tag?.type ?? 'DPT' as TagType,
    action:        tag?.action ?? 'DELETE_AND_ALLOW_RECOVERY' as TagAction,
    retentionDays: tag?.retentionDays?.toString() ?? '365',
    folderTarget:  tag?.folderTarget ?? 'INBOX' as FolderTarget,
    enabled:       tag?.enabled ?? true,
  });

  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name:          form.name,
        description:   form.description,
        type:          form.type,
        action:        form.action,
        retentionDays: parseRetentionDays(form.retentionDays) ?? 0,
        enabled:       form.enabled,
        ...(form.type === 'RPT' ? { folderTarget: form.folderTarget } : {}),
        ...(form.type === 'DPT' ? { folderTarget: 'ALL_OTHER' } : {}),
      };
      return isEdit
        ? api.put(`/admin/compliance/retention/tags/${tag.id}`, body)
        : api.post('/admin/compliance/retention/tags', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-retention-tags'] });
      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      toast.success(isEdit ? 'Tag aktualisiert' : 'Tag erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const titleId = useId();
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}

      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 bg-scrim/40 flex items-center justify-center z-50 p-4"
      className="bg-surface rounded-lg shadow-xl w-full max-w-lg"
    >
        <div className="px-6 py-4 border-b border-line flex items-center justify-between">
          <h2 id={titleId} className="text-base font-semibold text-fg">{isEdit ? 'Tag bearbeiten' : 'Neuer Retention Tag'}</h2>
          <button type="button" onClick={onClose} aria-label="Schließen" className="text-fg-subtle hover:text-fg-muted"><X size={18} /></button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Name *</label>
            <input value={form.name} onChange={(e) => set('name', e.target.value)}
              className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg"
              placeholder="z.B. Default 1 Year Move to Archive" />
          </div>

          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Typ *</label>
            <div className="grid grid-cols-3 gap-2">
              {(['DPT', 'RPT', 'PERSONAL'] as const).map((t) => (
                <button key={t} type="button" onClick={() => set('type', t)}
                  className={`px-3 py-2 text-sm rounded border ${
                    form.type === t ? 'bg-accent/10 border-accent-fg text-accent-fg font-medium' : 'bg-surface border-line-strong text-fg-muted hover:bg-surface-2'
                  }`}>
                  <p className="text-xs font-semibold">{t}</p>
                  <p className="text-[10px] text-fg-subtle mt-0.5">{TAG_TYPE_LABELS[t]}</p>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-fg-subtle mt-1">
              {form.type === 'DPT' && 'Gilt fürs ganze Postfach — wenn kein spezifischeres Tag passt'}
              {form.type === 'RPT' && 'Bindet an einen Standardordner (Inbox, Sent, …)'}
              {form.type === 'PERSONAL' && 'User kann ihn manuell auf Items/Ordner anwenden'}
            </p>
          </div>

          {form.type === 'RPT' && (
            <div>
              <label className="block text-xs font-medium text-fg-muted mb-1">Standardordner *</label>
              <select value={form.folderTarget} onChange={(e) => set('folderTarget', e.target.value as FolderTarget)}
                className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg">
                {(['INBOX', 'SENT_ITEMS', 'DELETED_ITEMS', 'JUNK_EMAIL', 'DRAFTS', 'OUTBOX', 'ARCHIVE', 'RECOVERABLE_ITEMS'] as FolderTarget[]).map((t) => (
                  <option key={t} value={t}>{FOLDER_TARGET_LABELS[t]}</option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-fg-muted mb-1">Aufbewahrungsdauer (Tage)</label>
              <input type="number" min="1" value={form.retentionDays}
                onChange={(e) => set('retentionDays', e.target.value)}
                className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg" />
              <p className="text-[11px] text-fg-subtle mt-0.5">{daysLabel(parseInt(form.retentionDays) || 0)}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-fg-muted mb-1">Aktion *</label>
              <select value={form.action} onChange={(e) => set('action', e.target.value as TagAction)}
                className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg">
                {(Object.entries(TAG_ACTION_LABELS) as [TagAction, string][]).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Beschreibung</label>
            <textarea value={form.description} onChange={(e) => set('description', e.target.value)}
              rows={2} className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg resize-none" />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} className="accent-accent" />
            <span className="text-sm text-fg-muted">Aktiviert</span>
          </label>
        </div>
        <div className="px-6 py-4 border-t border-line flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-fg-muted border border-line-strong rounded hover:bg-surface-2">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim() || parseRetentionDays(form.retentionDays) === null}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
    </Modal>
  );
}

// ─── Policy modal with tag picker ─────────────────────────────────────────────

function PolicyModal({ policy, allTags, onClose }: { policy: RetentionPolicy | null; allTags: RetentionTag[]; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = policy !== null;
  const [form, setForm] = useState({
    name:             policy?.name ?? '',
    description:      policy?.description ?? '',
    enabled:          policy?.enabled ?? true,
  });
  const [selectedTags, setSelectedTags] = useState<Set<string>>(
    new Set((policy?.policyTags ?? []).map((pt) => pt.tagId)),
  );

  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleTag = (id: string) => {
    const next = new Set(selectedTags);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedTags(next);
  };

  // DPT validation: at most 1 DPT
  const dptCount = [...selectedTags].filter((id) => allTags.find((t) => t.id === id)?.type === 'DPT').length;

  const save = useMutation({
    mutationFn: async () => {
      // New policies are tag-based; editing keeps the stored legacy fields (lib/retention.ts)
      const body = policyBody(form, isEdit);
      const saved = isEdit
        ? await api.put<RetentionPolicy>(`/admin/compliance/retention/${policy.id}`, body)
        : await api.post<RetentionPolicy>('/admin/compliance/retention', body);

      // Reconcile tags — detach first, then attach (a DPT swap must not hit "already has a DPT")
      const { toRemove, toAdd } = tagChangePlan((policy?.policyTags ?? []).map((pt) => pt.tagId), selectedTags);
      for (const tagId of toRemove) await api.delete(`/admin/compliance/retention/${saved.id}/tags/${tagId}`);
      for (const tagId of toAdd) await api.post(`/admin/compliance/retention/${saved.id}/tags/${tagId}`, {});
      return saved;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      void qc.invalidateQueries({ queryKey: ['admin-retention-tags'] });
      toast.success(isEdit ? 'Richtlinie aktualisiert' : 'Richtlinie erstellt');
      onClose();
    },
    onError: (e: Error) => {
      // the policy itself may already be saved — show the current state
      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      toast.error(e.message);
    },
  });

  const tagsByType = {
    DPT:      allTags.filter((t) => t.type === 'DPT'),
    RPT:      allTags.filter((t) => t.type === 'RPT'),
    PERSONAL: allTags.filter((t) => t.type === 'PERSONAL'),
  };

  const titleId = useId();
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}

      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 bg-scrim/40 flex items-center justify-center z-50 p-4"
      className="bg-surface rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
    >
        <div className="px-6 py-4 border-b border-line flex items-center justify-between shrink-0">
          <h2 id={titleId} className="text-base font-semibold text-fg">{isEdit ? 'Richtlinie bearbeiten' : 'Neue Aufbewahrungsrichtlinie'}</h2>
          <button type="button" onClick={onClose} aria-label="Schließen" className="text-fg-subtle hover:text-fg-muted"><X size={18} /></button>
        </div>

        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Name *</label>
            <input value={form.name} onChange={(e) => set('name', e.target.value)}
              className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg"
              placeholder="z.B. Standard Mitarbeiter" />
          </div>

          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Beschreibung</label>
            <textarea value={form.description} onChange={(e) => set('description', e.target.value)}
              rows={2} className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg resize-none" />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} className="accent-accent" />
            <span className="text-sm text-fg-muted">Aktiviert</span>
          </label>

          <div className="border-t border-line pt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide">Retention Tags zuweisen</p>
              <span className="text-[11px] text-fg-subtle">{selectedTags.size} ausgewählt</span>
            </div>
            {dptCount > 1 && (
              <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-warning-bg border border-warning-line rounded text-xs text-warning-fg">
                <AlertCircle size={13} /> Eine Policy darf nur einen DPT haben — bitte nur einen markieren.
              </div>
            )}

            {(['DPT', 'RPT', 'PERSONAL'] as TagType[]).map((tt) => (
              <div key={tt} className="mb-3">
                <p className="text-[11px] font-medium text-fg-subtle uppercase tracking-wider mb-1.5">
                  {TAG_TYPE_LABELS[tt]} {tt === 'DPT' && <span className="text-warning-fg">(max. 1)</span>}
                </p>
                {tagsByType[tt].length === 0 ? (
                  <p className="text-xs text-fg-subtle italic">Keine {tt}-Tags vorhanden</p>
                ) : (
                  <div className="space-y-1">
                    {tagsByType[tt].map((t) => (
                      <label key={t.id} className="flex items-center gap-3 px-3 py-1.5 hover:bg-surface-2 rounded cursor-pointer">
                        <input type="checkbox" checked={selectedTags.has(t.id)} onChange={() => toggleTag(t.id)}
                          className="h-4 w-4 rounded border-line-strong text-accent-fg focus:ring-accent-fg" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-fg">{t.name}</p>
                          <p className="text-[11px] text-fg-subtle">
                            {TAG_ACTION_LABELS[t.action]} · nach {daysLabel(t.retentionDays)}
                            {t.folderTarget && t.type === 'RPT' ? ` · Ordner: ${FOLDER_TARGET_LABELS[t.folderTarget]}` : ''}
                          </p>
                        </div>
                        {!t.enabled && <span className="text-[10px] bg-surface-3 text-fg-muted rounded px-1.5">deaktiviert</span>}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-line flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-fg-muted border border-line-strong rounded hover:bg-surface-2">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim() || dptCount > 1}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
    </Modal>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function RetentionPage() {
  const t = useT();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'policies' | 'tags'>('policies');
  const [policyModal, setPolicyModal] = useState<'create' | RetentionPolicy | null>(null);
  const [tagModal, setTagModal] = useState<'create' | RetentionTag | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [deletePolicyConfirm, setDeletePolicyConfirm] = useState<RetentionPolicy | null>(null);
  const [deleteTagConfirm, setDeleteTagConfirm] = useState<RetentionTag | null>(null);
  const [assignPolicy, setAssignPolicy] = useState<RetentionPolicy | null>(null);

  const { data: runs = [] } = useQuery<ManagedFolderRun[]>({
    queryKey: ['admin-retention-runs'],
    queryFn:  () => api.get('/admin/compliance/retention/runs'),
  });
  const lastRun = runs[0];

  const runNow = useMutation({
    mutationFn: () => api.post<{ itemsScanned?: number; itemsArchived?: number; itemsSoftDeleted?: number; itemsHardDeleted?: number; errors?: string[] }>('/admin/compliance/retention/run', {}),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['admin-retention-runs'] });
      toast.success(`Lauf beendet: ${r.itemsScanned ?? 0} geprüft · ${r.itemsArchived ?? 0} archiviert · ${(r.itemsSoftDeleted ?? 0) + (r.itemsHardDeleted ?? 0)} gelöscht${r.errors?.length ? ` · ${r.errors.length} Fehler` : ''}`);
    },
    onError: (e) => { void qc.invalidateQueries({ queryKey: ['admin-retention-runs'] }); toast.error(`Lauf fehlgeschlagen: ${errorMessage(e)}`); },
  });

  const { data: policies = [], isLoading: loadingPolicies } = useQuery<RetentionPolicy[]>({
    queryKey: ['admin-retention'],
    queryFn:  () => api.get('/admin/compliance/retention'),
  });

  const { data: tags = [], isLoading: loadingTags } = useQuery<RetentionTag[]>({
    queryKey: ['admin-retention-tags'],
    queryFn:  () => api.get('/admin/compliance/retention/tags'),
  });

  const toggle = useMutation({
    mutationFn: (p: RetentionPolicy) => api.post(`/admin/compliance/retention/${p.id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-retention'] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const deletePolicy = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/compliance/retention/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      toast.success('Richtlinie gelöscht');
      setDeletePolicyConfirm(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteTag = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/compliance/retention/tags/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-retention-tags'] });
      void qc.invalidateQueries({ queryKey: ['admin-retention'] });
      toast.success('Tag gelöscht');
      setDeleteTagConfirm(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Archive size={22} className="text-accent-fg" />
          <div>
            <h1 className="text-xl font-semibold text-fg">{t('page_retention')}</h1>
            <p className="text-sm text-fg-subtle">
              Definiere, wann E-Mails automatisch archiviert oder gelöscht werden — per Vorlage oder eigener Regel.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => runNow.mutate()} disabled={runNow.isPending}
            title="Wendet alle aktiven Richtlinien jetzt an (sonst automatisch einmal täglich)"
            className="flex items-center gap-1.5 px-4 py-2 text-sm border border-line-strong rounded-lg hover:bg-surface-2 disabled:opacity-50">
            {runNow.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Jetzt anwenden
          </button>
          {tab === 'policies' && (
            <button onClick={() => setTemplatePickerOpen(true)}
              className="flex items-center gap-1.5 px-4 py-2 text-info-fg bg-info-bg border border-info-line text-sm font-medium rounded-lg hover:bg-info-bg transition-colors">
              <Sparkles size={14} /> Aus Vorlage
            </button>
          )}
          <button onClick={() => tab === 'policies' ? setPolicyModal('create') : setTagModal('create')}
            className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90">
            <Plus size={15} /> {tab === 'policies' ? 'Neue Richtlinie' : 'Neuer Tag'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-line mb-4">
        <button onClick={() => setTab('policies')}
          className={`px-4 py-2 text-sm font-medium border-b-2 flex items-center gap-1.5 ${
            tab === 'policies' ? 'border-accent-fg text-accent-fg' : 'border-transparent text-fg-subtle hover:text-fg-muted'
          }`}>
          <ListChecks size={13} /> Richtlinien ({policies.length})
        </button>
        <button onClick={() => setTab('tags')}
          className={`px-4 py-2 text-sm font-medium border-b-2 flex items-center gap-1.5 ${
            tab === 'tags' ? 'border-accent-fg text-accent-fg' : 'border-transparent text-fg-subtle hover:text-fg-muted'
          }`}>
          <Tag size={13} /> Tags ({tags.length})
        </button>
      </div>

      {lastRun && (
        <p className="text-xs text-fg-subtle mb-3">
          Letzter Lauf: {new Date(lastRun.startedAt).toLocaleString('de-DE')}
          {lastRun.completedAt
            ? ` · ${lastRun.mailboxesScanned} Postfächer · ${lastRun.itemsScanned} Elemente · ${lastRun.itemsArchived} archiviert · ${lastRun.itemsSoftDeleted + lastRun.itemsHardDeleted} gelöscht${lastRun.throttled ? ' · Zeitlimit erreicht' : ''}`
            : ' · läuft oder abgebrochen'}
          {lastRun.errorMessage && <span className="text-danger-fg"> · {lastRun.errorMessage}</span>}
        </p>
      )}

      {/* Policies */}
      {tab === 'policies' && (
        <div className="bg-surface rounded-lg border border-line overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-2 border-b border-line text-xs font-semibold text-fg-subtle uppercase tracking-wide">
                <th className="text-left px-4 py-3">Richtlinie</th>
                <th className="text-left px-4 py-3">Tags</th>
                <th className="text-left px-4 py-3">Zuweisungen</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loadingPolicies ? (
                <tr><td colSpan={5} className="text-center py-12 text-fg-subtle">Laden…</td></tr>
              ) : policies.length === 0 ? (
                <tr><td colSpan={5} className="text-center py-12 text-fg-subtle">Noch keine Richtlinien konfiguriert</td></tr>
              ) : policies.map((p) => (
                <tr key={p.id} className="border-b border-line hover:bg-surface-2">
                  <td className="px-4 py-3">
                    <p className="font-medium text-fg">{p.name}</p>
                    {p.description && <p className="text-xs text-fg-subtle">{p.description}</p>}
                  </td>
                  <td className="px-4 py-3">
                    {p.policyTags && p.policyTags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {p.policyTags.map((pt) => (
                          <span key={pt.tagId} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${TAG_TYPE_COLORS[pt.tag.type]}`}>
                            <span className="font-semibold">{pt.tag.type}</span> {pt.tag.name}
                          </span>
                        ))}
                      </div>
                    ) : p.retentionDays > 0 ? (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] ${LEGACY_ACTION_COLORS[p.action]}`}>
                        Legacy: {LEGACY_ACTION_LABELS[p.action]} nach {daysLabel(p.retentionDays)} ({SCOPE_LABELS[p.scope]})
                      </span>
                    ) : (
                      <span className="text-xs text-fg-subtle italic">keine Tags</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-fg-muted">
                    <button onClick={() => setAssignPolicy(p)} className="text-accent-fg hover:underline" title="Zuweisungen verwalten">
                      {p._count?.assignments ?? 0} {(p._count?.assignments ?? 0) === 0 ? '— zuweisen' : 'verwalten'}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => toggle.mutate(p)} disabled={toggle.isPending} title={p.enabled ? 'Deaktivieren' : 'Aktivieren'}>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        p.enabled ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-fg-subtle'
                      }`}>
                        {p.enabled ? 'Aktiv' : 'Deaktiviert'}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button aria-label="Bearbeiten" onClick={() => setPolicyModal(p)}
                        className="p-1.5 text-fg-subtle hover:text-accent-fg hover:bg-accent/10 rounded"><Pencil size={13} /></button>
                      <button aria-label="Löschen" onClick={() => setDeletePolicyConfirm(p)}
                        className="p-1.5 text-fg-subtle hover:text-danger-fg hover:bg-danger-bg rounded"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tags */}
      {tab === 'tags' && (
        <div className="bg-surface rounded-lg border border-line overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-2 border-b border-line text-xs font-semibold text-fg-subtle uppercase tracking-wide">
                <th className="text-left px-4 py-3">Tag</th>
                <th className="text-left px-4 py-3">Typ</th>
                <th className="text-left px-4 py-3">Aktion</th>
                <th className="text-left px-4 py-3">Frist</th>
                <th className="text-left px-4 py-3">Ordner / Scope</th>
                <th className="text-left px-4 py-3">Verwendet in</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loadingTags ? (
                <tr><td colSpan={8} className="text-center py-12 text-fg-subtle">Laden…</td></tr>
              ) : tags.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12 text-fg-subtle">Noch keine Tags konfiguriert</td></tr>
              ) : tags.map((t) => (
                <tr key={t.id} className="border-b border-line hover:bg-surface-2">
                  <td className="px-4 py-3">
                    <p className="font-medium text-fg">{t.name}</p>
                    {t.description && <p className="text-xs text-fg-subtle">{t.description}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${TAG_TYPE_COLORS[t.type]}`}>{t.type}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-fg-muted">{TAG_ACTION_LABELS[t.action]}</td>
                  <td className="px-4 py-3 text-xs text-fg-muted font-medium">{daysLabel(t.retentionDays)}</td>
                  <td className="px-4 py-3 text-xs text-fg-muted">
                    {t.folderTarget ? <span className="inline-flex items-center gap-1"><FolderIcon size={11} /> {FOLDER_TARGET_LABELS[t.folderTarget]}</span> : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-fg-muted">
                    {t._count?.policyTags ?? 0} Policies
                    {t._count && t._count.messages > 0 ? <span className="text-fg-subtle"> · {t._count.messages} Mails</span> : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      t.enabled ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-fg-subtle'
                    }`}>
                      {t.enabled ? 'Aktiv' : 'Deaktiviert'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {!t.isSystem && (
                        <>
                          <button aria-label="Bearbeiten" onClick={() => setTagModal(t)}
                            className="p-1.5 text-fg-subtle hover:text-accent-fg hover:bg-accent/10 rounded"><Pencil size={13} /></button>
                          <button aria-label="Löschen" onClick={() => setDeleteTagConfirm(t)}
                            className="p-1.5 text-fg-subtle hover:text-danger-fg hover:bg-danger-bg rounded"><Trash2 size={13} /></button>
                        </>
                      )}
                      {t.isSystem && (
                        <span className="text-[10px] text-fg-subtle italic">System</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {policyModal !== null && <PolicyModal policy={policyModal === 'create' ? null : policyModal} allTags={tags} onClose={() => setPolicyModal(null)} />}
      {tagModal !== null && <TagModal tag={tagModal === 'create' ? null : tagModal} onClose={() => setTagModal(null)} />}
      {templatePickerOpen && <TemplatePickerModal onClose={() => setTemplatePickerOpen(false)} />}
      {assignPolicy && <AssignmentsModal policy={assignPolicy} onClose={() => setAssignPolicy(null)} />}

      {deletePolicyConfirm && (
        <Modal
          onClose={() => setDeletePolicyConfirm(null)}
          label="Richtlinie löschen"
          overlayClassName="fixed inset-0 bg-scrim/40 flex items-center justify-center z-50 p-4"
          className="bg-surface rounded-lg shadow-xl w-full max-w-sm p-6"
        >
            <h2 className="text-base font-semibold text-fg mb-2">Richtlinie löschen</h2>
            <p className="text-sm text-fg-muted mb-4">Soll <strong>{deletePolicyConfirm.name}</strong> wirklich gelöscht werden?</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeletePolicyConfirm(null)} className="px-4 py-2 text-sm border border-line-strong rounded hover:bg-surface-2">Abbrechen</button>
              <button onClick={() => deletePolicy.mutate(deletePolicyConfirm.id)} disabled={deletePolicy.isPending}
                className="px-4 py-2 text-sm text-white bg-danger rounded hover:bg-danger/90 disabled:opacity-50">
                {deletePolicy.isPending ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
        </Modal>
      )}

      {deleteTagConfirm && (
        <Modal
          onClose={() => setDeleteTagConfirm(null)}
          label="Tag löschen"
          overlayClassName="fixed inset-0 bg-scrim/40 flex items-center justify-center z-50 p-4"
          className="bg-surface rounded-lg shadow-xl w-full max-w-sm p-6"
        >
            <h2 className="text-base font-semibold text-fg mb-2">Tag löschen</h2>
            <p className="text-sm text-fg-muted mb-4">Soll der Tag <strong>{deleteTagConfirm.name}</strong> wirklich gelöscht werden? Er wird auch aus allen Policies entfernt.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTagConfirm(null)} className="px-4 py-2 text-sm border border-line-strong rounded hover:bg-surface-2">Abbrechen</button>
              <button onClick={() => deleteTag.mutate(deleteTagConfirm.id)} disabled={deleteTag.isPending}
                className="px-4 py-2 text-sm text-white bg-danger rounded hover:bg-danger/90 disabled:opacity-50">
                {deleteTag.isPending ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
        </Modal>
      )}
    </div>
  );
}
