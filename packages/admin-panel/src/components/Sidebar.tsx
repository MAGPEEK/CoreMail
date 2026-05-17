import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Globe, ListOrdered, ScrollText, Shield, Server,
  Mail, Settings2, ShieldCheck, Inbox, Workflow,
  ShieldAlert, Search, Building2, Users,
  BookUser, ShieldHalf, SearchCheck, BookText, Archive,
  FolderOpen, KeyRound, Network, ClipboardList, Activity, Info, Terminal,
  Fingerprint, ServerCog,
} from 'lucide-react';

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
      { path: '/smtp-config',      label: 'SMTP & Routing',      icon: Terminal },
      { path: '/certificates',     label: 'Zertifikate',         icon: ShieldCheck },
      { path: '/oauth-clients',    label: 'OAuth2-Clients',      icon: KeyRound },
      { path: '/sso',              label: 'SSO',                 icon: Fingerprint },
      { path: '/ldap',             label: 'LDAP / Active Dir.',  icon: ServerCog },
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
    ],
  },
  { path: '/rbac',             label: 'Berechtigungen',      icon: ShieldHalf },
  { path: '/audit-log',        label: 'Audit-Log',           icon: ClipboardList },
  { path: '/logs',             label: 'Protokolle',          icon: ScrollText },
  { path: '/settings',        label: 'Einstellungen',       icon: Settings2 },
  { path: '/compliance-info', label: 'Info',                icon: Info },
];

export function Sidebar() {
  return (
    <aside className="w-52 shrink-0 bg-gray-900 text-gray-300 flex flex-col h-full">
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
    </aside>
  );
}
