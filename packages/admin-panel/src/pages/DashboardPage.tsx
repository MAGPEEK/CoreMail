import { useQuery } from '@tanstack/react-query';
import { Mail, Users, Server, AlertTriangle } from 'lucide-react';
import { api } from '../api/client.js';

interface QueueStats { name: string; count: number }

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string | number; icon: React.ElementType; color: string }) {
  return (
    <div className="card flex items-center gap-4">
      <div className={`w-11 h-11 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={20} className="text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { data: queues } = useQuery({
    queryKey: ['admin-queues'],
    queryFn: () => api.get<QueueStats[]>('/admin/queues'),
    refetchInterval: 10_000,
  });

  const { data: domains } = useQuery({
    queryKey: ['admin-domains'],
    queryFn: () => api.get<{ id: string }[]>('/admin/domains'),
  });

  const outbound = queues?.find((q) => q.name === 'smtp:outbound')?.count ?? 0;
  const deadLetter = queues?.find((q) => q.name === 'smtp:outbound:dead')?.count ?? 0;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold text-gray-900">Systemübersicht</h1>

      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Domains" value={domains?.length ?? '—'} icon={Server} color="bg-accent" />
        <StatCard label="Ausgehende Queue" value={outbound} icon={Mail} color="bg-blue-500" />
        <StatCard label="Dead Letters" value={deadLetter} icon={AlertTriangle} color={deadLetter > 0 ? 'bg-red-500' : 'bg-gray-400'} />
        <StatCard label="Services" value="Gesund" icon={Users} color="bg-green-500" />
      </div>

      {/* Queue overview */}
      <div className="card">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">SMTP-Warteschlangen</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left py-2 font-medium text-gray-500">Queue</th>
              <th className="text-right py-2 font-medium text-gray-500">Einträge</th>
              <th className="text-right py-2 font-medium text-gray-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {(queues ?? []).map((q) => (
              <tr key={q.name}>
                <td className="py-2 font-mono text-xs text-gray-600">{q.name}</td>
                <td className="py-2 text-right font-medium">{q.count}</td>
                <td className="py-2 text-right">
                  {q.name.includes('dead') && q.count > 0
                    ? <span className="badge-red">Fehler</span>
                    : q.count > 100
                    ? <span className="badge-yellow">Hoch</span>
                    : <span className="badge-green">OK</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
