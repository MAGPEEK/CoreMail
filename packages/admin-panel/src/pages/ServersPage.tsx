import { CheckCircle, XCircle, Server } from 'lucide-react';

interface ServiceStatus { name: string; port: string; description: string }

const SERVICES: ServiceStatus[] = [
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
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Server size={20} className="text-accent" />
        <h1 className="text-xl font-semibold text-gray-900">Server & Health</h1>
      </div>

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['Service', 'Ports', 'Beschreibung', 'Status'].map((h) => (
                <th key={h} className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {SERVICES.map((s) => (
              <tr key={s.name} className="hover:bg-gray-50">
                <td className="px-4 py-2.5 font-mono text-sm text-gray-700">{s.name}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{s.port}</td>
                <td className="px-4 py-2.5 text-xs text-gray-600">{s.description}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle size={14} className="text-green-500" />
                    <span className="badge-green text-xs px-1.5 py-0.5">Online</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'PostgreSQL', status: 'Primary', detail: 'Read-Write' },
          { label: 'Redis', status: 'Connected', detail: 'Pub/Sub aktiv' },
          { label: 'MinIO', status: 'Online', detail: 'S3-kompatibel' },
        ].map((item) => (
          <div key={item.label} className="card flex items-center gap-3">
            <CheckCircle size={20} className="text-green-500 shrink-0" />
            <div>
              <p className="font-medium text-gray-800">{item.label}</p>
              <p className="text-xs text-gray-500">{item.status} · {item.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
