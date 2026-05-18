import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Terminal, Package, MessageSquare, Clock, ArrowRightLeft, Network, Plus, Trash2, CheckCircle, Info, SendHorizonal, Loader2, XCircle, } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
const SUB_NAV = [
    { id: 'esmtp', label: 'ESMTP-Befehle', icon: Terminal },
    { id: 'delivery', label: 'Lokale Zustellung', icon: Package },
    { id: 'outgoing', label: 'Ausgehende Mail', icon: SendHorizonal },
    { id: 'banner', label: 'SMTP-Banner', icon: MessageSquare },
    { id: 'greylisting', label: 'Greylisting', icon: Clock },
    { id: 'relaying', label: 'Relaying', icon: ArrowRightLeft },
    { id: 'connection', label: 'Verbindung', icon: Network },
];
// ── Shared helpers ────────────────────────────────────────────────────────────
function SaveBtn({ onClick, pending }) {
    return (_jsx("button", { onClick: onClick, disabled: pending, className: "btn-primary text-sm disabled:opacity-50", children: pending ? 'Speichern…' : 'Speichern' }));
}
function ToggleRow({ label, desc, value, onChange, warn }) {
    return (_jsxs("div", { className: "flex items-start justify-between py-3 border-b border-gray-100 last:border-0", children: [_jsxs("div", { className: "flex-1 pr-6", children: [_jsx("p", { className: "text-sm font-medium text-gray-800", children: label }), desc && _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: desc }), warn && value === false && (_jsxs("p", { className: "text-xs text-amber-600 mt-0.5 flex items-center gap-1", children: [_jsx(Info, { size: 10 }), " ", warn] }))] }), _jsx(Toggle, { active: value, onToggle: () => onChange(!value) })] }));
}
function NumInput({ label, desc, value, onChange, min, max, unit }) {
    return (_jsxs("div", { className: "flex items-center justify-between py-3 border-b border-gray-100 last:border-0", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-medium text-gray-800", children: label }), desc && _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: desc })] }), _jsxs("div", { className: "flex items-center gap-2 shrink-0", children: [_jsx("input", { type: "number", min: min, max: max, value: value, onChange: e => onChange(parseInt(e.target.value, 10) || min), className: "w-24 border border-gray-300 rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-accent" }), unit && _jsx("span", { className: "text-xs text-gray-400 w-10", children: unit })] })] }));
}
const EXT_DEFS = [
    { key: 'extStarttls', label: 'STARTTLS', rfc: 'RFC 3207', risk: 'safe',
        desc: 'Verschlüsselung der SMTP-Verbindung via TLS aufwerten',
        warnOff: 'Deaktivieren senkt die Verbindungssicherheit erheblich' },
    { key: 'extAuthPlain', label: 'AUTH PLAIN', rfc: 'RFC 4616', risk: 'safe',
        desc: 'Anmeldung mit Base64-kodiertem Benutzernamen + Passwort (nur über TLS sicher)' },
    { key: 'extAuthLogin', label: 'AUTH LOGIN', rfc: 'RFC draft', risk: 'safe',
        desc: 'Legacy-Authentifizierungsmethode — von vielen älteren Mail-Clients verwendet' },
    { key: 'extAuthCramMd5', label: 'AUTH CRAM-MD5', rfc: 'RFC 2195', risk: 'caution',
        desc: 'Challenge-Response-Authentifizierung mit HMAC-MD5 (veraltet, MD5 gebrochen)' },
    { key: 'extPipelining', label: 'PIPELINING', rfc: 'RFC 2920', risk: 'safe',
        desc: 'Mehrere SMTP-Befehle in einem TCP-Paket senden — beschleunigt Verbindungen' },
    { key: 'extSize', label: 'SIZE', rfc: 'RFC 1870', risk: 'safe',
        desc: 'Maximale Nachrichtengröße im EHLO-Greeting ankündigen' },
    { key: 'ext8bitmime', label: '8BITMIME', rfc: 'RFC 6152', risk: 'safe',
        desc: '8-Bit-Daten in SMTP-Nachrichten ohne MIME-Encoding erlauben' },
    { key: 'extEnhancedStatus', label: 'ENHANCEDSTATUSCODES', rfc: 'RFC 2034', risk: 'safe',
        desc: 'Erweiterte SMTP-Statuscodes (z.B. 5.7.1) für bessere Fehlerdiagnose' },
    { key: 'extSmtputf8', label: 'SMTPUTF8', rfc: 'RFC 6531', risk: 'advanced',
        desc: 'Internationalisierte E-Mail-Adressen (UTF-8 in Envelope/Header)' },
    { key: 'extDsn', label: 'DSN', rfc: 'RFC 3461', risk: 'safe',
        desc: 'Delivery Status Notifications — Zustellbenachrichtigungen anfordern' },
    { key: 'extChunking', label: 'CHUNKING (BDAT)', rfc: 'RFC 3030', risk: 'advanced',
        desc: 'Nachrichten in Chunks übertragen (BDAT-Befehl) anstatt DATA' },
];
const RISK_BADGE = {
    safe: 'bg-green-100 text-green-700',
    caution: 'bg-amber-100 text-amber-700',
    advanced: 'bg-purple-100 text-purple-700',
};
const RISK_LABEL = {
    safe: 'Standard', caution: 'Vorsicht', advanced: 'Erweitert',
};
// ═════════════════════════════════════════════════════════════════════════════
// EsmtpSection
// ═════════════════════════════════════════════════════════════════════════════
function EsmtpSection({ s, onSave, pending }) {
    const [vals, setVals] = useState({});
    function get(key) {
        return (key in vals ? vals[key] : s[key]);
    }
    function set(key, v) {
        setVals(prev => ({ ...prev, [key]: v }));
    }
    const changed = Object.keys(vals);
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "ESMTP-Erweiterungen" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: "Steuert welche EHLO-Capabilities der SMTP-Server ank\u00FCndigt und akzeptiert" })] }), _jsxs("div", { className: "flex items-center gap-3", children: [changed.length > 0 && (_jsxs("span", { className: "text-xs text-amber-600", children: [changed.length, " \u00C4nderung", changed.length > 1 ? 'en' : ''] })), _jsx(SaveBtn, { onClick: () => onSave(vals), pending: pending })] })] }), _jsx("div", { className: "flex gap-3 text-xs flex-wrap", children: ['safe', 'caution', 'advanced'].map(r => (_jsx("span", { className: `px-2 py-0.5 rounded-full font-medium ${RISK_BADGE[r]}`, children: RISK_LABEL[r] }, r))) }), _jsx("div", { className: "card overflow-hidden", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-2.5 text-xs font-semibold text-gray-500", children: "Erweiterung" }), _jsx("th", { className: "text-left px-4 py-2.5 text-xs font-semibold text-gray-500", children: "RFC" }), _jsx("th", { className: "text-left px-4 py-2.5 text-xs font-semibold text-gray-500 hidden lg:table-cell", children: "Beschreibung" }), _jsx("th", { className: "text-center px-4 py-2.5 text-xs font-semibold text-gray-500", children: "Typ" }), _jsx("th", { className: "text-center px-4 py-2.5 text-xs font-semibold text-gray-500", children: "Aktiv" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: EXT_DEFS.map(ext => {
                                const active = get(ext.key);
                                const modified = ext.key in vals;
                                return (_jsxs("tr", { className: `hover:bg-gray-50 transition-colors ${modified ? 'bg-accent/5' : ''}`, children: [_jsxs("td", { className: "px-4 py-2.5", children: [_jsx("span", { className: "font-mono text-xs font-semibold text-gray-800", children: ext.label }), ext.warnOff && !active && (_jsxs("p", { className: "text-[10px] text-amber-600 mt-0.5 flex items-center gap-0.5", children: [_jsx(Info, { size: 9 }), " ", ext.warnOff] }))] }), _jsx("td", { className: "px-4 py-2.5 text-xs text-gray-400 font-mono", children: ext.rfc }), _jsx("td", { className: "px-4 py-2.5 text-xs text-gray-500 hidden lg:table-cell max-w-xs", children: ext.desc }), _jsx("td", { className: "px-4 py-2.5 text-center", children: _jsx("span", { className: `text-[10px] font-medium px-2 py-0.5 rounded-full ${RISK_BADGE[ext.risk]}`, children: RISK_LABEL[ext.risk] }) }), _jsx("td", { className: "px-4 py-2.5 text-center", children: _jsx(Toggle, { active: active, onToggle: () => set(ext.key, !active) }) })] }, ext.key));
                            }) })] }) }), _jsxs("div", { className: "bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-xs text-blue-700 flex items-start gap-2", children: [_jsx(Info, { size: 13, className: "shrink-0 mt-0.5" }), _jsx("span", { children: "\u00C4nderungen werden in der Datenbank gespeichert und beim n\u00E4chsten SMTP-Server-Neustart aktiv. Die deaktivierten Erweiterungen erscheinen nicht mehr im EHLO-Response." })] })] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// DeliverySection
