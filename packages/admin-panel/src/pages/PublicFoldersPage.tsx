import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, FolderPlus, Pencil, Trash2, ChevronRight, ChevronDown, Lock, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PublicFolder {
  id: string;
  name: string;
  displayName: string;
  description: string;
  parentId: string | null;
  messageCount: number;
  children: PublicFolder[];
}

interface AclEntry {
  id: string;
  userId: string;
  userEmail: string;
  permission: 'READ' | 'WRITE' | 'FULL';
}

// ─── Folder Modal ─────────────────────────────────────────────────────────────

function FolderModal({
  folder,
  parentId,
  onClose,
}: {
  folder?: PublicFolder;
  parentId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: folder?.name ?? '',
    displayName: folder?.displayName ?? '',
    description: folder?.description ?? '',
  });

  const save = useMutation({
    mutationFn: () =>
      folder
        ? api.put(`/admin/public-folders/${folder.id}`, form)
        : api.post('/admin/public-folders', { ...form, ...(parentId ? { parentId } : {}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-public-folders'] });
      toast.success(folder ? 'Ordner aktualisiert' : 'Ordner erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-gray-900">
            {folder ? 'Ordner bearbeiten' : parentId ? 'Unterordner erstellen' : 'Stammordner erstellen'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Interner Name *</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="allgemein" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Anzeigename *</label>
            <input value={form.displayName} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="Allgemein" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Beschreibung</label>
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={2} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none"
              placeholder="Optionale Beschreibung" />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">
            Abbrechen
          </button>
          <button onClick={() => save.mutate()} disabled={!form.name || !form.displayName || save.isPending}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ACL Panel ────────────────────────────────────────────────────────────────

const PERM_LABELS: Record<string, string> = { READ: 'Lesen', WRITE: 'Lesen & Schreiben', FULL: 'Vollzugriff' };

function AclPanel({ folder, onClose }: { folder: PublicFolder; onClose: () => void }) {
  const qc = useQueryClient();
  const [newEmail, setNewEmail] = useState('');
  const [newPerm, setNewPerm] = useState<'READ' | 'WRITE' | 'FULL'>('READ');

  const { data: acl = [] } = useQuery<AclEntry[]>({
    queryKey: ['admin-public-folders-acl', folder.id],
    queryFn: () => api.get(`/admin/public-folders/${folder.id}/acl`),
  });

  const grant = useMutation({
    mutationFn: () => api.post(`/admin/public-folders/${folder.id}/acl`, { userEmail: newEmail, permission: newPerm }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-public-folders-acl', folder.id] });
      toast.success('Berechtigung hinzugefügt');
      setNewEmail('');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: (userId: string) => api.delete(`/admin/public-folders/${folder.id}/acl/${userId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-public-folders-acl', folder.id] });
      toast.success('Berechtigung entfernt');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Zugriffsrechte</h2>
            <p className="text-xs text-gray-500 mt-0.5">{folder.displayName}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        {/* Existing entries */}
        <div className="border border-gray-200 rounded-lg overflow-hidden mb-4">
          {acl.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-6">Keine benutzerdefinierten Rechte</p>
          ) : acl.map(e => (
            <div key={e.id} className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 last:border-0">
              <div>
                <p className="text-sm text-gray-800 font-medium">{e.userEmail}</p>
                <p className="text-xs text-gray-500">{PERM_LABELS[e.permission]}</p>
              </div>
              <button onClick={() => revoke.mutate(e.userId)}
                className="text-gray-400 hover:text-red-500 transition-colors">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* Add new */}
        <div className="flex gap-2">
          <input value={newEmail} onChange={e => setNewEmail(e.target.value)}
            className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            placeholder="user@example.com" />
          <select value={newPerm} onChange={e => setNewPerm(e.target.value as 'READ' | 'WRITE' | 'FULL')}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
            <option value="READ">Lesen</option>
            <option value="WRITE">Lesen & Schreiben</option>
            <option value="FULL">Vollzugriff</option>
          </select>
          <button onClick={() => grant.mutate()} disabled={!newEmail || grant.isPending}
            className="flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            <Plus size={13} /> Hinzufügen
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Folder Row (recursive) ───────────────────────────────────────────────────

function FolderRow({
  folder,
  depth,
  onEdit,
  onDelete,
  onAddChild,
  onAcl,
}: {
  folder: PublicFolder;
  depth: number;
  onEdit: (f: PublicFolder) => void;
  onDelete: (f: PublicFolder) => void;
  onAddChild: (parentId: string) => void;
  onAcl: (f: PublicFolder) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = folder.children.length > 0;

  return (
    <>
      <tr className="border-b border-gray-100 hover:bg-gray-50 group">
        <td className="px-4 py-2.5">
          <div className="flex items-center" style={{ paddingLeft: depth * 20 }}>
            <button onClick={() => setExpanded(v => !v)}
              className={`mr-1.5 text-gray-400 ${hasChildren ? 'hover:text-gray-600' : 'invisible'}`}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <FolderOpen size={14} className="text-yellow-500 mr-2 shrink-0" />
            <div>
              <p className="text-sm text-gray-900 font-medium">{folder.displayName}</p>
              {folder.description && <p className="text-xs text-gray-400">{folder.description}</p>}
            </div>
          </div>
        </td>
        <td className="px-4 py-2.5 text-xs font-mono text-gray-500">{folder.name}</td>
        <td className="px-4 py-2.5 text-xs text-gray-500">{folder.messageCount.toLocaleString('de-DE')}</td>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
            <button onClick={() => onAddChild(folder.id)} title="Unterordner erstellen"
              className="p-1 text-gray-400 hover:text-accent rounded">
              <FolderPlus size={13} />
            </button>
            <button onClick={() => onAcl(folder)} title="Zugriffsrechte"
              className="p-1 text-gray-400 hover:text-blue-500 rounded">
              <Lock size={13} />
            </button>
            <button onClick={() => onEdit(folder)} title="Bearbeiten"
              className="p-1 text-gray-400 hover:text-gray-700 rounded">
              <Pencil size={13} />
            </button>
            <button onClick={() => onDelete(folder)} title="Löschen"
              className="p-1 text-gray-400 hover:text-red-500 rounded">
              <Trash2 size={13} />
            </button>
          </div>
        </td>
      </tr>
      {expanded && folder.children.map(child => (
        <FolderRow key={child.id} folder={child} depth={depth + 1}
          onEdit={onEdit} onDelete={onDelete} onAddChild={onAddChild} onAcl={onAcl} />
      ))}
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function PublicFoldersPage() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<
    | { type: 'create-root' }
    | { type: 'create-child'; parentId: string }
    | { type: 'edit'; folder: PublicFolder }
    | { type: 'acl'; folder: PublicFolder }
    | null
  >(null);

  const { data: folders = [], isLoading } = useQuery<PublicFolder[]>({
    queryKey: ['admin-public-folders'],
    queryFn: () => api.get('/admin/public-folders'),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/public-folders/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-public-folders'] });
      toast.success('Ordner gelöscht');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleDelete = (f: PublicFolder) => {
    if (confirm(`Ordner „${f.displayName}" und alle Unterordner löschen?`)) {
      del.mutate(f.id);
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FolderOpen size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Öffentliche Ordner</h1>
            <p className="text-sm text-gray-500">Freigegebene Ordner für alle Benutzer der Organisation</p>
          </div>
        </div>
        <button onClick={() => setModal({ type: 'create-root' })}
          className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90">
          <FolderPlus size={15} /> Stammordner erstellen
        </button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3">Ordner</th>
              <th className="text-left px-4 py-3">Name</th>
              <th className="text-left px-4 py-3">Nachrichten</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={4} className="text-center py-12 text-gray-400">Laden…</td></tr>
            ) : folders.length === 0 ? (
              <tr><td colSpan={4} className="text-center py-12 text-gray-400">Noch keine öffentlichen Ordner vorhanden</td></tr>
            ) : folders.map(f => (
              <FolderRow key={f.id} folder={f} depth={0}
                onEdit={folder => setModal({ type: 'edit', folder })}
                onDelete={handleDelete}
                onAddChild={parentId => setModal({ type: 'create-child', parentId })}
                onAcl={folder => setModal({ type: 'acl', folder })}
              />
            ))}
          </tbody>
        </table>
      </div>

      {modal?.type === 'create-root' && (
        <FolderModal onClose={() => setModal(null)} />
      )}
      {modal?.type === 'create-child' && (
        <FolderModal parentId={modal.parentId} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'edit' && (
        <FolderModal folder={modal.folder} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'acl' && (
        <AclPanel folder={modal.folder} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
