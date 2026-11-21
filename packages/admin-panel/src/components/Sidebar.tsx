import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Globe, ListOrdered, ScrollText, Shield, Server, LayoutGrid,
  Mail, Settings2, ShieldCheck, Inbox, Workflow,
  ShieldAlert, ShieldBan, Search,
  ShieldHalf, Archive,
  ClipboardList, Activity, Info, Terminal,
  Fingerprint, ServerCog, HardDriveDownload, Palette, Bot, KeyRound, UserPlus,
} from 'lucide-react';
import { useT } from '../i18n/useT.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { areaForPath } from '../lib/adminAreas.js';

type NavItem  = { path: string; labelKey: string; icon: React.ElementType };
type NavGroup = { groupKey: string; items: NavItem[] };

export function Sidebar() {
  const t = useT();
  const { canSeePath, ready } = usePermissions();
  // Only areas the role may at least read (EAC: features without rights are not shown).
  // Until the permissions are known only the always-visible entries are shown.
  const visible = (path: string) => {
    const area = areaForPath(path);
    if (area === null || area === undefined) return true;
    // 9.1: or a page action (COMPLIANCE_MANAGEMENT → Backups via backupMailboxData)
    return ready && canSeePath(path);
  };

  const ALL_NAV: (NavItem | NavGroup)[] = [
    { path: '/dashboard',        labelKey: 'nav_overview',         icon: LayoutDashboard },
    { path: '/settings',         labelKey: 'nav_global_settings',  icon: Settings2 },
    { path: '/branding',         labelKey: 'nav_branding',         icon: Palette },
    {
      groupKey: 'nav_group_recipients',
      items: [
        { path: '/mailboxes',        labelKey: 'nav_mailboxes',        icon: Mail },
        { path: '/shared-mailboxes', labelKey: 'nav_shared_mailboxes', icon: Inbox },
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
        { path: '/attack-protection', labelKey: 'nav_attack_protection', icon: ShieldBan },
        { path: '/quarantine',       labelKey: 'nav_quarantine',       icon: ShieldAlert },
      ],
    },
    {
      // 10.6: sign-in methods + account self-service (a later "Passkeys" entry goes after MFA); routes unchanged
      groupKey: 'nav_group_auth',
      items: [
        { path: '/mfa',              labelKey: 'nav_mfa',              icon: KeyRound },
        { path: '/password-reset', labelKey: 'nav_password_reset', icon: KeyRound },
        { path: '/authentication/self-registration', labelKey: 'nav_self_registration', icon: UserPlus },
        { path: '/sso',              labelKey: 'nav_sso',              icon: Fingerprint },
        { path: '/ldap',             labelKey: 'nav_ldap',             icon: ServerCog },
      ],
    },
    {
      groupKey: 'nav_group_infra',
      items: [
        { path: '/services',         labelKey: 'nav_services',         icon: Server },
        { path: '/webmail-policies', labelKey: 'nav_webmail_policies', icon: LayoutGrid },
        { path: '/smtp-config',      labelKey: 'nav_smtp_config',      icon: Terminal },
        { path: '/certificates',     labelKey: 'nav_certificates',     icon: ShieldCheck },
        { path: '/mcp',              labelKey: 'nav_mcp',              icon: Bot },
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

  const NAV = ALL_NAV
    .map((entry) => ('groupKey' in entry ? { ...entry, items: entry.items.filter((i) => visible(i.path)) } : entry))
    .filter((entry) => ('groupKey' in entry ? entry.items.length > 0 : visible(entry.path)));

  return (
    <aside className="w-52 shrink-0 bg-surface border-r border-line text-fg-muted flex flex-col h-full">
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV.map(entry => {
          if ('groupKey' in entry) {
            return (
              <div key={entry.groupKey}>
                <p className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-fg-subtle">
                  {t(entry.groupKey as Parameters<typeof t>[0])}
                </p>
                {entry.items.map(({ path, labelKey, icon: Icon }) => (
                  <NavLink key={path} to={path}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 pl-3 pr-4 py-2 text-sm transition-colors ${
                        isActive ? 'bg-surface-3 text-fg font-semibold border-l-4 border-accent' : 'border-l-4 border-transparent hover:bg-surface-2 hover:text-fg'
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
                `flex items-center gap-2.5 pl-3 pr-4 py-2.5 text-sm transition-colors ${
                  isActive ? 'bg-surface-3 text-fg font-semibold border-l-4 border-accent' : 'border-l-4 border-transparent hover:bg-surface-2 hover:text-fg'
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