// ═════════════════════════════════════════════════════════════════════════════
function DeliverySection({ s, onSave, pending }) {
    const [enabled, setEnabled] = useState(s.localDeliveryEnabled);
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Lokale Zustellung" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: "Steuert ob der Server eingehende Nachrichten f\u00FCr lokale Postf\u00E4cher annimmt" })] }), _jsx(SaveBtn, { onClick: () => onSave({ localDeliveryEnabled: enabled }), pending: pending })] }), _jsx("div", { className: "card p-5 space-y-0", children: _jsx(ToggleRow, { label: "Lokale Zustellung aktiviert", desc: "E-Mails an lokal konfigurierte Domains und Postf\u00E4cher werden angenommen und zugestellt", value: enabled, onChange: setEnabled, warn: "Ohne lokale Zustellung werden keine eingehenden Nachrichten angenommen" }) }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { className: `card p-4 border-2 transition-colors ${enabled ? 'border-green-200 bg-green-50/30' : 'border-gray-200'}`, children: [_jsxs("div", { className: "flex items-center gap-2 mb-2", children: [_jsx(CheckCircle, { size: 15, className: enabled ? 'text-green-500' : 'text-gray-300' }), _jsx("span", { className: "text-sm font-semibold text-gray-800", children: "Aktiviert" })] }), _jsxs("ul", { className: "space-y-1 text-xs text-gray-500", children: [_jsx("li", { children: "\u2022 Empf\u00E4nger werden gegen lokale Postf\u00E4cher gepr\u00FCft" }), _jsx("li", { children: "\u2022 Verteilergruppen werden aufgel\u00F6st" }), _jsx("li", { children: "\u2022 Ressourcenpostf\u00E4cher (R\u00E4ume) akzeptiert" }), _jsx("li", { children: "\u2022 Shared Mailboxes erreichbar" })] })] }), _jsxs("div", { className: `card p-4 border-2 transition-colors ${!enabled ? 'border-amber-200 bg-amber-50/30' : 'border-gray-200'}`, children: [_jsxs("div", { className: "flex items-center gap-2 mb-2", children: [_jsx(Info, { size: 15, className: !enabled ? 'text-amber-500' : 'text-gray-300' }), _jsx("span", { className: "text-sm font-semibold text-gray-800", children: "Deaktiviert" })] }), _jsxs("ul", { className: "space-y-1 text-xs text-gray-500", children: [_jsx("li", { children: "\u2022 Alle RCPT TO-Befehle werden abgelehnt" }), _jsx("li", { children: "\u2022 Server agiert als reiner Relay-Knoten" }), _jsx("li", { children: "\u2022 N\u00FCtzlich f\u00FCr reine Outbound-Server" }), _jsx("li", { children: "\u2022 Kein lokaler Postfachspeicher n\u00F6tig" })] })] })] })] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// BannerSection
// ═════════════════════════════════════════════════════════════════════════════
function BannerSection({ s, onSave, pending }) {
    const [override, setOverride] = useState(s.bannerOverride);
    const [text, setText] = useState(s.bannerText);
    const defaultBanner = `${window.location.hostname} CoreMail ESMTP`;
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "SMTP-Banner" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: "Der Begr\u00FC\u00DFungstext den der SMTP-Server bei jeder Verbindung sendet (220-Response)" })] }), _jsx(SaveBtn, { onClick: () => onSave({ bannerOverride: override, bannerText: text }), pending: pending })] }), _jsx("div", { className: "card p-5 space-y-0", children: _jsx(ToggleRow, { label: "Standard-Banner \u00FCberschreiben", desc: "Benutzerdefinierten Begr\u00FC\u00DFungstext anstelle des Standard-Banners verwenden", value: override, onChange: setOverride }) }), _jsxs("div", { className: "card p-5 space-y-4", children: [_jsxs("div", { children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2", children: override ? 'Benutzerdefinierter Banner' : 'Standard-Banner (aktiv)' }), override ? (_jsx("textarea", { value: text, onChange: e => setText(e.target.value.slice(0, 255)), rows: 2, placeholder: "z.B. mail.example.com ESMTP", className: "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent resize-none" })) : (_jsx("div", { className: "bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 font-mono text-sm text-gray-600", children: defaultBanner })), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: override ? `${text.length}/255 Zeichen` : 'Hostname + "CoreMail ESMTP"' })] }), _jsxs("div", { children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2", children: "Vorschau \u2014 SMTP-Verbindung" }), _jsxs("div", { className: "bg-gray-900 rounded-lg p-4 font-mono text-xs space-y-1", children: [_jsx("p", { className: "text-gray-400", children: '# telnet mail.example.com 25' }), _jsxs("p", { className: "text-green-400", children: ['220 ', _jsx("span", { className: "text-white", children: override && text ? text : defaultBanner })] }), _jsx("p", { className: "text-gray-400", children: 'EHLO client.example.com' }), _jsx("p", { className: "text-green-400", children: '250-mail.example.com' }), _jsx("p", { className: "text-green-400", children: '250-STARTTLS' }), _jsx("p", { className: "text-green-400", children: '250-AUTH PLAIN LOGIN' }), _jsx("p", { className: "text-green-400", children: '250 SIZE 26214400' })] })] }), _jsxs("div", { className: "bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700 flex items-start gap-2", children: [_jsx(Info, { size: 12, className: "shrink-0 mt-0.5" }), _jsx("span", { children: "Der Banner sollte keine detaillierten Software-Versionsinformationen enthalten (Security through obscurity). RFC 5321 verlangt, dass der Hostname im Banner erscheint." })] })] })] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// GreylistingSection
// ═════════════════════════════════════════════════════════════════════════════
function GreylistingSection({ s, onSave, pending }) {
    const [enabled, setEnabled] = useState(s.greylistingEnabled);
    const [wait, setWait] = useState(s.greylistWaitSec);
    const [ttl, setTtl] = useState(s.greylistTtlHours);
    const [whitelist, setWhitelist] = useState(s.greylistWhitelist);
    const [newEntry, setNewEntry] = useState('');
    function addEntry() {
        const e = newEntry.trim();
        if (!e || whitelist.includes(e)) {
            setNewEntry('');
            return;
        }
        setWhitelist(prev => [...prev, e]);
        setNewEntry('');
    }
    const waitMin = Math.round(wait / 60);
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Greylisting" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: "Tempor\u00E4res Abweisen unbekannter Absender beim ersten Verbindungsversuch" })] }), _jsx(SaveBtn, { onClick: () => onSave({ greylistingEnabled: enabled, greylistWaitSec: wait, greylistTtlHours: ttl, greylistWhitelist: whitelist }), pending: pending })] }), _jsxs("div", { className: "card p-5 space-y-0", children: [_jsx(ToggleRow, { label: "Greylisting aktiviert", desc: "Erstverbindungen werden mit SMTP 451 tempor\u00E4r abgelehnt \u2014 legitime Server versuchen es erneut", value: enabled, onChange: setEnabled }), _jsx(NumInput, { label: "Wartezeit", desc: "Mindestwartezeit bevor ein Wiederholungsversuch akzeptiert wird", value: wait, onChange: setWait, min: 60, max: 3600, unit: "Sek" }), _jsx(NumInput, { label: "Whitelist-TTL", desc: "Wie lange ein bekanntes Triplet (IP/Absender/Empf\u00E4nger) in der Whitelist verbleibt", value: ttl, onChange: setTtl, min: 1, max: 168, unit: "Std" })] }), _jsx("div", { className: "grid grid-cols-3 gap-3", children: [
                    { label: 'Wartezeit', value: `${waitMin} Min`, sub: `${wait} Sek` },
                    { label: 'Whitelist-TTL', value: `${ttl} Std`, sub: 'nach erstem Durchgang' },
                    { label: 'Protokoll', value: 'SMTP 451', sub: 'Temp. Fehler' },
                ].map(c => (_jsxs("div", { className: "card p-3 text-center", children: [_jsx("p", { className: "text-lg font-bold text-gray-900", children: c.value }), _jsx("p", { className: "text-xs text-gray-400", children: c.label }), _jsx("p", { className: "text-[10px] text-gray-300 mt-0.5", children: c.sub })] }, c.label))) }), _jsxs("div", { className: "card p-4 space-y-3", children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "Ablauf" }), _jsx("div", { className: "flex items-start gap-3", children: [
                            { step: '1', label: 'Erstversuch', color: 'bg-red-100 text-red-700', desc: `SMTP-Server antwortet: "451 4.7.1 Greylisted — try again in ${waitMin} min"` },
                            { step: '2', label: `Nach ${waitMin} Min`, color: 'bg-amber-100 text-amber-700', desc: 'Legitimer Mailserver wiederholt den Versuch automatisch' },
                            { step: '3', label: 'Akzeptiert', color: 'bg-green-100 text-green-700', desc: `Triplet wird ${ttl}h whitegelistet — alle weiteren Versuche sofort akzeptiert` },
                        ].map((item, i) => (_jsxs("div", { className: "flex-1 flex flex-col items-center text-center", children: [_jsx("div", { className: `w-8 h-8 rounded-full ${item.color} flex items-center justify-center font-bold text-sm mb-1`, children: item.step }), _jsx("p", { className: "text-xs font-semibold text-gray-700 mb-1", children: item.label }), _jsx("p", { className: "text-[10px] text-gray-400 leading-relaxed", children: item.desc }), i < 2 && (_jsx("div", { className: "absolute right-0 top-3 text-gray-300", children: "\u2192" }))] }, i))) })] }), _jsxs("div", { className: "card p-4 space-y-3", children: [_jsxs("p", { className: "text-sm font-semibold text-gray-700", children: ["Greylisting-Whitelist", _jsx("span", { className: "text-xs font-normal text-gray-400 ml-2", children: "IPs / CIDR / Hostnamen die nie gegreylistet werden" })] }), whitelist.length === 0 && (_jsx("p", { className: "text-xs text-gray-400 italic", children: "Keine Eintr\u00E4ge \u2014 alle unbekannten Absender werden gegreylistet" })), _jsx("div", { className: "space-y-1.5", children: whitelist.map(e => (_jsxs("div", { className: "flex items-center justify-between bg-gray-50 rounded px-3 py-1.5", children: [_jsx("span", { className: "text-sm font-mono text-gray-700", children: e }), _jsx("button", { onClick: () => setWhitelist(prev => prev.filter(x => x !== e)), className: "text-gray-400 hover:text-red-500 transition-colors", children: _jsx(Trash2, { size: 13 }) })] }, e))) }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { value: newEntry, onChange: e => setNewEntry(e.target.value), onKeyDown: e => e.key === 'Enter' && addEntry(), placeholder: "z.B. 192.168.1.0/24 oder mx.google.com", className: "flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" }), _jsxs("button", { onClick: addEntry, className: "btn-secondary text-sm gap-1", children: [_jsx(Plus, { size: 13 }), " Hinzuf\u00FCgen"] })] }), _jsxs("div", { className: "flex flex-wrap gap-1.5 pt-1 border-t border-gray-100", children: [_jsx("p", { className: "w-full text-xs text-gray-400 mb-0.5", children: "Schnell hinzuf\u00FCgen:" }), ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].filter(e => !whitelist.includes(e)).map(e => (_jsxs("button", { onClick: () => setWhitelist(prev => [...prev, e]), className: "text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-0.5 rounded font-mono transition-colors", children: ["+ ", e] }, e)))] })] })] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// RelayingSection
