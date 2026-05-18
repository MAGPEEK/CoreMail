import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { CheckCircle, Server, Settings, Loader2, Save, Wand2, AlertCircle, RefreshCw } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
const SERVICES = [
    { name: 'smtp-server', port: '25/465/587', description: 'SMTP Inbound + Outbound' },
    { name: 'imap-server', port: '143/993', description: 'IMAP4rev1 + IDLE' },
    { name: 'pop3-server', port: '110/995', description: 'POP3' },
    { name: 'ews-server', port: '8080', description: 'Exchange Web Services (SOAP)' },
    { name: 'autodiscover', port: '8081', description: 'Autodiscover v1 + v2' },
    { name: 'caldav-server', port: '8082', description: 'CalDAV + CardDAV' },
    { name: 'api-gateway', port: '3000', description: 'REST API + SSE' },
    { name: 'auth-service', port: '3003', description: 'Authentication + MFA' },
];
export function ServersPage() {
    const [tab, setTab] = useState('settings');
    const [form, setForm] = useState(null);
    const [saved, setSaved] = useState(false);
    const qc = useQueryClient();
    const { data: settings, isLoading, isError, refetch } = useQuery({
        queryKey: ['server-settings'],
        queryFn: () => api.get('/admin/servers/settings'),
        retry: 1,
    });
    // Formular initialisieren sobald Daten geladen
    useEffect(() => {
        if (settings && !form)
            setForm(settings);
    }, [settings, form]);
    const saveMutation = useMutation({
        mutationFn: (data) => api.put('/admin/servers/settings', data),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['server-settings'] });
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        },
    });
    const deriveMutation = useMutation({
        mutationFn: (data) => api.post('/admin/servers/settings/derive', data),
        onSuccess: (d) => setForm(d),
    });
    const current = form ?? settings ?? null;
    function set(key, value) {
        setForm((prev) => prev ? { ...prev, [key]: value } : null);
    }
    function handleDerive() {
        if (!current)
            return;
        deriveMutation.mutate({
            publicHostname: current.publicHostname,
            useHttps: current.useHttps,
            httpPort: current.httpPort,
        });
    }
    function handleSave() {
        if (!current)
            return;
        saveMutation.mutate(current);
    }
    return (_jsxs("div", { className: "p-6 space-y-4", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Server, { size: 20, className: "text-accent" }), _jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Server" })] }), _jsx("div", { className: "flex gap-1 border-b border-gray-200", children: [['settings', 'Virtuelle Verzeichnisse'], ['health', 'Health & Status']].map(([id, label]) => (_jsx("button", { onClick: () => setTab(id), className: `px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === id
                        ? 'border-accent text-accent'
                        : 'border-transparent text-gray-500 hover:text-gray-700'}`, children: label }, id))) }), tab === 'settings' && (_jsx("div", { className: "space-y-6 max-w-3xl", children: isLoading ? (_jsxs("div", { className: "flex items-center gap-2 text-gray-500", children: [_jsx(Loader2, { size: 16, className: "animate-spin" }), " Lade Einstellungen\u2026"] })) : isError ? (_jsxs("div", { className: "card flex items-center gap-3 text-red-700 bg-red-50 border border-red-200", children: [_jsx(AlertCircle, { size: 18, className: "shrink-0" }), _jsxs("div", { className: "flex-1", children: [_jsx("p", { className: "font-medium", children: "Einstellungen konnten nicht geladen werden" }), _jsx("p", { className: "text-sm text-red-600 mt-0.5", children: "Session abgelaufen? Bitte neu anmelden oder erneut versuchen." })] }), _jsxs("button", { onClick: () => void refetch(), className: "btn-secondary flex items-center gap-1.5 text-sm", children: [_jsx(RefreshCw, { size: 14 }), " Erneut versuchen"] })] })) : !current ? (_jsxs("div", { className: "flex items-center gap-2 text-gray-500", children: [_jsx(Loader2, { size: 16, className: "animate-spin" }), " Lade Einstellungen\u2026"] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "card space-y-4", children: [_jsxs("div", { className: "flex items-center gap-2 border-b border-gray-100 pb-3", children: [_jsx(Settings, { size: 16, className: "text-gray-400" }), _jsx("h2", { className: "font-medium text-gray-800", children: "\u00D6ffentliche Server-Adresse" })] }), _jsxs("div", { className: "grid grid-cols-3 gap-4", children: [_jsxs("div", { className: "col-span-2", children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "Hostname / Domain" }), _jsx("input", { className: "input w-full", placeholder: "mail.example.com", value: current.publicHostname, onChange: (e) => set('publicHostname', e.target.value) }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: "DNS-Name unter dem CoreMail extern erreichbar ist" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "HTTP-Port" }), _jsx("input", { className: "input w-full", type: "number", min: 1, max: 65535, value: current.httpPort, onChange: (e) => set('httpPort', parseInt(e.target.value) || 8080) })] })] }), _jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [_jsx("input", { type: "checkbox", className: "w-4 h-4 rounded border-gray-300", checked: current.useHttps, onChange: (e) => set('useHttps', e.target.checked) }), _jsx("span", { className: "text-sm text-gray-700", children: "HTTPS verwenden" }), _jsx("span", { className: "text-xs text-gray-400", children: "(TLS-Terminierung im Reverse Proxy \u2014 Traefik, Caddy, DSM)" })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("button", { onClick: handleDerive, disabled: deriveMutation.isPending, className: "btn-secondary flex items-center gap-2 text-sm", children: [deriveMutation.isPending
                                                    ? _jsx(Loader2, { size: 14, className: "animate-spin" })
                                                    : _jsx(Wand2, { size: 14 }), "URLs automatisch ableiten"] }), _jsx("span", { className: "text-xs text-gray-400", children: "Generiert alle URLs aus Hostname + Port" })] })] }), _jsxs("div", { className: "card space-y-4", children: [_jsx("h2", { className: "font-medium text-gray-800 border-b border-gray-100 pb-3", children: "Exchange-URLs (Outlook Autodiscover)" }), [
                                    ['ewsUrl', 'EWS-URL (Outlook Desktop — Exchange Web Services)'],
                                    ['owaUrl', 'OWA-URL (Outlook Web Access)'],
                                    ['easUrl', 'EAS-URL (ActiveSync — Mobil)'],
                                    ['autodiscoverBase', 'Autodiscover-Basis-URL'],
                                ].map(([key, label]) => (_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: label }), _jsx("input", { className: "input w-full font-mono text-sm", value: current[key], onChange: (e) => set(key, e.target.value) })] }, key)))] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("button", { onClick: handleSave, disabled: saveMutation.isPending, className: "btn-primary flex items-center gap-2", children: [saveMutation.isPending
                                            ? _jsx(Loader2, { size: 16, className: "animate-spin" })
                                            : _jsx(Save, { size: 16 }), "Einstellungen speichern"] }), saved && (_jsxs("div", { className: "flex items-center gap-1.5 text-green-600 text-sm", children: [_jsx(CheckCircle, { size: 16 }), "Gespeichert \u2014 Autodiscover aktualisiert sich innerhalb 60 s"] })), saveMutation.isError && (_jsx("p", { className: "text-red-600 text-sm", children: "Fehler beim Speichern" }))] }), _jsxs("div", { className: "card bg-blue-50 border border-blue-200 space-y-3", children: [_jsxs("h3", { className: "font-medium text-blue-800 flex items-center gap-2", children: [_jsx(Settings, { size: 16 }), "Outlook 2019 / 2022 / 365 einrichten"] }), _jsxs("ol", { className: "text-sm text-blue-700 list-decimal list-inside space-y-1", children: [_jsxs("li", { children: ["Outlook \u00F6ffnen \u2192 ", _jsx("strong", { children: "Datei \u2192 Konto hinzuf\u00FCgen" })] }), _jsxs("li", { children: ["E-Mail-Adresse eingeben (z.B. ", _jsx("code", { className: "bg-blue-100 px-1 rounded", children: "admin@stefanwuestner.de" }), ")"] }), _jsx("li", { children: "Outlook erkennt CoreMail automatisch \u00FCber Autodiscover" }), _jsx("li", { children: "Passwort eingeben \u2192 fertig" })] }), _jsxs("p", { className: "text-xs text-blue-600", children: [_jsx("strong", { children: "Voraussetzung:" }), ' ', _jsxs("code", { className: "bg-blue-100 px-1 rounded", children: [current.autodiscoverBase, "/Autodiscover/Autodiscover.xml"] }), ' ', "muss von Outlook erreichbar sein.", current.publicHostname && (_jsxs(_Fragment, { children: [" DNS: ", _jsxs("code", { className: "bg-blue-100 px-1 rounded", children: ["autodiscover.", current.publicHostname, " CNAME ", current.publicHostname] })] }))] })] })] })) })), tab === 'health' && (_jsxs("div", { className: "space-y-4", children: [_jsx("div", { className: "card p-0 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsx("tr", { children: ['Service', 'Ports', 'Beschreibung', 'Status'].map((h) => (_jsx("th", { className: "text-left px-4 py-2.5 font-medium text-gray-500 text-xs", children: h }, h))) }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: SERVICES.map((s) => (_jsxs("tr", { className: "hover:bg-gray-50", children: [_jsx("td", { className: "px-4 py-2.5 font-mono text-sm text-gray-700", children: s.name }), _jsx("td", { className: "px-4 py-2.5 font-mono text-xs text-gray-500", children: s.port }), _jsx("td", { className: "px-4 py-2.5 text-xs text-gray-600", children: s.description }), _jsx("td", { className: "px-4 py-2.5", children: _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx(CheckCircle, { size: 14, className: "text-green-500" }), _jsx("span", { className: "text-xs text-green-700", children: "Online" })] }) })] }, s.name))) })] }) }), _jsx("div", { className: "grid grid-cols-3 gap-4", children: [
                            { label: 'PostgreSQL', detail: 'Primary · Read-Write' },
                            { label: 'Redis', detail: 'Connected · Pub/Sub aktiv' },
                            { label: 'MinIO', detail: 'Online · S3-kompatibel' },
                        ].map((item) => (_jsxs("div", { className: "card flex items-center gap-3", children: [_jsx(CheckCircle, { size: 20, className: "text-green-500 shrink-0" }), _jsxs("div", { children: [_jsx("p", { className: "font-medium text-gray-800", children: item.label }), _jsx("p", { className: "text-xs text-gray-500", children: item.detail })] })] }, item.label))) })] }))] }));
}
