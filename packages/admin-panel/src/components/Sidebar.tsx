import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Globe, ListOrdered,
  ScrollText, Shield, Server, BarChart3, Mail, LogOut,
} from 'lucide-react';
import { clearToken } from '../api/client.js';

const NAV = [
  { path: '/dashboard', label: 'Übersicht', icon: LayoutDashboard },
  { path: '/mailboxes', label: 'Postfächer', icon: Mail },
  { path: '/domains', label: 'Domains', icon: Globe },
  { path: '/queues', label: 'Warteschlangen', icon: ListOrdered },
  { path: '/logs', label: 'Protokolle', icon: ScrollText },
  { path: '/protection', label: 'Schutz', icon: Shield },
  { path: '/servers', label: 'Server & Health', icon: Server },
  { path: '/reports', label: 'Berichte', icon: BarChart3 },
];

export function Sidebar() {
  return (
    <aside className="w-52 shrink-0 bg-gray-900 text-gray-300 flex flex-col h-full">
      <div className="px-4 py-4 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <Mail size={18} className="text-accent" />
          <div>
            <p className="text-white font-semibold text-sm">CoreMail ECP</p>
            <p className="text-gray-500 text-xs">Admin-Konsole</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {NAV.map(({ path, label, icon: Icon }) => (
          <NavLink key={path} to={path}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                isActive ? 'bg-gray-800 text-white border-l-2 border-accent' : 'hover:bg-gray-800 hover:text-white'
              }`
            }>
            <Icon size={15} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="p-3 border-t border-gray-700">
        <button
          onClick={() => { clearToken(); window.location.href = '/login'; }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors">
          <LogOut size={14} />
          Abmelden
        </button>
      </div>
    </aside>
  );
}
