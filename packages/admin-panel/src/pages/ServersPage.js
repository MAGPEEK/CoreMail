import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CheckCircle, Server } from 'lucide-react';
const SERVICES = [
    { name: 'smtp-server', port: '25/465/587', description: 'SMTP Inbound + Outbound' },
    { name: 'imap-server', port: '143/993', description: 'IMAP4rev1 + IDLE' },
    { name: 'pop3-server', port: '110/995', description: 'POP3' },
    { name: 'ews-server', port: '8080', description: 'Exchange Web Services (SOAP)' },
    { name: 'autodiscover', port: '8081', description: 'Autodiscover v1 + v2' },
    { name: 'caldav-server', port: '8082', description: 'CalDAV + CardDAV' },
    { name: 'api-gateway', port: '3000', description: 'REST API + SSE' },
    { name: 'auth-service', port: '3003', description: 'Authentication + MFA' },
    { name: 'rspamd', port: '11333', description: 'Anti-Spam' },
    { name: 'clamav', port: '3310', description: 'Antivirus' },
];
export function ServersPage() {
    return (_jsxs("div", { className: "p-6 space-y-4", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Server, { size: 20, className: "text-accent" }), _jsx("h1", { className: "text-xl font-semibold text-gray-900", children: "Server & Health" })] }), _jsx("div", { className: "card p-0 overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-gray-50 border-b border-gray-200", children: _jsx("tr", { children: ['Service', 'Ports', 'Beschreibung', 'Status'].map((h) => (_jsx("th", { className: "text-left px-4 py-2.5 font-medium text-gray-500 text-xs", children: h }, h))) }) }), _jsx("tbody", { className: "divide-y divide-gray-100", children: SERVICES.map((s) => (_jsxs("tr", { className: "hover:bg-gray-50", children: [_jsx("td", { className: "px-4 py-2.5 font-mono text-sm text-gray-700", children: s.name }), _jsx("td", { className: "px-4 py-2.5 font-mono text-xs text-gray-500", children: s.port }), _jsx("td", { className: "px-4 py-2.5 text-xs text-gray-600", children: s.description }), _jsx("td", { className: "px-4 py-2.5", children: _jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx(CheckCircle, { size: 14, className: "text-green-500" }), _jsx("span", { className: "badge-green text-xs px-1.5 py-0.5", children: "Online" })] }) })] }, s.name))) })] }) }), _jsx("div", { className: "grid grid-cols-3 gap-4", children: [
                    { label: 'PostgreSQL', status: 'Primary', detail: 'Read-Write' },
                    { label: 'Redis', status: 'Connected', detail: 'Pub/Sub aktiv' },
                    { label: 'MinIO', status: 'Online', detail: 'S3-kompatibel' },
                ].map((item) => (_jsxs("div", { className: "card flex items-center gap-3", children: [_jsx(CheckCircle, { size: 20, className: "text-green-500 shrink-0" }), _jsxs("div", { children: [_jsx("p", { className: "font-medium text-gray-800", children: item.label }), _jsxs("p", { className: "text-xs text-gray-500", children: [item.status, " \u00B7 ", item.detail] })] })] }, item.label))) })] }));
}