// ═════════════════════════════════════════════════════════════════════════════
function RelayingSection({ s, onSave, pending }) {
    const [enabled, setEnabled] = useState(s.relayingEnabled);
    const [requireAuth, setRequireAuth] = useState(s.relayRequireAuth);
    const [domains, setDomains] = useState(s.relayDomains);
    const [trustedIps, setTrustedIps] = useState(s.relayTrustedIps);
    const [newDomain, setNewDomain] = useState('');
    const [newIp, setNewIp] = useState('');
    function add(list, setList, val) {
        const e = val.trim().toLowerCase();
        if (!e || list.includes(e))
            return;
        setList([...list, e]);
    }
    function save() {
        onSave({ relayingEnabled: enabled, relayRequireAuth: requireAuth, relayDomains: domains, relayTrustedIps: trustedIps });
    }
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Relaying \u2014 Weiterleitung" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: "Konfiguriert f\u00FCr welche fremden Domains E-Mails weitergeleitet werden" })] }), _jsx(SaveBtn, { onClick: save, pending: pending })] }), !enabled && (_jsxs("div", { className: "bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700 flex items-center gap-2", children: [_jsx(CheckCircle, { size: 15 }), _jsxs("span", { children: [_jsx("strong", { children: "Open Relay deaktiviert" }), " \u2014 E-Mails werden nur f\u00FCr lokale Domains angenommen. Empfohlene Einstellung."] })] })), enabled && (_jsxs("div", { className: "bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700 flex items-start gap-2", children: [_jsx(Info, { size: 15, className: "shrink-0 mt-0.5" }), _jsxs("span", { children: [_jsx("strong", { children: "Relay aktiv" }), " \u2014 Stellen Sie sicher, dass Relay nur f\u00FCr autorisierte Absender/Domains erlaubt ist um Open-Relay-Missbrauch zu verhindern."] })] })), _jsxs("div", { className: "card p-5 space-y-0", children: [_jsx(ToggleRow, { label: "Relaying aktiviert", desc: "E-Mails f\u00FCr Domains au\u00DFerhalb des lokalen Systems weiterleiten", value: enabled, onChange: setEnabled }), enabled && (_jsx(ToggleRow, { label: "Authentifizierung erforderlich", desc: "Relay nur f\u00FCr authentifizierte SMTP-Sessions erlauben (AUTH-Befehl)", value: requireAuth, onChange: setRequireAuth }))] }), enabled && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "card p-4 space-y-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "Relay-Domains" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: "F\u00FCr diese Domains werden eingehende Nachrichten weitergeleitet (leer = kein Domain-Relay)" })] }), domains.length === 0 && (_jsx("p", { className: "text-xs text-gray-400 italic", children: "Keine Relay-Domains konfiguriert" })), _jsx("div", { className: "flex flex-wrap gap-1.5", children: domains.map(d => (_jsxs("span", { className: "flex items-center gap-1 bg-blue-50 border border-blue-200 text-blue-700 text-xs px-2 py-0.5 rounded-full font-mono", children: [d, _jsx("button", { onClick: () => setDomains(prev => prev.filter(x => x !== d)), className: "hover:text-red-600 ml-0.5", children: "\u00D7" })] }, d))) }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { value: newDomain, onChange: e => setNewDomain(e.target.value), onKeyDown: e => { if (e.key === 'Enter') {
                                            add(domains, setDomains, newDomain);
                                            setNewDomain('');
                                        } }, placeholder: "z.B. example.com", className: "flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" }), _jsxs("button", { onClick: () => { add(domains, setDomains, newDomain); setNewDomain(''); }, className: "btn-secondary text-sm gap-1", children: [_jsx(Plus, { size: 13 }), " Hinzuf\u00FCgen"] })] })] }), _jsxs("div", { className: "card p-4 space-y-3", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold text-gray-700", children: "Vertrauensw\u00FCrdige IPs (Relay ohne Auth)" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: "Diese IP-Adressen/CIDR-Ranges d\u00FCrfen ohne Authentifizierung weiterleiten" })] }), trustedIps.length === 0 && (_jsx("p", { className: "text-xs text-gray-400 italic", children: "Keine vertrauensw\u00FCrdigen IPs \u2014 Relay nur via AUTH" })), _jsx("div", { className: "space-y-1.5", children: trustedIps.map(ip => (_jsxs("div", { className: "flex items-center justify-between bg-gray-50 rounded px-3 py-1.5", children: [_jsx("span", { className: "text-sm font-mono text-gray-700", children: ip }), _jsx("button", { onClick: () => setTrustedIps(prev => prev.filter(x => x !== ip)), className: "text-gray-400 hover:text-red-500 transition-colors", children: _jsx(Trash2, { size: 13 }) })] }, ip))) }), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { value: newIp, onChange: e => setNewIp(e.target.value), onKeyDown: e => { if (e.key === 'Enter') {
                                            add(trustedIps, setTrustedIps, newIp);
                                            setNewIp('');
                                        } }, placeholder: "z.B. 10.0.0.0/8", className: "flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" }), _jsxs("button", { onClick: () => { add(trustedIps, setTrustedIps, newIp); setNewIp(''); }, className: "btn-secondary text-sm gap-1", children: [_jsx(Plus, { size: 13 }), " Hinzuf\u00FCgen"] })] }), _jsxs("div", { className: "flex flex-wrap gap-1.5 pt-1 border-t border-gray-100", children: [_jsx("p", { className: "w-full text-xs text-gray-400 mb-0.5", children: "Lokale Netze:" }), ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].filter(e => !trustedIps.includes(e)).map(e => (_jsxs("button", { onClick: () => setTrustedIps(prev => [...prev, e]), className: "text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-0.5 rounded font-mono transition-colors", children: ["+ ", e] }, e)))] })] })] }))] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// OutgoingSection — Ausgehende Zustellung: MX direkt oder Smarthost
