/**
 * "Recover deleted items" (v8.1, Exchange Recoverable Items): lists items
 * deleted from the mailbox within DELETED_ITEM_RETENTION_DAYS and restores or
 * permanently deletes the selected ones (/api/v1/mail/recoverable).
 * Used inline in Settings and as a dialog from the Trash folder menu.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { useT, fmt } from '../i18n/useT.js';
import { Modal } from './Modal.js';

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

export function RecoverDeletedItemsPanel() {
  const t = useT();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data, isLoading } = useQuery({
    queryKey: ['recoverable'],
    queryFn: () => api.get<RecoverableList>('/mail/recoverable'),
  });
  const items = data?.items ?? [];

  const done = () => {
    setSelected(new Set());
    void qc.invalidateQueries({ queryKey: ['recoverable'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
    void qc.invalidateQueries({ queryKey: ['messages'] });
    void qc.invalidateQueries({ queryKey: ['user-quota'] });
  };
  const restore = useMutation({
    mutationFn: (ids: string[]) => api.post<{ restored: unknown[] }>('/mail/recoverable/restore', { ids }),
    onSuccess: (r) => { toast.success(fmt(t('recover_restored'), { n: r.restored.length })); done(); },
    onError: () => toast.error('Error'),
  });
  const purge = useMutation({
    mutationFn: (ids: string[]) => api.post<{ purged: number }>('/mail/recoverable/purge', { ids }),
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

  if (isLoading) return <div className="flex justify-center py-12 text-gray-400"><Loader2 size={18} className="animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">{fmt(t('recover_hint'), { days: data?.retentionDays ?? 14 })}</p>
      <div className="flex items-center gap-2">
        <button className="btn-primary" disabled={ids.length === 0 || busy} onClick={() => restore.mutate(ids)}>
          <RotateCcw size={14} /> {t('recover_restore')}
        </button>
        <button
          className="px-3 py-1.5 text-sm rounded border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-40"
          disabled={ids.length === 0 || busy}
          onClick={() => { if (window.confirm(t('recover_purge_confirm'))) purge.mutate(ids); }}
        >
          <Trash2 size={14} className="inline mr-1" />{t('recover_purge')}
        </button>
        {busy && <Loader2 size={14} className="animate-spin text-gray-400" />}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400 py-4">{t('recover_empty')}</p>
      ) : (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky top-0">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" aria-label={t('recover_select_all')} checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))} />
                </th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">Subject</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">From</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">{t('recover_deleted_on')}</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">{t('recover_expires')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {items.map((i) => (
                <tr key={i.id} className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer" onClick={() => toggle(i.id)}>
                  <td className="px-3 py-2"><input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} onClick={(e) => e.stopPropagation()} aria-label={i.subject || '(no subject)'} /></td>
                  <td className="px-3 py-2 truncate max-w-[16rem]" title={i.subject}>{i.subject || '(no subject)'}</td>
                  <td className="px-3 py-2 truncate max-w-[12rem]" title={i.fromAddr}>{i.fromName || i.fromAddr}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600 dark:text-gray-400">{fmtDate(i.deletedAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600 dark:text-gray-400">{fmtDate(i.expiresAt)}</td>
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
export function RecoverDeletedItemsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Modal onClose={onClose} label={t('recover_title')} className="bg-white dark:bg-gray-900 rounded-lg shadow-2xl w-full max-w-3xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('recover_title')}</h2>
        <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"><X size={16} /></button>
      </div>
      <RecoverDeletedItemsPanel />
    </Modal>
  );
}
