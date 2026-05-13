import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { User, PenLine, BellOff, Shield, Key } from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';

type Section = 'profile' | 'signature' | 'oof' | 'security';

const SECTIONS = [
  { id: 'profile', label: 'Profil', icon: User },
  { id: 'signature', label: 'Signatur', icon: PenLine },
  { id: 'oof', label: 'Abwesenheit', icon: BellOff },
  { id: 'security', label: 'Sicherheit', icon: Shield },
] as const;

function ProfileSection() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['user-profile'], queryFn: () => api.get<{ displayName: string; email: string }>('/user/profile') });
  const [name, setName] = useState('');

  const mutation = useMutation({
    mutationFn: () => api.put('/user/profile', { displayName: name }),
    onSuccess: () => { toast.success('Profil gespeichert'); qc.invalidateQueries({ queryKey: ['user-profile'] }); },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">Profil</h2>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">E-Mail</label>
        <input className="input" value={data?.email ?? ''} disabled />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Anzeigename</label>
        <input className="input" defaultValue={data?.displayName ?? ''} onChange={(e) => setName(e.target.value)} />
      </div>
      <button onClick={() => mutation.mutate()} className="btn-primary" disabled={mutation.isPending}>
        {mutation.isPending ? 'Speichern...' : 'Speichern'}
      </button>
    </div>
  );
}

function SignatureSection() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['user-signature'], queryFn: () => api.get<{ signature: string }>('/user/signature') });
  const editor = useEditor({ extensions: [StarterKit], content: data?.signature ?? '' });

  const mutation = useMutation({
    mutationFn: () => api.put('/user/signature', { signature: editor?.getHTML() ?? '' }),
    onSuccess: () => { toast.success('Signatur gespeichert'); qc.invalidateQueries({ queryKey: ['user-signature'] }); },
  });

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">E-Mail-Signatur</h2>
      <div className="border border-gray-200 rounded">
        <EditorContent editor={editor} className="min-h-[160px] p-3 text-sm [&_.ProseMirror]:outline-none" />
      </div>
      <button onClick={() => mutation.mutate()} className="btn-primary" disabled={mutation.isPending}>
        {mutation.isPending ? 'Speichern...' : 'Speichern'}
      </button>
    </div>
  );
}

function OofSection() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['user-oof'], queryFn: () => api.get<{ enabled: boolean; internalMessage: string; externalMessage: string }>('/user/oof') });
  const [enabled, setEnabled] = useState(data?.enabled ?? false);
  const [internalMsg, setInternalMsg] = useState(data?.internalMessage ?? '');
  const [externalMsg, setExternalMsg] = useState(data?.externalMessage ?? '');

  const mutation = useMutation({
    mutationFn: () => api.put('/user/oof', { enabled, internalMessage: internalMsg, externalMessage: externalMsg }),
    onSuccess: () => { toast.success('Abwesenheit gespeichert'); qc.invalidateQueries({ queryKey: ['user-oof'] }); },
  });

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">Abwesenheitsassistent</h2>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4 accent-accent" />
        <span className="text-sm">Automatische Antworten aktivieren</span>
      </label>
      {enabled && (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Interne Antwort</label>
            <textarea className="input h-28 resize-none" value={internalMsg} onChange={(e) => setInternalMsg(e.target.value)} placeholder="Antwort an interne Absender..." />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Externe Antwort</label>
            <textarea className="input h-28 resize-none" value={externalMsg} onChange={(e) => setExternalMsg(e.target.value)} placeholder="Antwort an externe Absender..." />
          </div>
        </>
      )}
      <button onClick={() => mutation.mutate()} className="btn-primary" disabled={mutation.isPending}>
        {mutation.isPending ? 'Speichern...' : 'Speichern'}
      </button>
    </div>
  );
}

function SecuritySection() {
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">Sicherheit</h2>
      <div className="bg-gray-50 border border-gray-200 rounded p-4">
        <div className="flex items-center gap-2 mb-2">
          <Key size={15} className="text-gray-400" />
          <span className="text-sm font-medium">App-Passwörter</span>
        </div>
        <p className="text-xs text-gray-500 mb-3">App-Passwörter ermöglichen es E-Mail-Clients (Outlook, Thunderbird) sich ohne Ihr Hauptpasswort zu verbinden.</p>
        <a href="http://localhost:3003/auth/app-passwords" target="_blank" rel="noopener noreferrer"
          className="btn-secondary text-xs">App-Passwörter verwalten</a>
      </div>
      <div className="bg-gray-50 border border-gray-200 rounded p-4">
        <div className="flex items-center gap-2 mb-2">
          <Shield size={15} className="text-gray-400" />
          <span className="text-sm font-medium">Zwei-Faktor-Authentifizierung</span>
        </div>
        <p className="text-xs text-gray-500 mb-3">Schützen Sie Ihr Konto mit einem zweiten Faktor (TOTP-Authenticator oder Hardware-Key).</p>
        <a href="http://localhost:3003/auth/mfa" target="_blank" rel="noopener noreferrer"
          className="btn-secondary text-xs">2FA konfigurieren</a>
      </div>
    </div>
  );
}

const SECTION_COMPONENTS: Record<Section, React.ComponentType> = {
  profile: ProfileSection,
  signature: SignatureSection,
  oof: OofSection,
  security: SecuritySection,
};

export function SettingsPage() {
  const [section, setSection] = useState<Section>('profile');
  const SectionComp = SECTION_COMPONENTS[section];

  return (
    <div className="flex flex-1 overflow-hidden bg-gray-50">
      <aside className="w-48 shrink-0 bg-white border-r border-gray-200 pt-4">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setSection(id as Section)}
            className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${section === id ? 'bg-accent/10 text-accent font-medium' : 'text-gray-700 hover:bg-gray-50'}`}>
            <Icon size={15} />
            {label}
          </button>
        ))}
      </aside>
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-lg">
          <SectionComp />
        </div>
      </div>
    </div>
  );
}
