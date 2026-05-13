import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { BarChart3 } from 'lucide-react';

// Static placeholder data — will be replaced with real metrics in Phase 5
const MAIL_FLOW = [
  { hour: '00:00', inbound: 12, outbound: 8, spam: 3 },
  { hour: '04:00', inbound: 5, outbound: 2, spam: 1 },
  { hour: '08:00', inbound: 87, outbound: 54, spam: 12 },
  { hour: '10:00', inbound: 134, outbound: 98, spam: 8 },
  { hour: '12:00', inbound: 142, outbound: 113, spam: 15 },
  { hour: '14:00', inbound: 128, outbound: 104, spam: 11 },
  { hour: '16:00', inbound: 96, outbound: 78, spam: 9 },
  { hour: '18:00', inbound: 43, outbound: 31, spam: 5 },
  { hour: '20:00', inbound: 22, outbound: 14, spam: 3 },
  { hour: '22:00', inbound: 15, outbound: 8, spam: 2 },
];

export function ReportsPage() {
  const total = MAIL_FLOW.reduce((a, b) => ({ ...a, inbound: a.inbound + b.inbound, outbound: a.outbound + b.outbound, spam: a.spam + b.spam }));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-2">
        <BarChart3 size={20} className="text-accent" />
        <h1 className="text-xl font-semibold text-gray-900">Berichte</h1>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Eingehend heute', value: total.inbound, color: 'text-blue-600' },
          { label: 'Ausgehend heute', value: total.outbound, color: 'text-green-600' },
          { label: 'Spam abgefangen', value: total.spam, color: 'text-red-500' },
        ].map((s) => (
          <div key={s.label} className="card text-center">
            <p className={`text-3xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-gray-500 mt-1">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="card">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Nachrichtenfluss — Heute (stündlich)</h2>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={MAIL_FLOW} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="inbound" name="Eingehend" fill="#0078D4" radius={[2, 2, 0, 0]} />
            <Bar dataKey="outbound" name="Ausgehend" fill="#34c759" radius={[2, 2, 0, 0]} />
            <Bar dataKey="spam" name="Spam" fill="#ef4444" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p className="text-xs text-gray-400 text-center">Echtzeitdaten aus Prometheus verfügbar in Phase 5 (OpenTelemetry + Grafana)</p>
    </div>
  );
}