// ═════════════════════════════════════════════════════════════════════════════
function OutgoingSection({ s, onSave, pending }) {
    const [mode, setMode] = useState(s.outboundMode ?? 'mx');
    const [host, setHost] = useState(s.smarthostHost ?? '');
    const [port, setPort] = useState(s.smarthostPort ?? 587);
    const [tls, setTls] = useState(s.smarthostTls ?? true);
    const [implicitTls, setImplicitTls] = useState(s.smarthostImplicitTls ?? false);
    const [username, setUsername] = useState(s.smarthostUsername ?? '');
    const [password, setPassword] = useState(''); // nie vorausgefüllt (Sicherheit)
    const [filterEnabled, setFilterEnabled] = useState(s.outboundFilterEnabled ?? true);
    const [testStatus, setTestStatus] = useState('idle');
    const [testMsg, setTestMsg] = useState('');
    // Implizites TLS → STARTTLS deaktivieren (gegenseitig exklusiv)
    function handleImplicitTls(v) {
        setImplicitTls(v);
        if (v)
            setTls(false);
    }
    function handleStarttls(v) {
        setTls(v);
        if (v)
            setImplicitTls(false);
    }
    // Port-Vorschläge je nach TLS-Modus
    const PORT_PRESETS = [
        { label: '25 – SMTP', port: 25 },
        { label: '587 – Submission', port: 587 },
        { label: '465 – SMTPS', port: 465 },
        { label: '2525 – Alt', port: 2525 },
    ];
    async function testConnection() {
        setTestStatus('testing');
        setTestMsg('');
        try {
            const res = await fetch('/api/v1/admin/smtp-config/test-smarthost', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('accessToken') ?? ''}` },
                body: JSON.stringify({ host, port, tls, implicitTls, username, password: password || undefined }),
            });
            const data = await res.json();
            setTestStatus(data.ok ? 'ok' : 'err');
            setTestMsg(data.message);
        }
        catch {
            setTestStatus('err');
            setTestMsg('Verbindungstest fehlgeschlagen');
        }
    }
    function handleSave() {
        const payload = {
            outboundMode: mode,
            smarthostHost: host,
            smarthostPort: port,
            smarthostTls: tls,
            smarthostImplicitTls: implicitTls,
            smarthostUsername: username,
            outboundFilterEnabled: filterEnabled,
        };
        if (password)
            payload.smarthostPassword = password;
        onSave(payload);
    }
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Ausgehende Zustellung" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: "Wie CoreMail ausgehende E-Mails an externe Empf\u00E4nger zustellt" })] }), _jsx(SaveBtn, { onClick: handleSave, pending: pending })] }), _jsx("div", { className: "grid grid-cols-2 gap-3", children: [
                    {
                        value: 'mx',
                        label: 'Direkte MX-Zustellung',
                        desc: 'CoreMail fragt den DNS-MX-Record des Empfängers ab und stellt direkt an dessen Mailserver zu. Standard für öffentliche Mailserver.',
                        icon: '🌐',
                    },
                    {
                        value: 'smarthost',
                        label: 'Smarthost / Relay',
                        desc: 'Alle ausgehenden Mails werden über einen zentralen Relay-Server gesendet. Ideal wenn der ISP Port 25 sperrt oder ein externer SMTP-Dienst (Mailjet, Sendgrid, …) genutzt wird.',
                        icon: '🔀',
                    },
                ].map(opt => (_jsxs("button", { onClick: () => setMode(opt.value), className: `text-left p-4 rounded-lg border-2 transition-all ${mode === opt.value
                        ? 'border-accent bg-accent/5'
                        : 'border-gray-200 hover:border-gray-300 bg-white'}`, children: [_jsxs("div", { className: "flex items-center gap-2 mb-1.5", children: [_jsx("span", { className: "text-xl", children: opt.icon }), _jsx("span", { className: "font-semibold text-sm text-gray-800", children: opt.label }), mode === opt.value && (_jsx(CheckCircle, { size: 14, className: "ml-auto text-accent" }))] }), _jsx("p", { className: "text-xs text-gray-500 leading-relaxed", children: opt.desc })] }, opt.value))) }), mode === 'mx' && (_jsxs("div", { className: "bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-xs text-green-800 flex items-start gap-2", children: [_jsx(CheckCircle, { size: 13, className: "shrink-0 mt-0.5 text-green-600" }), _jsxs("div", { children: [_jsx("span", { className: "font-semibold", children: "Direkte MX-Zustellung aktiv" }), _jsx("p", { className: "mt-0.5 text-green-700", children: "CoreMail stellt Mails direkt an den Ziel-Mailserver zu. Stelle sicher, dass Port 25 ausgehend von deinem Server nicht geblockt ist und ein g\u00FCltiger PTR-/DMARC-Record gesetzt ist." })] })] })), _jsxs("div", { className: "card p-5 space-y-0", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-3 border-b border-gray-100", children: "Sicherheitsfilter" }), _jsx(ToggleRow, { label: "Spam-/Virenfilter vor Weiterleitung anwenden", desc: "Ausgehende Mails werden vor dem Versand durch rspamd (Anti-Spam) und ClamAV (Antivirus) gepr\u00FCft. Empfohlen um sicherzustellen, dass kein infizierter oder als Spam eingestufter Inhalt versendet wird.", value: filterEnabled, onChange: setFilterEnabled })] }), mode === 'smarthost' && (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "card p-5 space-y-4", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-2", children: "Verbindung" }), _jsxs("div", { className: "grid grid-cols-3 gap-3", children: [_jsxs("div", { className: "col-span-2", children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "Smarthost / Relay-Server" }), _jsx("input", { value: host, onChange: e => setHost(e.target.value), placeholder: "z.B. smtp.sendgrid.net", className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "Port" }), _jsx("input", { type: "number", min: 1, max: 65535, value: port, onChange: e => setPort(parseInt(e.target.value, 10) || 587), className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm text-right font-mono focus:outline-none focus:ring-1 focus:ring-accent" })] })] }), _jsxs("div", { className: "flex flex-wrap gap-1.5", children: [_jsx("span", { className: "text-xs text-gray-400 self-center", children: "Schnell:" }), PORT_PRESETS.map(p => (_jsx("button", { onClick: () => {
                                            setPort(p.port);
                                            if (p.port === 465) {
                                                setImplicitTls(true);
                                                setTls(false);
                                            }
                                            else if (p.port === 587) {
                                                setTls(true);
                                                setImplicitTls(false);
                                            }
                                            else {
                                                setTls(false);
                                                setImplicitTls(false);
                                            }
                                        }, className: `text-xs px-2 py-0.5 rounded font-mono border transition-colors ${port === p.port
                                            ? 'bg-accent text-white border-accent'
                                            : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`, children: p.label }, p.port)))] })] }), _jsxs("div", { className: "card p-5 space-y-0", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-3 border-b border-gray-100", children: "TLS-Verschl\u00FCsselung" }), _jsx(ToggleRow, { label: "STARTTLS (opportunistisch)", desc: "Verbindung beginnt als Plaintext und wird per STARTTLS auf TLS aufgewertet \u2014 Standard f\u00FCr Port 587", value: tls, onChange: handleStarttls }), _jsx(ToggleRow, { label: "Implizites TLS (SMTPS)", desc: "Verbindung startet sofort als TLS \u2014 Standard f\u00FCr Port 465; deaktiviert STARTTLS", value: implicitTls, onChange: handleImplicitTls })] }), _jsxs("div", { className: "card p-5 space-y-4", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-100 pb-2", children: "Authentifizierung (optional)" }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: "Benutzername" }), _jsx("input", { value: username, onChange: e => setUsername(e.target.value), placeholder: "z.B. apikey oder user@domain.de", autoComplete: "off", className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" })] }), _jsxs("div", { children: [_jsxs("label", { className: "block text-xs font-medium text-gray-600 mb-1", children: ["Passwort", s.smarthostPassword === '••••••••' && (_jsx("span", { className: "ml-1.5 text-gray-400 font-normal", children: "(gespeichert \u2014 leer lassen um beizubehalten)" }))] }), _jsx("input", { type: "password", value: password, onChange: e => setPassword(e.target.value), placeholder: s.smarthostPassword === '••••••••' ? '••••••••' : 'Kein Passwort gesetzt', autoComplete: "new-password", className: "w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" })] })] })] }), _jsxs("div", { className: "card p-4", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("button", { onClick: testConnection, disabled: !host || testStatus === 'testing', className: "btn-secondary text-sm gap-2 disabled:opacity-50", children: testStatus === 'testing'
                                            ? _jsxs(_Fragment, { children: [_jsx(Loader2, { size: 13, className: "animate-spin" }), " Verbinde\u2026"] })
                                            : _jsxs(_Fragment, { children: [_jsx(SendHorizonal, { size: 13 }), " Verbindung testen"] }) }), testStatus === 'ok' && (_jsxs("span", { className: "flex items-center gap-1.5 text-sm text-green-700", children: [_jsx(CheckCircle, { size: 14 }), " ", testMsg] })), testStatus === 'err' && (_jsxs("span", { className: "flex items-center gap-1.5 text-sm text-red-600", children: [_jsx(XCircle, { size: 14 }), " ", testMsg] }))] }), _jsx("p", { className: "text-xs text-gray-400 mt-2", children: "Testet die SMTP-Verbindung ohne E-Mails zu senden. Verwendete Einstellungen: aktueller Formularinhalt (noch nicht gespeichert)." })] }), _jsxs("div", { className: "card p-4", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3", children: "Bekannte Anbieter" }), _jsx("div", { className: "grid grid-cols-2 gap-2 sm:grid-cols-3", children: [
                                    { name: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, tls: true, implTls: false },
                                    { name: 'Mailjet', host: 'in-v3.mailjet.com', port: 587, tls: true, implTls: false },
                                    { name: 'Mailgun', host: 'smtp.mailgun.org', port: 587, tls: true, implTls: false },
                                    { name: 'Postmark', host: 'smtp.postmarkapp.com', port: 587, tls: true, implTls: false },
                                    { name: 'Amazon SES', host: 'email-smtp.eu-west-1.amazonaws.com', port: 587, tls: true, implTls: false },
                                    { name: 'Gmail', host: 'smtp.gmail.com', port: 465, tls: false, implTls: true },
                                    { name: 'Office 365', host: 'smtp.office365.com', port: 587, tls: true, implTls: false },
                                    { name: 'IONOS', host: 'smtp.ionos.de', port: 587, tls: true, implTls: false },
                                    { name: 'Strato', host: 'smtp.strato.de', port: 465, tls: false, implTls: true },
                                ].map(p => (_jsxs("button", { onClick: () => { setHost(p.host); setPort(p.port); setTls(p.tls); setImplicitTls(p.implTls); }, className: "text-left px-3 py-2 rounded border border-gray-200 hover:border-accent hover:bg-accent/5 transition-colors", children: [_jsx("p", { className: "text-xs font-semibold text-gray-700", children: p.name }), _jsxs("p", { className: "text-[10px] text-gray-400 font-mono", children: [p.host, ":", p.port] })] }, p.name))) })] })] }))] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// ConnectionSection
// ═════════════════════════════════════════════════════════════════════════════
function ConnectionSection({ s, onSave, pending }) {
    const [vals, setVals] = useState({
        maxConnections: s.maxConnections,
        maxConnectionsPerIp: s.maxConnectionsPerIp,
        maxMessageSizeMb: s.maxMessageSizeMb,
        maxRecipients: s.maxRecipients,
        connectionTimeoutSec: s.connectionTimeoutSec,
        greetingDelaySec: s.greetingDelaySec,
        maxAuthFailures: s.maxAuthFailures,
    });
    function set(k, v) {
        setVals(prev => ({ ...prev, [k]: v }));
    }
    return (_jsxs("div", { className: "space-y-5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-base font-semibold text-gray-900", children: "Verbindungseinstellungen" }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: "Limits und Timeouts f\u00FCr SMTP-Verbindungen und Nachrichten" })] }), _jsx(SaveBtn, { onClick: () => onSave(vals), pending: pending })] }), _jsx("div", { className: "grid grid-cols-3 gap-3", children: [
                    { label: 'Max. Verbindungen', value: vals.maxConnections },
                    { label: 'Max. je IP', value: vals.maxConnectionsPerIp },
                    { label: 'Max. Empfänger', value: vals.maxRecipients },
                ].map(c => (_jsxs("div", { className: "card p-3 text-center", children: [_jsx("p", { className: "text-xl font-bold text-gray-900", children: c.value.toLocaleString() }), _jsx("p", { className: "text-xs text-gray-400", children: c.label })] }, c.label))) }), _jsxs("div", { className: "card p-5 space-y-0", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-3 border-b border-gray-100", children: "Verbindungslimits" }), _jsx(NumInput, { label: "Maximale gleichzeitige Verbindungen", desc: "Gesamtanzahl aktiver SMTP-Verbindungen (alle IPs)", value: vals.maxConnections, onChange: v => set('maxConnections', v), min: 1, max: 10000, unit: "Verb." }), _jsx(NumInput, { label: "Maximale Verbindungen pro IP", desc: "Verhindert DDoS/Spam von einzelnen IP-Adressen", value: vals.maxConnectionsPerIp, onChange: v => set('maxConnectionsPerIp', v), min: 1, max: 1000, unit: "Verb." }), _jsx(NumInput, { label: "Maximale Empf\u00E4nger pro Nachricht", desc: "Anzahl RCPT TO-Befehle pro Mail-Transaktion", value: vals.maxRecipients, onChange: v => set('maxRecipients', v), min: 1, max: 10000, unit: "Empf." }), _jsx(NumInput, { label: "Maximale Auth-Fehlversuche", desc: "Verbindung wird nach dieser Anzahl fehlgeschlagener AUTH-Versuche getrennt", value: vals.maxAuthFailures, onChange: v => set('maxAuthFailures', v), min: 1, max: 100 })] }), _jsxs("div", { className: "card p-5 space-y-0", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-3 border-b border-gray-100", children: "Nachrichtengr\u00F6\u00DFe" }), _jsx(NumInput, { label: "Maximale Nachrichtengr\u00F6\u00DFe", desc: "Nachrichten gr\u00F6\u00DFer als dieser Wert werden mit 552 abgelehnt", value: vals.maxMessageSizeMb, onChange: v => set('maxMessageSizeMb', v), min: 1, max: 500, unit: "MB" })] }), _jsxs("div", { className: "card p-5 space-y-0", children: [_jsx("p", { className: "text-xs font-semibold text-gray-500 uppercase tracking-wide pb-3 border-b border-gray-100", children: "Timeouts & Verz\u00F6gerungen" }), _jsx(NumInput, { label: "Verbindungs-Timeout", desc: "Inaktive Verbindungen werden nach dieser Zeit getrennt (RFC 5321: min. 300s)", value: vals.connectionTimeoutSec, onChange: v => set('connectionTimeoutSec', v), min: 30, max: 3600, unit: "Sek" }), _jsx(NumInput, { label: "Greeting Delay", desc: "K\u00FCnstliche Verz\u00F6gerung der 220-Antwort \u2014 hilft gegen Spam-Bots die sofort Daten senden", value: vals.greetingDelaySec, onChange: v => set('greetingDelaySec', v), min: 0, max: 30, unit: "Sek" })] }), _jsxs("div", { className: "bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-xs text-blue-700 flex items-start gap-2", children: [_jsx(Info, { size: 13, className: "shrink-0 mt-0.5" }), _jsx("span", { children: "RFC 5321 schreibt Mindest-Timeouts vor: EHLO/HELO 5 Min, MAIL 5 Min, DATA-Initiierung 2 Min, DATA-Block 3 Min. Der Verbindungs-Timeout sollte mindestens 300 Sek. betragen." })] })] }));
}
// ═════════════════════════════════════════════════════════════════════════════
// SmtpConfigPage (root)
// ═════════════════════════════════════════════════════════════════════════════
export function SmtpConfigPage() {
    const [section, setSection] = useState('esmtp');
    const qc = useQueryClient();
    const { data: settings } = useQuery({
        queryKey: ['admin', 'smtp-config', 'settings'],
        queryFn: () => api.get('/admin/smtp-config/settings'),
    });
    const saveMut = useMutation({
        mutationFn: (data) => api.put('/admin/smtp-config/settings', data),
        onSuccess: () => {
            toast.success('SMTP-Einstellungen gespeichert');
            qc.invalidateQueries({ queryKey: ['admin', 'smtp-config', 'settings'] });
        },
        onError: () => toast.error('Fehler beim Speichern'),
    });
    return (_jsxs("div", { className: "flex h-full", children: [_jsxs("aside", { className: "w-44 shrink-0 bg-[#1e2433] flex flex-col h-full", children: [_jsx("div", { className: "px-3 py-3 border-b border-white/10", children: _jsx("p", { className: "text-[10px] font-bold uppercase tracking-widest text-gray-400", children: "SMTP-Konfiguration" }) }), _jsx("nav", { className: "flex-1 py-2 space-y-0.5", children: SUB_NAV.map(({ id, label, icon: Icon }) => (_jsxs("button", { onClick: () => setSection(id), className: `w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${section === id
                                ? 'bg-white/10 text-white border-l-2 border-accent'
                                : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'}`, children: [_jsx(Icon, { size: 13, className: "shrink-0" }), label] }, id))) })] }), _jsx("div", { className: "flex-1 overflow-y-auto p-6", children: !settings ? (_jsx("div", { className: "text-sm text-gray-400", children: "Lade SMTP-Einstellungen\u2026" })) : (_jsxs(_Fragment, { children: [section === 'esmtp' && _jsx(EsmtpSection, { s: settings, onSave: d => saveMut.mutate(d), pending: saveMut.isPending }), section === 'delivery' && _jsx(DeliverySection, { s: settings, onSave: d => saveMut.mutate(d), pending: saveMut.isPending }), section === 'outgoing' && _jsx(OutgoingSection, { s: settings, onSave: d => saveMut.mutate(d), pending: saveMut.isPending }), section === 'banner' && _jsx(BannerSection, { s: settings, onSave: d => saveMut.mutate(d), pending: saveMut.isPending }), section === 'greylisting' && _jsx(GreylistingSection, { s: settings, onSave: d => saveMut.mutate(d), pending: saveMut.isPending }), section === 'relaying' && _jsx(RelayingSection, { s: settings, onSave: d => saveMut.mutate(d), pending: saveMut.isPending }), section === 'connection' && _jsx(ConnectionSection, { s: settings, onSave: d => saveMut.mutate(d), pending: saveMut.isPending })] })) })] }));
}
