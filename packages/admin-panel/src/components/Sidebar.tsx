import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Globe, ListOrdered, ScrollText, Shield, Server,
  Mail, Settings2, ShieldCheck, Inbox, Workflow,
  ShieldAlert, Search, Users,
  BookUser, ShieldHalf, Archive,
  KeyRound, ClipboardList, Activity, Info, Terminal,
  Fingerprint, ServerCog, HardDriveDownload,
} from 'lucide-react';
import { useT } from '../i18n/useT.js';

type NavItem  = { path: string; labelKey: string; icon: React.ElementType };
type NavGroup = { groupKey: string; items: NavItem[] };

export function Sidebar() {
  const t = useT();

  const NAV: (NavItem | NavGroup)[] = [
    { path: '/dashboard',        labelKey: 'nav_overview',         icon: LayoutDashboard },
    { path: '/settings',         labelKey: 'nav_global_settings',  icon: Settings2 },
    {
      groupKey: 'nav_group_recipients',
      items: [
        { path: '/mailboxes',        labelKey: 'nav_mailboxes',        icon: Mail },
        { path: '/shared-mailboxes', labelKey: 'nav_shared_mailboxes', icon: Inbox },
        { path: '/groups',           labelKey: 'nav_groups',           icon: Users },
        { path: '/ext-contacts',     labelKey: 'nav_ext_contacts',     icon: BookUser },
        { path: '/domains',          labelKey: 'nav_domains',          icon: Globe },
      ],
    },
    {
      groupKey: 'nav_group_mailflow',
      items: [
        { path: '/transport-rules',  labelKey: 'nav_transport_rules',  icon: Workflow },
        { path: '/message-trace',    labelKey: 'nav_message_trace',    icon: Search },
      ],
    },
    {
      groupKey: 'nav_group_protection',
      items: [
        { path: '/protection',       labelKey: 'nav_protection',       icon: Shield },
        { path: '/quarantine',       labelKey: 'nav_quarantine',       icon: ShieldAlert },
      ],
    },
    {
      groupKey: 'nav_group_infra',
      items: [
        { path: '/services',         labelKey: 'nav_services',         icon: Server },
        { path: '/smtp-config',      labelKey: 'nav_smtp_config',      icon: Terminal },
        { path: '/certificates',     labelKey: 'nav_certificates',     icon: ShieldCheck },
        { path: '/oauth-clients',    labelKey: 'nav_oauth_clients',    icon: KeyRound },
        { path: '/sso',              labelKey: 'nav_sso',              icon: Fingerprint },
        { path: '/ldap',             labelKey: 'nav_ldap',             icon: ServerCog },
      ],
    },
    {
      groupKey: 'nav_group_monitoring',
      items: [
        { path: '/queues',           labelKey: 'nav_queues',           icon: ListOrdered },
        { path: '/servers',          labelKey: 'nav_servers',          icon: Activity },
      ],
    },
    {
      groupKey: 'nav_group_compliance',
      items: [
        { path: '/retention',        labelKey: 'nav_retention',        icon: Archive },
      ],
    },
    { path: '/rbac',             labelKey: 'nav_rbac',             icon: ShieldHalf },
    { path: '/audit-log',        labelKey: 'nav_audit_log',        icon: ClipboardList },
    { path: '/logs',             labelKey: 'nav_logs',             icon: ScrollText },
    { path: '/backups',          labelKey: 'nav_backups',          icon: HardDriveDownload },
    { path: '/compliance-info',  labelKey: 'nav_info',             icon: Info },
  ];

  return (
    <aside className="w-52 shrink-0 bg-gray-900 text-gray-300 flex flex-col h-full">
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV.map(entry => {
          if ('groupKey' in entry) {
            return (
              <div key={entry.groupKey}>
                <p className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                  {t(entry.groupKey as Parameters<typeof t>[0])}
                </p>
                {entry.items.map(({ path, labelKey, icon: Icon }) => (
                  <NavLink key={path} to={path}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${
                        isActive ? 'bg-gray-800 text-white border-l-2 border-accent' : 'hover:bg-gray-800 hover:text-white'
                      }`
                    }>
                    <Icon size={14} />
                    {t(labelKey as Parameters<typeof t>[0])}
                  </NavLink>
                ))}
              </div>
            );
          }
          const { path, labelKey, icon: Icon } = entry;
          return (
            <NavLink key={path} to={path}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                  isActive ? 'bg-gray-800 text-white border-l-2 border-accent' : 'hover:bg-gray-800 hover:text-white'
                }`
              }>
              <Icon size={15} />
              {t(labelKey as Parameters<typeof t>[0])}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
