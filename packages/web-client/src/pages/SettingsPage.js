import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { User, PenLine, BellOff, Shield, Key } from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
const SECTIONS = [
    { id: 'profile', label: 'Profil', icon: User },
    { id: 'signature', label: 'Signatur', icon: PenLine },
    { id: 'oof', label: 'Abwesenheit', icon: BellOff },
    { id: 'security', label: 'Sicherheit', icon: Shield },
];
function ProfileSection() {
    const qc = useQueryClient();
    const { data } = useQuery({ queryKey: ['user-profile'], queryFn: () => api.get('/user/profile') });
    const [name, setName] = useState('');
    const mutation = useMutation({
        mutationFn: () => api.put('/user/profile', { displayName: name }),
        onSuccess: () => { toast.success('Profil gespeichert'); qc.invalidateQueries({ queryKey: ['user-profile'] }); },
        onError: (err) => toast.error(err.message),
    });
    return (_jsxs("div", { className: "space-y-4", children: [_jsx("h2", { className: "text-base font-semibold", children: "Profil" }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "E-Mail" }), _jsx("input", { className: "input", value: data?.email ?? '', disabled: true })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Anzeigename" }), _jsx("input", { className: "input", defaultValue: data?.displayName ?? '', onChange: (e) => setName(e.target.value) })] }), _jsx("button", { onClick: () => mutation.mutate(), className: "btn-primary", disabled: mutation.isPending, children: mutation.isPending ? 'Speichern...' : 'Speichern' })] }));
}
function SignatureSection() {
    const qc = useQueryClient();
    const { data } = useQuery({ queryKey: ['user-signature'], queryFn: () => api.get('/user/signature') });
    const editor = useEditor({ extensions: [StarterKit], content: data?.signature ?? '' });
    const mutation = useMutation({
        mutationFn: () => api.put('/user/signature', { signature: editor?.getHTML() ?? '' }),
        onSuccess: () => { toast.success('Signatur gespeichert'); qc.invalidateQueries({ queryKey: ['user-signature'] }); },
    });
    return (_jsxs("div", { className: "space-y-4", children: [_jsx("h2", { className: "text-base font-semibold", children: "E-Mail-Signatur" }), _jsx("div", { className: "border border-gray-200 rounded", children: _jsx(EditorContent, { editor: editor, className: "min-h-[160px] p-3 text-sm [&_.ProseMirror]:outline-none" }) }), _jsx("button", { onClick: () => mutation.mutate(), className: "btn-primary", disabled: mutation.isPending, children: mutation.isPending ? 'Speichern...' : 'Speichern' })] }));
}
function OofSection() {
    const qc = useQueryClient();
    const { data } = useQuery({ queryKey: ['user-oof'], queryFn: () => api.get('/user/oof') });
    const [enabled, setEnabled] = useState(data?.enabled ?? false);
    const [internalMsg, setInternalMsg] = useState(data?.internalMessage ?? '');
    const [externalMsg, setExternalMsg] = useState(data?.externalMessage ?? '');
    const mutation = useMutation({
        mutationFn: () => api.put('/user/oof', { enabled, internalMessage: internalMsg, externalMessage: externalMsg }),
        onSuccess: () => { toast.success('Abwesenheit gespeichert'); qc.invalidateQueries({ queryKey: ['user-oof'] }); },
    });
    return (_jsxs("div", { className: "space-y-4", children: [_jsx("h2", { className: "text-base font-semibold", children: "Abwesenheitsassistent" }), _jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: enabled, onChange: (e) => setEnabled(e.target.checked), className: "w-4 h-4 accent-accent" }), _jsx("span", { className: "text-sm", children: "Automatische Antworten aktivieren" })] }), enabled && (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Interne Antwort" }), _jsx("textarea", { className: "input h-28 resize-none", value: internalMsg, onChange: (e) => setInternalMsg(e.target.value), placeholder: "Antwort an interne Absender..." })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Externe Antwort" }), _jsx("textarea", { className: "input h-28 resize-none", value: externalMsg, onChange: (e) => setExternalMsg(e.target.value), placeholder: "Antwort an externe Absender..." })] })] })), _jsx("button", { onClick: () => mutation.mutate(), className: "btn-primary", disabled: mutation.isPending, children: mutation.isPending ? 'Speichern...' : 'Speichern' })] }));
}
function SecuritySection() {
    return (_jsxs("div", { className: "space-y-4", children: [_jsx("h2", { className: "text-base font-semibold", children: "Sicherheit" }), _jsxs("div", { className: "bg-gray-50 border border-gray-200 rounded p-4", children: [_jsxs("div", { className: "flex items-center gap-2 mb-2", children: [_jsx(Key, { size: 15, className: "text-gray-400" }), _jsx("span", { className: "text-sm font-medium", children: "App-Passw\u00F6rter" })] }), _jsx("p", { className: "text-xs text-gray-500 mb-3", children: "App-Passw\u00F6rter erm\u00F6glichen es E-Mail-Clients (Outlook, Thunderbird) sich ohne Ihr Hauptpasswort zu verbinden." }), _jsx("a", { href: "http://localhost:3003/auth/app-passwords", target: "_blank", rel: "noopener noreferrer", className: "btn-secondary text-xs", children: "App-Passw\u00F6rter verwalten" })] }), _jsxs("div", { className: "bg-gray-50 border border-gray-200 rounded p-4", children: [_jsxs("div", { className: "flex items-center gap-2 mb-2", children: [_jsx(Shield, { size: 15, className: "text-gray-400" }), _jsx("span", { className: "text-sm font-medium", children: "Zwei-Faktor-Authentifizierung" })] }), _jsx("p", { className: "text-xs text-gray-500 mb-3", children: "Sch\u00FCtzen Sie Ihr Konto mit einem zweiten Faktor (TOTP-Authenticator oder Hardware-Key)." }), _jsx("a", { href: "http://localhost:3003/auth/mfa", target: "_blank", rel: "noopener noreferrer", className: "btn-secondary text-xs", children: "2FA konfigurieren" })] })] }));
}
const SECTION_COMPONENTS = {
    profile: ProfileSection,
    signature: SignatureSection,
    oof: OofSection,
    security: SecuritySection,
};
export function SettingsPage() {
    const [section, setSection] = useState('profile');
    const SectionComp = SECTION_COMPONENTS[section];
    return (_jsxs("div", { className: "flex flex-1 overflow-hidden bg-gray-50", children: [_jsx("aside", { className: "w-48 shrink-0 bg-white border-r border-gray-200 pt-4", children: SECTIONS.map(({ id, label, icon: Icon }) => (_jsxs("button", { onClick: () => setSection(id), className: `w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${section === id ? 'bg-accent/10 text-accent font-medium' : 'text-gray-700 hover:bg-gray-50'}`, children: [_jsx(Icon, { size: 15 }), label] }, id))) }), _jsx("div", { className: "flex-1 overflow-y-auto p-8", children: _jsx("div", { className: "max-w-lg", children: _jsx(SectionComp, {}) }) })] }));
}
