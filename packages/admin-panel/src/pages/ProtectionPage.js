import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Shield, CheckCircle, XCircle, Info } from 'lucide-react';
const FEATURES = [
    { label: 'SPF-Prüfung', description: 'Sender Policy Framework — prüft ob Absender-IP autorisiert ist', enabled: true },
    { label: 'DKIM-Validierung', description: 'DomainKeys Identified Mail — verifiziert kryptografische Signatur', enabled: true },
    { label: 'DMARC-Auswertung', description: 'Domain-based Message Authentication — kombiniert SPF + DKIM', enabled: true },
    { label: 'Greylisting', description: 'Verzögert Erstverbindungen von unbekannten Absendern (5 min)', enabled: true },
    { label: 'DNSBL (Spamhaus ZEN)', description: 'zen.spamhaus.org — SBL+XBL+PBL Blacklisten', enabled: true },
    { label: 'DNSBL (SpamCop)', description: 'bl.spamcop.net', enabled: true },
    { label: 'Reverse-DNS-Prüfung', description: 'PTR-Record der Absender-IP muss existieren', enabled: true },
    { label: 'Anti-Spam (rspamd)', description: 'Maschinell lernendes Spam-Scoring mit Bayes-Filter', enabled: true },
    { label: 'Antivirus (ClamAV)', description: 'Virenscan aller eingehenden Anhänge', enabled: true },
    { label: 'Country-Filtering', description: 'GeoIP-basierte Länderfilterung (nicht konfiguriert)', enabled: false },
    { label: 'Attachment-Filter', description: 'Blockierung gefährlicher Dateitypen (.exe, .vbs, .js)', enabled: true },
    { label: 'ARC-Validierung', description: 'Authenticated Received Chain — für Weiterleitungen', enabled: true },
];
export function ProtectionPage() {
    return (_jsxs("div", { className: "p-6 space-y-4", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Shield, { size: 20, className: "text-accent" }), _jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Schutzrichtlinien" })] }), _jsxs("div", { className: "flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-700", children: [_jsx(Info, { size: 15, className: "shrink-0 mt-0.5" }), _jsxs("p", { children: ["Schutzeinstellungen werden \u00FCber die Konfiguration des ", _jsx("code", { className: "bg-blue-100 px-1 rounded", children: "security-filter" }), "-Services und rspamd/ClamAV gesteuert. Detailkonfiguration in Phase 5."] })] }), _jsx("div", { className: "card p-0 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-4 py-2.5 font-medium text-gray-500 text-xs", children: "Schutzma\u00DFnahme" }), _jsx("th", { className: "text-left px-4 py-2.5 font-medium text-gray-500 text-xs", children: "Beschreibung" }), _jsx("th", { className: "text-center px-4 py-2.5 font-medium text-gray-500 text-xs", children: "Status" })] }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: FEATURES.map((f) => (_jsxs("tr", { className: "hover:bg-gray-50 transition-colors", children: [_jsx("td", { className: "px-4 py-2.5 font-medium text-gray-800", children: f.label }), _jsx("td", { className: "px-4 py-2.5 text-gray-500 text-xs", children: f.description }), _jsx("td", { className: "px-4 py-2.5 text-center", children: f.enabled
                                            ? _jsx(CheckCircle, { size: 16, className: "text-green-500 mx-auto" })
                                            : _jsx(XCircle, { size: 16, className: "text-gray-300 mx-auto" }) })] }, f.label))) })] }) })] }));
}
