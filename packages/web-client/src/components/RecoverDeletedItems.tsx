/**
 * "Recover deleted items" (v8.1): lists items
 * deleted from the mailbox within DELETED_ITEM_RETENTION_DAYS and restores or
 * permanently deletes the selected ones (/api/v1/mail/recoverable).
 * Used inline in Settings and as a dialog from the Trash folder menu.
 * 9.1: `target` = a shared mailbox (FULL_ACCESS) → /api/v1/user/shared-mailboxes/:id/recoverable.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { useT, fmt } from '../i18n/useT.js';
import { Modal } from './Modal.js';
import { recoverableApiBase, recoverableQueryKey, type RecoverTarget } from '../lib/recoverable.js';

interface RecoverableItem {
  id: string;
  kind: 'deleted' | 'retention';
  subject: string;
  fromAddr: string;
  fromName: string;
  date: string;
  deletedAt: string;
  expiresAt: string | null;
  folderName: string;
  folderDisplayName: string;
  rawSize: number;
}
interface RecoverableList { items: RecoverableItem[]; total: number; retentionDays: number }

const fmtDate = (s: string | null): string => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—');

export function RecoverDeletedItemsPanel({ target }: { target?: RecoverTarget } = {}) {
  const t = useT();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const apiBase = recoverableApiBase(target);
  const { data, isLoading } = useQuery({
    queryKey: recoverableQueryKey(target),
    queryFn: () => api.get<RecoverableList>(apiBase),
  });
  const items = data?.items ?? [];

  const done = () => {
    setSelected(new Set());
    void qc.invalidateQueries({ queryKey: recoverableQueryKey(target) });
    // 9.3: every mailbox shares the folder/message query keys (['folders', …], ['messages', folderId])
    void qc.invalidateQueries({ queryKey: ['folders'] });
    void qc.invalidateQueries({ queryKey: ['messages'] });
    if (target?.kind === 'shared') {
      void qc.invalidateQueries({ queryKey: ['shared-mailbox-quota', target.id] });
    } else if (!target || target.kind === 'own') {
      void qc.invalidateQueries({ queryKey: ['user-quota'] });
    }
  };
  const restore = useMutation({
    mutationFn: (ids: string[]) => api.post<{ restored: unknown[] }>(`${apiBase}/restore`, { ids }),
    onSuccess: (r) => { toast.success(fmt(t('recover_restored'), { n: r.restored.length })); done(); },
    onError: () => toast.error('Error'),
  });
  const purge = useMutation({
    mutationFn: (ids: string[]) => api.post<{ purged: number }>(`${apiBase}/purge`, { ids }),
    onSuccess: (r) => { toast.success(fmt(t('recover_purged'), { n: r.purged })); done(); },
    onError: () => toast.error('Error'),
  });

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const ids = [...selected];
  const busy = restore.isPending || purge.isPending;

  if (isLoading) return <div className="flex justify-center py-12 text-fg-subtle"><Loader2 size={18} className="animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-subtle">{fmt(t('recover_hint'), { days: data?.retentionDays ?? 30 })}</p>
      <div className="flex items-center gap-2">
        <button className="btn-primary" disabled={ids.length === 0 || busy} onClick={() => restore.mutate(ids)}>
          <RotateCcw size={14} /> {t('recover_restore')}
        </button>
        <button
          className="px-3 py-1.5 text-sm rounded border border-line-strong text-danger-fg hover:bg-danger-bg disabled:opacity-40"
          disabled={ids.length === 0 || busy}
          onClick={() => { if (window.confirm(t('recover_purge_confirm'))) purge.mutate(ids); }}
        >
          <Trash2 size={14} className="inline mr-1" />{t('recover_purge')}
        </button>
        {busy && <Loader2 size={14} className="animate-spin text-fg-subtle" />}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-fg-subtle py-4">{t('recover_empty')}</p>
      ) : (
        <div className="border border-line rounded-lg overflow-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 border-b border-line sticky top-0">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" aria-label={t('recover_select_all')} checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))} />
                </th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-fg-subtle">Subject</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-fg-subtle">From</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-fg-subtle">{t('recover_deleted_on')}</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-fg-subtle">{t('recover_expires')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((i) => (
                <tr key={i.id} className="hover:bg-surface-2 cursor-pointer" onClick={() => toggle(i.id)}>
                  <td className="px-3 py-2"><input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} onClick={(e) => e.stopPropagation()} aria-label={i.subject || '(no subject)'} /></td>
                  <td className="px-3 py-2 truncate max-w-[16rem]" title={i.subject}>{i.subject || '(no subject)'}</td>
                  <td className="px-3 py-2 truncate max-w-[12rem]" title={i.fromAddr}>{i.fromName || i.fromAddr}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-fg-muted">{fmtDate(i.deletedAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-fg-muted">{fmtDate(i.expiresAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Dialog variant (Trash folder context menu). */
export function RecoverDeletedItemsDialog({ onClose, target, subtitle }: { onClose: () => void; target?: RecoverTarget; subtitle?: string }) {
  const t = useT();
  return (
    <Modal onClose={onClose} label={t('recover_title')} className="bg-surface rounded-lg shadow-2xl w-full max-w-3xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-fg">{t('recover_title')}</h2>
        <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-surface-2"><X size={16} /></button>
      </div>
      {subtitle && <p className="-mt-2 mb-3 text-xs text-fg-subtle truncate">{subtitle}</p>}
      <RecoverDeletedItemsPanel {...(target ? { target } : {})} />
    </Modal>
  );
}
