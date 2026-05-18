import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * SSL/TLS Zertifikat-Verwaltung
 *
 * Listet alle Zertifikate, ermöglicht:
 * - Let's Encrypt (ACME HTTP-01) anfordern
 * - Eigenes Zertifikat hochladen (PEM)
 * - Selbstsigniertes Zertifikat generieren
 * - Zertifikat erneuern / löschen
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ShieldCheck, Plus, RefreshCw, Trash2, Upload, ChevronDown, ChevronUp, X, Loader2, AlertCircle, } from 'lucide-react';
import { api } from '../api/client.js';
// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function daysUntil(dateStr) {
    if (!dateStr)
        return null;
    return Math.floor((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}
function StatusBadge({ status, expiresAt }) {
    const days = daysUntil(expiresAt);
    const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold';
    if (status === 'ACTIVE')
        return _jsxs("span", { className: `${base} bg-green-100 text-green-700`, children: ["Aktiv", days !== null ? ` · ${days}d` : ''] });
    if (status === 'EXPIRING')
        return _jsxs("span", { className: `${base} bg-amber-100 text-amber-700`, children: ["L\u00E4uft ab \u00B7 ", days, "d"] });
    if (status === 'EXPIRED')
        return _jsx("span", { className: `${base} bg-red-100 text-red-700`, children: "Abgelaufen" });
    if (status === 'PENDING')
        return _jsxs("span", { className: `${base} bg-blue-100 text-blue-700`, children: [_jsx(Loader2, { size: 10, className: "animate-spin" }), " Ausstehend"] });
    if (status === 'RENEWING')
        return _jsxs("span", { className: `${base} bg-blue-100 text-blue-700`, children: [_jsx(Loader2, { size: 10, className: "animate-spin" }), " Erneuerung"] });
    if (status === 'ERROR')
        return _jsxs("span", { className: `${base} bg-red-100 text-red-700`, children: [_jsx(AlertCircle, { size: 10 }), " Fehler"] });
    return _jsx("span", { className: `${base} bg-gray-100 text-gray-600`, children: status });
}
function TypeBadge({ type }) {
    const base = 'px-2 py-0.5 rounded text-xs font-medium';
    if (type === 'LETSENCRYPT')
        return _jsx("span", { className: `${base} bg-purple-100 text-purple-700`, children: "Let's Encrypt" });
    if (type === 'CUSTOM')
        return _jsx("span", { className: `${base} bg-indigo-100 text-indigo-700`, children: "Eigenes" });
    return _jsx("span", { className: `${base} bg-gray-100 text-gray-600`, children: "Self-Signed" });
}
const ALL_SERVICES = ['OWA', 'BCP', 'SMTP', 'IMAP', 'POP3', 'EWS', 'CALDAV', 'AUTODISCOVER'];
function ServiceSelector({ selected, onChange, }) {
    function toggle(svc) {
        onChange(selected.includes(svc) ? selected.filter(s => s !== svc) : [...selected, svc]);
    }
    return (_jsx("div", { className: "flex flex-wrap gap-1.5", children: ALL_SERVICES.map(svc => (_jsx("button", { type: "button", onClick: () => toggle(svc), className: `px-2 py-1 rounded text-xs font-medium border transition-colors ${selected.includes(svc)
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'bg-white border-gray-300 text-gray-600 hover:border-blue-400'}`, children: svc }, svc))) }));
}
// ── Haupt-Komponente ──────────────────────────────────────────────────────────
export function CertificatesPage() {
    const qc = useQueryClient();
    const [modal, setModal] = useState(null);
    const [expandedId, setExpandedId] = useState(null);
    const { data: certs = [], isLoading } = useQuery({
        queryKey: ['admin-certificates'],
        queryFn: () => api.get('/admin/certificates'),
        refetchInterval: 10_000,
    });
    const renewMutation = useMutation({
        mutationFn: (id) => api.post(`/admin/certificates/${id}/renew`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-certificates'] }); toast.success('Erneuerung gestartet'); },
        onError: () => toast.error('Erneuerung fehlgeschlagen'),
    });
    const deleteMutation = useMutation({
        mutationFn: (id) => api.delete(`/admin/certificates/${id}`),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-certificates'] }); toast.success('Zertifikat gelöscht'); },
        onError: () => toast.error('Löschen fehlgeschlagen'),
    });
    function confirmDelete(cert) {
        if (!window.confirm(`Zertifikat "${cert.name}" wirklich löschen?`))
            return;
        deleteMutation.mutate(cert.id);
    }
    return (_jsxs("div", { className: "p-6 max-w-5xl mx-auto", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(ShieldCheck, { size: 22, className: "text-blue-600" }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-bold text-gray-900", children: "SSL/TLS Zertifikate" }), _jsxs("p", { className: "text-sm text-gray-500", children: [certs.length, " Zertifikat", certs.length !== 1 ? 'e' : ''] })] })] }), _jsxs("div", { className: "flex gap-2", children: [_jsxs("button", { onClick: () => setModal('selfsigned'), className: "flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors", children: [_jsx(Plus, { size: 14 }), " Self-Signed"] }), _jsxs("button", { onClick: () => setModal('upload'), className: "flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors", children: [_jsx(Upload, { size: 14 }), " Hochladen"] }), _jsxs("button", { onClick: () => setModal('letsencrypt'), className: "flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium", children: [_jsx(Plus, { size: 14 }), " Let's Encrypt"] })] })] }), _jsx("div", { className: "bg-white rounded-xl border border-gray-200 overflow-hidden", children: isLoading ? (_jsxs("div", { className: "flex items-center justify-center py-16 text-gray-400", children: [_jsx(Loader2, { size: 24, className: "animate-spin mr-2" }), " Lade Zertifikate\u2026"] })) : certs.length === 0 ? (_jsxs("div", { className: "text-center py-16 text-gray-400", children: [_jsx(ShieldCheck, { size: 32, className: "mx-auto mb-3 opacity-30" }), _jsx("p", { className: "text-sm", children: "Noch keine Zertifikate. Erstelle dein erstes Zertifikat." })] })) : (_jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Name / Domains" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Typ" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Status" }), _jsx("th", { className: "text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Services" }), _jsx("th", { className: "text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide", children: "Aktionen" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: certs.map(cert => (_jsxs(_Fragment, { children: [_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsx("td", { className: "px-4 py-3", children: _jsxs("div", { className: "flex items-start gap-2", children: [_jsx("button", { onClick: () => setExpandedId(expandedId === cert.id ? null : cert.id), className: "mt-0.5 text-gray-400 hover:text-gray-600 transition-colors shrink-0", children: expandedId === cert.id ? _jsx(ChevronUp, { size: 14 }) : _jsx(ChevronDown, { size: 14 }) }), _jsxs("div", { children: [_jsx("p", { className: "font-medium text-gray-900 text-sm", children: cert.name }), _jsxs("p", { className: "text-xs text-gray-400 mt-0.5", children: [cert.domains.slice(0, 2).join(', '), cert.domains.length > 2 ? ` +${cert.domains.length - 2}` : ''] })] })] }) }), _jsx("td", { className: "px-4 py-3", children: _jsx(TypeBadge, { type: cert.type }) }), _jsx("td", { className: "px-4 py-3", children: _jsx(StatusBadge, { status: cert.status, expiresAt: cert.expiresAt }) }), _jsx("td", { className: "px-4 py-3", children: _jsx("div", { className: "flex flex-wrap gap-1", children: cert.services.length === 0
                                                        ? _jsx("span", { className: "text-xs text-gray-400", children: "\u2013" })
                                                        : cert.services.map(s => (_jsx("span", { className: "px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-xs", children: s }, s))) }) }), _jsx("td", { className: "px-4 py-3 text-right", children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [cert.type === 'LETSENCRYPT' && (_jsx("button", { onClick: () => renewMutation.mutate(cert.id), disabled: cert.status === 'RENEWING', title: "Jetzt erneuern", className: "p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors disabled:opacity-40", children: _jsx(RefreshCw, { size: 14, className: cert.status === 'RENEWING' ? 'animate-spin' : '' }) })), _jsx("button", { onClick: () => confirmDelete(cert), title: "L\u00F6schen", className: "p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors", children: _jsx(Trash2, { size: 14 }) })] }) })] }, cert.id), expandedId === cert.id && (_jsx("tr", { className: "bg-blue-50/40", children: _jsx("td", { colSpan: 5, className: "px-4 py-3", children: _jsxs("div", { className: "grid grid-cols-2 gap-4 text-sm", children: [_jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-500 mb-1", children: "Alle Domains" }), _jsx("div", { className: "flex flex-wrap gap-1", children: cert.domains.map(d => (_jsx("span", { className: "px-2 py-0.5 bg-white border border-gray-200 rounded text-xs font-mono", children: d }, d))) })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-500", children: "Ausgestellt" }), _jsx("p", { className: "text-gray-700", children: cert.issuedAt ? new Date(cert.issuedAt).toLocaleDateString('de-DE') : '–' })] }), _jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-500", children: "L\u00E4uft ab" }), _jsx("p", { className: "text-gray-700", children: cert.expiresAt ? new Date(cert.expiresAt).toLocaleDateString('de-DE') : '–' })] }), _jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-500", children: "Auto-Renew" }), _jsx("p", { className: "text-gray-700", children: cert.autoRenew ? 'Ja' : 'Nein' })] }), cert.acmeEmail && (_jsxs("div", { children: [_jsx("p", { className: "text-xs text-gray-500", children: "ACME E-Mail" }), _jsx("p", { className: "text-gray-700", children: cert.acmeEmail })] }))] }), cert.lastError && (_jsx("div", { className: "col-span-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700 font-mono", children: cert.lastError }))] }) }) }, `${cert.id}-detail`))] }))) })] })) }), modal === 'letsencrypt' && _jsx(LetsEncryptModal, { onClose: () => setModal(null) }), modal === 'upload' && _jsx(UploadModal, { onClose: () => setModal(null) }), modal === 'selfsigned' && _jsx(SelfSignedModal, { onClose: () => setModal(null) })] }));
}
// ── Let's Encrypt Modal ───────────────────────────────────────────────────────
function LetsEncryptModal({ onClose }) {
    const qc = useQueryClient();
    const [name, setName] = useState('');
    const [domains, setDomains] = useState('');
    const [email, setEmail] = useState('');
    const [services, setServices] = useState([]);
    const [autoRenew, setAutoRenew] = useState(true);
    const [staging, setStaging] = useState(false);
    const mutation = useMutation({
        mutationFn: () => api.post('/admin/certificates/letsencrypt', {
            name,
            domains: domains.split('\n').map(d => d.trim()).filter(Boolean),
            email,
            services,
            autoRenew,
            staging,
        }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
            toast.success('Let\'s Encrypt Anfrage gestartet');
            onClose();
        },
        onError: () => toast.error('Anfrage fehlgeschlagen'),
    });
    return (_jsx(Modal, { title: "Let's Encrypt Zertifikat", onClose: onClose, children: _jsxs("div", { className: "space-y-4", children: [_jsx(Field, { label: "Name", children: _jsx("input", { value: name, onChange: e => setName(e.target.value), className: "input", placeholder: "z.B. mail.company.com" }) }), _jsx(Field, { label: "Domains (eine pro Zeile)", children: _jsx("textarea", { value: domains, onChange: e => setDomains(e.target.value), rows: 3, className: "input font-mono text-sm", placeholder: "mail.company.com\nautodiscover.company.com" }) }), _jsx(Field, { label: "E-Mail (f\u00FCr ACME-Konto)", children: _jsx("input", { type: "email", value: email, onChange: e => setEmail(e.target.value), className: "input", placeholder: "admin@company.com" }) }), _jsx(Field, { label: "Services", children: _jsx(ServiceSelector, { selected: services, onChange: setServices }) }), _jsxs("div", { className: "flex gap-6", children: [_jsxs("label", { className: "flex items-center gap-2 text-sm cursor-pointer select-none", children: [_jsx("input", { type: "checkbox", checked: autoRenew, onChange: e => setAutoRenew(e.target.checked), className: "rounded" }), "Auto-Renew (empfohlen)"] }), _jsxs("label", { className: "flex items-center gap-2 text-sm cursor-pointer select-none text-amber-700", children: [_jsx("input", { type: "checkbox", checked: staging, onChange: e => setStaging(e.target.checked), className: "rounded" }), "Staging-Umgebung (Test)"] })] }), _jsxs("p", { className: "text-xs text-gray-500 bg-blue-50 border border-blue-200 rounded p-2", children: [_jsx("strong", { children: "Voraussetzung:" }), " Port 80 muss \u00F6ffentlich erreichbar sein, damit Let's Encrypt den ACME HTTP-01 Challenge verifizieren kann."] }), _jsxs("div", { className: "flex justify-end gap-2 pt-2", children: [_jsx("button", { onClick: onClose, className: "btn-secondary", children: "Abbrechen" }), _jsxs("button", { onClick: () => mutation.mutate(), disabled: mutation.isPending || !name || !domains || !email, className: "btn-primary flex items-center gap-1.5", children: [mutation.isPending && _jsx(Loader2, { size: 14, className: "animate-spin" }), "Zertifikat anfordern"] })] })] }) }));
}
// ── Upload Modal ──────────────────────────────────────────────────────────────
function UploadModal({ onClose }) {
    const qc = useQueryClient();
    const [name, setName] = useState('');
    const [domains, setDomains] = useState('');
    const [services, setServices] = useState([]);
    const [certPem, setCertPem] = useState('');
    const [keyPem, setKeyPem] = useState('');
    const [chainPem, setChainPem] = useState('');
    const mutation = useMutation({
        mutationFn: () => api.post('/admin/certificates/upload', {
            name,
            domains: domains.split('\n').map(d => d.trim()).filter(Boolean),
            services,
            certPem,
            keyPem,
            ...(chainPem.trim() ? { chainPem } : {}),
        }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
            toast.success('Zertifikat hochgeladen');
            onClose();
        },
        onError: () => toast.error('Upload fehlgeschlagen — ungültiges PEM?'),
    });
    return (_jsx(Modal, { title: "Eigenes Zertifikat hochladen", onClose: onClose, children: _jsxs("div", { className: "space-y-4", children: [_jsx(Field, { label: "Name", children: _jsx("input", { value: name, onChange: e => setName(e.target.value), className: "input", placeholder: "z.B. Wildcard *.company.com" }) }), _jsx(Field, { label: "Domains (eine pro Zeile)", children: _jsx("textarea", { value: domains, onChange: e => setDomains(e.target.value), rows: 2, className: "input font-mono text-sm", placeholder: "mail.company.com" }) }), _jsx(Field, { label: "Services", children: _jsx(ServiceSelector, { selected: services, onChange: setServices }) }), _jsx(Field, { label: "Zertifikat (PEM)", children: _jsx("textarea", { value: certPem, onChange: e => setCertPem(e.target.value), rows: 5, className: "input font-mono text-xs", placeholder: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----" }) }), _jsx(Field, { label: "Privater Schl\u00FCssel (PEM)", children: _jsx("textarea", { value: keyPem, onChange: e => setKeyPem(e.target.value), rows: 5, className: "input font-mono text-xs", placeholder: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----" }) }), _jsx(Field, { label: "Zertifikatskette (optional, PEM)", children: _jsx("textarea", { value: chainPem, onChange: e => setChainPem(e.target.value), rows: 3, className: "input font-mono text-xs", placeholder: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----" }) }), _jsxs("div", { className: "flex justify-end gap-2 pt-2", children: [_jsx("button", { onClick: onClose, className: "btn-secondary", children: "Abbrechen" }), _jsxs("button", { onClick: () => mutation.mutate(), disabled: mutation.isPending || !name || !certPem || !keyPem, className: "btn-primary flex items-center gap-1.5", children: [mutation.isPending && _jsx(Loader2, { size: 14, className: "animate-spin" }), "Hochladen"] })] })] }) }));
}
// ── Self-Signed Modal ─────────────────────────────────────────────────────────
function SelfSignedModal({ onClose }) {
    const qc = useQueryClient();
    const [name, setName] = useState('');
    const [domains, setDomains] = useState('');
    const [services, setServices] = useState([]);
    const [days, setDays] = useState(365);
    const mutation = useMutation({
        mutationFn: () => api.post('/admin/certificates/self-signed', {
            name,
            domains: domains.split('\n').map(d => d.trim()).filter(Boolean),
            services,
            days,
        }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
            toast.success('Selbstsigniertes Zertifikat generiert');
            onClose();
        },
        onError: () => toast.error('Generierung fehlgeschlagen'),
    });
    return (_jsx(Modal, { title: "Selbstsigniertes Zertifikat generieren", onClose: onClose, children: _jsxs("div", { className: "space-y-4", children: [_jsx("p", { className: "text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2", children: "Selbstsignierte Zertifikate werden von Browsern nicht vertraut. Nur f\u00FCr interne Tests geeignet." }), _jsx(Field, { label: "Name", children: _jsx("input", { value: name, onChange: e => setName(e.target.value), className: "input", placeholder: "z.B. Intern-Test" }) }), _jsx(Field, { label: "Domains (eine pro Zeile)", children: _jsx("textarea", { value: domains, onChange: e => setDomains(e.target.value), rows: 2, className: "input font-mono text-sm", placeholder: "localhost" }) }), _jsx(Field, { label: "Services", children: _jsx(ServiceSelector, { selected: services, onChange: setServices }) }), _jsx(Field, { label: "G\u00FCltigkeit (Tage)", children: _jsx("input", { type: "number", value: days, onChange: e => setDays(Number(e.target.value)), min: 1, max: 3650, className: "input w-32" }) }), _jsxs("div", { className: "flex justify-end gap-2 pt-2", children: [_jsx("button", { onClick: onClose, className: "btn-secondary", children: "Abbrechen" }), _jsxs("button", { onClick: () => mutation.mutate(), disabled: mutation.isPending || !name || !domains, className: "btn-primary flex items-center gap-1.5", children: [mutation.isPending && _jsx(Loader2, { size: 14, className: "animate-spin" }), "Generieren"] })] })] }) }));
}
// ── UI-Helpers ────────────────────────────────────────────────────────────────
function Modal({ title, children, onClose }) {
    return (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4", children: _jsxs("div", { className: "bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto", children: [_jsxs("div", { className: "flex items-center justify-between px-5 py-4 border-b border-gray-200", children: [_jsx("h2", { className: "font-semibold text-gray-900", children: title }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-600 transition-colors", children: _jsx(X, { size: 18 }) })] }), _jsx("div", { className: "p-5", children: children })] }) }));
}
function Field({ label, children }) {
    return (_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: label }), children] }));
}
