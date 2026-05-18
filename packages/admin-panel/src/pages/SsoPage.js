import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Plus, Trash2, RefreshCw, CheckCircle2, XCircle, TestTube2, Save, Settings, List, Info, AlertCircle, ExternalLink, ShieldCheck, Edit2, } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
const SECTIONS = [
    { key: 'providers', label: 'OIDC-Anbieter', icon: _jsx(List, { size: 14 }) },
    { key: 'saml', label: 'SAML 2.0', icon: _jsx(ShieldCheck, { size: 14 }) },
    { key: 'settings', label: 'Einstellungen', icon: _jsx(Settings, { size: 14 }) },
];
const PRESET_PROVIDERS = [
    { name: 'Azure Active Directory', url: 'https://login.microsoftonline.com/{tenant-id}/v2.0/.well-known/openid-configuration', icon: '🪟' },
    { name: 'Google Workspace', url: 'https://accounts.google.com/.well-known/openid-configuration', icon: '🔵' },
    { name: 'Keycloak', url: 'https://keycloak.meinserver.de/realms/{realm}/.well-known/openid-configuration', icon: '🔑' },
    { name: 'Authentik', url: 'https://authentik.meinserver.de/application/o/{slug}/.well-known/openid-configuration', icon: '🛡️' },
    { name: 'Okta', url: 'https://{domain}.okta.com/.well-known/openid-configuration', icon: '⭕' },
    { name: 'GitHub', url: 'https://token.actions.githubusercontent.com/.well-known/openid-configuration', icon: '🐙' },
];
// ─── Provider Form ────────────────────────────────────────────────────────────
function ProviderForm({ provider, domains, onSaved, onCancel, }) {
    const qc = useQueryClient();
    const isEdit = !!provider;
    const [form, setForm] = useState({
        domainId: provider?.domainId ?? '',
        name: provider?.name ?? '',
        discoveryUrl: provider?.discoveryUrl ?? '',
        clientId: provider?.clientId ?? '',
        clientSecret: '',
        autoProvision: provider?.autoProvision ?? true,
        active: provider?.active ?? true,
        forcedDomains: provider?.forcedDomains ?? [],
    });
    const [testResult, setTestResult] = useState(null);
    const [testing, setTesting] = useState(false);
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const save = useMutation({
        mutationFn: () => isEdit
            ? api.put(`/admin/sso/providers/${provider.id}`, form)
            : api.post('/admin/sso/providers', form).then(() => ({ ok: true })),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-sso-providers'] });
            toast.success(isEdit ? 'Provider aktualisiert' : 'Provider angelegt');
            onSaved();
        },
        onError: (e) => toast.error(e.message),
    });
    async function handleTest() {
        if (!provider?.id && !form.discoveryUrl)
            return;
        setTesting(true);
        setTestResult(null);
        try {
            if (provider?.id) {
                const r = await api.post(`/admin/sso/providers/${provider.id}/test`, {});
                setTestResult(r);
            }
            else {
                // Test by directly fetching the discovery URL
                const resp = await fetch(form.discoveryUrl);
                if (!resp.ok) {
                    setTestResult({ success: false, message: `HTTP ${resp.status}` });
                    return;
                }
                const doc = await resp.json();
                setTestResult({ success: true, message: 'Discovery-Dokument abgerufen', issuer: doc.issuer });
            }
        }
        catch (e) {
            setTestResult({ success: false, message: e.message });
        }
        finally {
            setTesting(false);
        }
    }
    return (_jsxs("div", { className: "space-y-5 max-w-2xl", children: [_jsxs("div", { className: "card p-5 space-y-4", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: isEdit ? `Provider bearbeiten: ${provider.name}` : 'Neuer OIDC-Provider' }), !isEdit && (_jsxs("div", { children: [_jsx("p", { className: "text-xs font-medium text-gray-600 mb-2", children: "Schnellauswahl (Vorlage laden):" }), _jsx("div", { className: "flex flex-wrap gap-2", children: PRESET_PROVIDERS.map(p => (_jsxs("button", { onClick: () => { set('name', p.name); set('discoveryUrl', p.url); }, className: "flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-accent transition-colors", children: [_jsx("span", { children: p.icon }), p.name] }, p.name))) })] })), !isEdit && (_jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-gray-600 block mb-1", children: "Domain *" }), _jsxs("select", { value: form.domainId, onChange: e => set('domainId', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent", children: [_jsx("option", { value: "", children: "Domain w\u00E4hlen\u2026" }), domains.map(d => _jsx("option", { value: d.id, children: d.name }, d.id))] })] })), _jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-gray-600 block mb-1", children: "Anbieter-Name *" }), _jsx("input", { value: form.name, onChange: e => set('name', e.target.value), placeholder: "z. B. Azure AD, Google Workspace, Keycloak", className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" })] }), _jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-gray-600 block mb-1", children: "Discovery-URL (OIDC) *" }), _jsx("input", { value: form.discoveryUrl, onChange: e => set('discoveryUrl', e.target.value), placeholder: "https://login.microsoftonline.com/{tenant-id}/v2.0/.well-known/openid-configuration", className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" }), _jsxs("p", { className: "text-xs text-gray-400 mt-1", children: ["OIDC-Konfigurationsendpunkt des Identit\u00E4tsanbieters (Pfad endet auf ", _jsx("code", { className: "bg-gray-100 px-1 rounded", children: "/.well-known/openid-configuration" }), ")"] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-gray-600 block mb-1", children: "Client ID *" }), _jsx("input", { value: form.clientId, onChange: e => set('clientId', e.target.value), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" })] }), _jsxs("div", { children: [_jsxs("label", { className: "text-xs font-medium text-gray-600 block mb-1", children: ["Client Secret ", isEdit && _jsx("span", { className: "text-gray-400", children: "(leer = unver\u00E4ndert)" })] }), _jsx("input", { type: "password", value: form.clientSecret, onChange: e => set('clientSecret', e.target.value), placeholder: isEdit ? '••••••••' : '', className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-6 pt-2 border-t border-gray-100", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-gray-800", children: "Auto-Provisionierung" }), _jsx("p", { className: "text-xs text-gray-500", children: "Postfach beim ersten Login anlegen" })] }), _jsx(Toggle, { active: form.autoProvision, onToggle: () => set('autoProvision', !form.autoProvision) })] }), _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-gray-800", children: "Aktiv" }), _jsx("p", { className: "text-xs text-gray-500", children: "Provider f\u00FCr Anmeldung verf\u00FCgbar" })] }), _jsx(Toggle, { active: form.active, onToggle: () => set('active', !form.active) })] })] })] }), testResult && (_jsxs("div", { className: `flex items-start gap-2 p-3 rounded-lg border text-sm ${testResult.success ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`, children: [testResult.success ? _jsx(CheckCircle2, { size: 15, className: "shrink-0 mt-0.5" }) : _jsx(XCircle, { size: 15, className: "shrink-0 mt-0.5" }), _jsxs("div", { children: [_jsx("p", { children: testResult.message }), testResult.issuer && _jsxs("p", { className: "text-xs mt-0.5 font-mono opacity-75", children: ["Issuer: ", testResult.issuer] })] })] })), _jsxs("div", { className: "flex gap-3", children: [_jsx("button", { onClick: onCancel, className: "px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50", children: "Abbrechen" }), _jsxs("button", { onClick: handleTest, disabled: testing || !form.discoveryUrl, className: "flex items-center gap-2 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50", children: [_jsx(TestTube2, { size: 14 }), testing ? 'Teste…' : 'Discovery-URL testen'] }), _jsxs("button", { onClick: () => save.mutate(), disabled: save.isPending || !form.name || !form.discoveryUrl || !form.clientId || (!isEdit && !form.domainId), className: "flex items-center gap-2 px-5 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-60", children: [_jsx(Save, { size: 14 }), save.isPending ? 'Speichern…' : isEdit ? 'Aktualisieren' : 'Provider anlegen'] })] })] }));
}
// ─── Providers List ───────────────────────────────────────────────────────────
function ProvidersSection() {
    const qc = useQueryClient();
    const [showForm, setShowForm] = useState(false);
    const [editingProvider, setEditingProvider] = useState();
    const { data: providers = [], refetch } = useQuery({
        queryKey: ['admin-sso-providers'],
        queryFn: () => api.get('/admin/sso/providers'),
    });
    const { data: domains = [] } = useQuery({
        queryKey: ['admin-sso-domains'],
        queryFn: () => api.get('/admin/sso/domains'),
    });
    const deleteMut = useMutation({
        mutationFn: (id) => api.delete(`/admin/sso/providers/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-sso-providers'] }); toast.success('Provider gelöscht'); },
        onError: (e) => toast.error(e.message),
    });
    if (showForm || editingProvider) {
        return (_jsx(ProviderForm, { provider: editingProvider, domains: domains, onSaved: () => { setShowForm(false); setEditingProvider(undefined); }, onCancel: () => { setShowForm(false); setEditingProvider(undefined); } }));
    }
    return (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: () => refetch(), className: "p-2 text-gray-500 border border-gray-300 rounded hover:bg-gray-50", children: _jsx(RefreshCw, { size: 13 }) }), _jsxs("button", { onClick: () => setShowForm(true), className: "flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90", children: [_jsx(Plus, { size: 14 }), " Provider hinzuf\u00FCgen"] })] }), providers.length === 0 ? (_jsxs("div", { className: "bg-white rounded-lg border border-gray-200 py-16 text-center", children: [_jsx(Fingerprint, { size: 28, className: "mx-auto text-gray-300 mb-3" }), _jsx("p", { className: "text-sm font-medium text-gray-500", children: "Keine SSO-Provider konfiguriert" }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: "F\u00FCge Azure AD, Google, Keycloak oder einen beliebigen OIDC-Provider hinzu" })] })) : (_jsx("div", { className: "space-y-3", children: providers.map(p => (_jsxs("div", { className: "bg-white rounded-lg border border-gray-200 p-4", children: [_jsxs("div", { className: "flex items-start justify-between", children: [_jsxs("div", { className: "flex items-start gap-3", children: [_jsx("div", { className: `w-8 h-8 rounded-lg flex items-center justify-center text-sm ${p.active ? 'bg-green-100' : 'bg-gray-100'}`, children: _jsx(Fingerprint, { size: 16, className: p.active ? 'text-green-600' : 'text-gray-400' }) }), _jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("p", { className: "text-sm font-semibold text-gray-900", children: p.name }), p.active
                                                            ? _jsx("span", { className: "text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full", children: "aktiv" })
                                                            : _jsx("span", { className: "text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full", children: "inaktiv" })] }), _jsxs("p", { className: "text-xs text-gray-500 mt-0.5", children: ["Domain: ", _jsx("span", { className: "font-medium", children: p.domainName })] }), _jsx("p", { className: "text-xs font-mono text-gray-400 mt-0.5 truncate max-w-[400px]", children: p.discoveryUrl })] })] }), _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("a", { href: p.discoveryUrl, target: "_blank", rel: "noopener noreferrer", className: "p-1.5 text-gray-400 hover:text-blue-600", title: "Discovery-URL \u00F6ffnen", children: _jsx(ExternalLink, { size: 13 }) }), _jsx("button", { onClick: () => setEditingProvider(p), className: "p-1.5 text-gray-400 hover:text-accent", title: "Bearbeiten", children: _jsx(Edit2, { size: 13 }) }), _jsx("button", { onClick: () => { if (confirm(`Provider „${p.name}" löschen?`))
                                                deleteMut.mutate(p.id); }, className: "p-1.5 text-gray-400 hover:text-red-500", title: "L\u00F6schen", children: _jsx(Trash2, { size: 13 }) })] })] }), _jsxs("div", { className: "mt-3 pt-3 border-t border-gray-100 flex gap-4 text-xs text-gray-500", children: [_jsxs("span", { children: ["Client ID: ", _jsx("code", { className: "font-mono text-gray-700", children: p.clientId })] }), _jsx("span", { children: p.autoProvision ? '✓ Auto-Provisionierung' : '✗ Kein Auto-Provisioning' })] })] }, p.id))) }))] }));
}
// ─── SAML Section ─────────────────────────────────────────────────────────────
function SamlSection() {
    return (_jsxs("div", { className: "space-y-4 max-w-2xl", children: [_jsxs("div", { className: "card p-5 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(ShieldCheck, { size: 18, className: "text-accent" }), _jsx("p", { className: "text-sm font-semibold text-gray-700", children: "SAML 2.0" })] }), _jsxs("p", { className: "text-sm text-gray-600 leading-relaxed", children: ["SAML 2.0 wird \u00FCber das ", _jsx("strong", { children: "auth-sso" }), "-Paket unterst\u00FCtzt. Die Konfiguration erfolgt \u00FCber Umgebungsvariablen im Container oder direkt im ", _jsx("code", { className: "bg-gray-100 px-1 rounded text-xs", children: "auth-sso" }), "-Service."] }), _jsx("div", { className: "space-y-2", children: [
                            { label: 'Service Provider Entity ID', value: 'https://mail.domain.de/auth/saml/metadata' },
                            { label: 'Assertion Consumer Service URL', value: 'https://mail.domain.de/auth/saml/callback' },
                            { label: 'Single Logout URL', value: 'https://mail.domain.de/auth/saml/logout' },
                            { label: 'Metadata', value: 'https://mail.domain.de/auth/saml/metadata.xml' },
                        ].map(row => (_jsxs("div", { className: "flex items-start gap-3 py-2 border-b border-gray-100 last:border-0", children: [_jsx("span", { className: "text-xs text-gray-500 w-48 shrink-0", children: row.label }), _jsx("code", { className: "text-xs font-mono text-gray-700 break-all", children: row.value })] }, row.label))) })] }), _jsxs("div", { className: "card p-5 space-y-3", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "Unterst\u00FCtzte Identity Provider" }), _jsx("div", { className: "grid grid-cols-2 gap-2", children: [
                            { name: 'Azure Active Directory / Entra ID', status: '✅' },
                            { name: 'Okta', status: '✅' },
                            { name: 'OneLogin', status: '✅' },
                            { name: 'ADFS (Active Directory Federation Services)', status: '✅' },
                            { name: 'Shibboleth', status: '✅' },
                            { name: 'G Suite / Google Workspace', status: '✅' },
                        ].map(idp => (_jsxs("div", { className: "flex items-center gap-2 text-sm text-gray-700 py-1", children: [_jsx("span", { children: idp.status }), idp.name] }, idp.name))) })] }), _jsxs("div", { className: "flex gap-2 bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-blue-700", children: [_jsx(Info, { size: 13, className: "shrink-0 mt-0.5" }), _jsxs("p", { children: ["Die SAML-Konfiguration f\u00FCr einen spezifischen Identity Provider erfolgt \u00FCber die Umgebungsvariablen", _jsx("code", { className: "bg-blue-100 px-1 rounded mx-1", children: "SAML_IDP_METADATA_URL" }), " oder", _jsx("code", { className: "bg-blue-100 px-1 rounded mx-1", children: "SAML_IDP_ENTRY_POINT" }), "in der ", _jsx("code", { className: "bg-blue-100 px-1 rounded", children: ".env" }), "-Datei. Ein GUI-Editor wird in einer zuk\u00FCnftigen Version erg\u00E4nzt."] })] })] }));
}
// ─── Settings Section ─────────────────────────────────────────────────────────
function SettingsSection() {
    return (_jsxs("div", { className: "space-y-4 max-w-2xl", children: [_jsxs("div", { className: "card p-5 space-y-4", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "Allgemeine SSO-Einstellungen" }), _jsx("p", { className: "text-xs text-gray-500", children: "Diese Einstellungen gelten global f\u00FCr alle konfigurierten SSO-Provider. Providerspezifische Optionen wie Auto-Provisionierung k\u00F6nnen pro Provider konfiguriert werden." }), _jsx("div", { className: "divide-y divide-gray-100", children: [
                            { label: 'Lokale Anmeldung als Fallback', desc: 'Benutzer können sich auch mit lokalem Passwort anmelden, wenn SSO nicht verfügbar ist', default: true },
                            { label: 'SSO-Login auf Login-Seite anzeigen', desc: 'Schaltfläche für SSO-Anmeldung auf der OWA/BCP-Loginseite einblenden', default: true },
                            { label: 'Automatische Weiterleitung', desc: 'Für Domains mit genau einem aktiven Provider automatisch zum IdP weiterleiten', default: false },
                        ].map(s => (_jsxs("div", { className: "flex items-start justify-between py-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-gray-800", children: s.label }), _jsx("p", { className: "text-xs text-gray-500 mt-0.5", children: s.desc })] }), _jsx(Toggle, { active: s.default, onToggle: () => { }, disabled: true })] }, s.label))) })] }), _jsxs("div", { className: "card p-5 space-y-3", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "Redirect-URIs" }), _jsx("p", { className: "text-xs text-gray-500", children: "Diese URIs m\u00FCssen beim Identity Provider als erlaubte Weiterleitungs-URLs eingetragen werden." }), _jsx("div", { className: "space-y-2", children: [
                            { label: 'OIDC Callback', uri: '/auth/oidc/callback' },
                            { label: 'SAML ACS', uri: '/auth/saml/callback' },
                            { label: 'Logout Redirect', uri: '/auth/logout' },
                        ].map(r => (_jsxs("div", { className: "flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0", children: [_jsx("span", { className: "text-xs text-gray-500 w-32", children: r.label }), _jsxs("code", { className: "text-xs font-mono text-gray-700 bg-gray-50 px-2 py-1 rounded flex-1", children: ["https://mail.domain.de", r.uri] })] }, r.label))) })] }), _jsxs("div", { className: "flex gap-2 bg-amber-50 border border-amber-100 rounded-lg p-3 text-xs text-amber-700", children: [_jsx(AlertCircle, { size: 13, className: "shrink-0 mt-0.5" }), _jsx("p", { children: "Die globalen SSO-Einstellungen werden in einer zuk\u00FCnftigen Version in der Datenbank gespeichert. Aktuell werden die Standardwerte verwendet; verwende Umgebungsvariablen f\u00FCr \u00C4nderungen." })] })] }));
}
// ─── Main Page ────────────────────────────────────────────────────────────────
export function SsoPage() {
    const [section, setSection] = useState('providers');
    return (_jsxs("div", { className: "h-full flex", children: [_jsxs("nav", { className: "w-44 shrink-0 bg-[#1e2433] flex flex-col py-4 gap-0.5", children: [_jsx("p", { className: "text-[10px] text-gray-500 uppercase tracking-widest px-4 pb-2", children: "Single Sign-On" }), SECTIONS.map(s => (_jsxs("button", { onClick: () => setSection(s.key), className: `flex items-center gap-2 px-4 py-2 text-sm text-left transition-colors ${section === s.key ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'}`, children: [s.icon, _jsx("span", { children: s.label })] }, s.key)))] }), _jsx("div", { className: "flex-1 overflow-y-auto", children: _jsxs("div", { className: "p-6 max-w-5xl", children: [_jsxs("div", { className: "flex items-center gap-3 mb-6", children: [_jsx(Fingerprint, { size: 20, className: "text-accent" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Single Sign-On (SSO)" }), _jsxs("p", { className: "text-xs text-gray-500", children: [SECTIONS.find(s => s.key === section)?.label, " \u00B7 OIDC / OAuth2 / SAML 2.0"] })] })] }), section === 'providers' && _jsx(ProvidersSection, {}), section === 'saml' && _jsx(SamlSection, {}), section === 'settings' && _jsx(SettingsSection, {})] }) })] }));
}
