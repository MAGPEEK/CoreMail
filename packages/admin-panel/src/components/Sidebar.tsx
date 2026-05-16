import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Globe, ListOrdered, ScrollText, Shield, Server,
  BarChart3, Mail, LogOut, Settings2, ShieldCheck, Inbox, Workflow,
  ShieldAlert, Search, Building2, Users,
  BookUser, ShieldHalf, SearchCheck, BookText, Archive,
  FolderOpen, KeyRound, Network, ClipboardList, Activity, Info,
} from 'lucide-react';
import { clearToken } from '../api/client.js';

type NavItem = { path: string; label: string; icon: React.ElementType };
type NavGroup = { group: string; items: NavItem[] };

const NAV: (NavItem | NavGroup)[] = [
  { path: '/dashboard',        label: 'Übersicht',           icon: LayoutDashboard },
  {
    group: 'Empfänger',
    items: [
      { path: '/mailboxes',        label: 'Postfächer',          icon: Mail },
      { path: '/shared-mailboxes', label: 'Freigegeben',         icon: Inbox },
      { path: '/groups',           label: 'Verteilergruppen',    icon: Users },
      { path: '/resources',        label: 'Ressourcen',          icon: Building2 },
      { path: '/ext-contacts',    label: 'Ext. Kontakte',       icon: BookUser },
      { path: '/public-folders',  label: 'Öffentl. Ordner',    icon: FolderOpen },
      { path: '/domains',          label: 'Domains',             icon: Globe },
    ],
  },
  {
    group: 'Nachrichtenfluss',
    items: [
      { path: '/transport-rules',  label: 'Transportregeln',     icon: Workflow },
      { path: '/gateway',          label: 'SMTP-Gateway',        icon: Network },
      { path: '/message-trace',    label: 'Nachrichtenfluss',    icon: Search },
    ],
  },
  {
    group: 'Schutz',
    items: [
      { path: '/protection',       label: 'Schutzfilter',        icon: Shield },
      { path: '/quarantine',       label: 'Quarantäne',          icon: ShieldAlert },
    ],
  },
  {
    group: 'Infrastruktur',
    items: [
      { path: '/services',         label: 'Services',            icon: Server },
      { path: '/certificates',     label: 'Zertifikate',         icon: ShieldCheck },
      { path: '/oauth-clients',    label: 'OAuth2-Clients',      icon: KeyRound },
    ],
  },
  {
    group: 'Status & Monitoring',
    items: [
      { path: '/queues',           label: 'Warteschlangen',      icon: ListOrdered },
      { path: '/servers',          label: 'Server & Health',     icon: Activity },
    ],
  },
  { path: '/organisation',     label: 'Organisation',        icon: Building2 },
  {
    group: 'Compliance',
    items: [
      { path: '/ediscovery',      label: 'eDiscovery',          icon: SearchCheck },
      { path: '/journaling',      label: 'Journaling',          icon: BookText },
      { path: '/retention',       label: 'Aufbewahrung',        icon: Archive },
      { path: '/compliance-info', label: 'Info',                icon: Info },
    ],
  },
  { path: '/rbac',             label: 'Berechtigungen',      icon: ShieldHalf },
  { path: '/audit-log',        label: 'Audit-Log',           icon: ClipboardList },
  { path: '/logs',             label: 'Protokolle',          icon: ScrollText },
  { path: '/reports',         label: 'Berichte',            icon: BarChart3 },
  { path: '/settings',        label: 'Einstellungen',       icon: Settings2 },
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
        {NAV.map(entry => {
          if ('group' in entry) {
            return (
              <div key={entry.group}>
                <p className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                  {entry.group}
                </p>
                {entry.items.map(({ path, label, icon: Icon }) => (
                  <NavLink key={path} to={path}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${
                        isActive ? 'bg-gray-800 text-white border-l-2 border-accent' : 'hover:bg-gray-800 hover:text-white'
                      }`
                    }>
                    <Icon size={14} />
                    {label}
                  </NavLink>
                ))}
              </div>
            );
          }
          const { path, label, icon: Icon } = entry;
          return (
            <NavLink key={path} to={path}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                  isActive ? 'bg-gray-800 text-white border-l-2 border-accent' : 'hover:bg-gray-800 hover:text-white'
                }`
              }>
              <Icon size={15} />
              {label}
            </NavLink>
          );
        })}
      </nav>

      <div className="p-3 border-t border-gray-700">
        <button
          onClick={() => { clearToken(); window.location.href = '/ecp/login'; }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors">
          <LogOut size={14} />
          Abmelden
        </button>
      </div>
    </aside>
  );
}
