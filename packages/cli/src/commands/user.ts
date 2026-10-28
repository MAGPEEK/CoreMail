/** `coremail user …` — user accounts (every user has exactly one mailbox). */
import { Command } from 'commander';
import { listUsers, resolveDomain, resolveUser, type CoreMailClient, type UserRow } from '../client.js';
import { confirm, fail, formatBytes, formatDate, parseBytes, printJson, printTable, promptHidden } from '../output.js';

const ROLES = ['USER', 'HELP_DESK', 'RECIPIENT_MANAGEMENT', 'COMPLIANCE_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'SERVER_MANAGEMENT', 'VIEW_ONLY_ORG', 'ORGANIZATION_MANAGEMENT'];

export function registerUser(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const user = program.command('user').description('Show, create, update and delete user accounts');

  user.command('list').alias('ls').description('List all users')
    .option('--domain <name>', 'only users of this domain')
    .option('--inactive', 'only disabled users')
    .action(async (opts: { domain?: string; inactive?: boolean }) => {
      let users = await listUsers(api());
      if (opts.domain) users = users.filter((u) => u.email.toLowerCase().endsWith(`@${opts.domain!.toLowerCase()}`));
      if (opts.inactive) users = users.filter((u) => !u.active);
      if (json()) { printJson(users); return; }
      printTable(users.map((u) => ({
        email: u.email, name: u.displayName, role: u.role, active: u.active,
        used: formatBytes(u.usedBytes), quota: formatBytes(u.quotaBytes), created: formatDate(u.createdAt),
      })), [
        { key: 'email', label: 'Email' }, { key: 'name', label: 'Name' }, { key: 'role', label: 'Role' },
        { key: 'active', label: 'Active' }, { key: 'used', label: 'Used' }, { key: 'quota', label: 'Quota' }, { key: 'created', label: 'Created' },
      ]);
    });

  user.command('show <email|id>').description('Show details of a user')
    .action(async (ref: string) => {
      const u = await resolveUser(api(), ref);
      const detail = await api().get<UserRow & { mailbox?: { folders?: Array<{ name: string; displayName: string; totalCount: number; unreadCount: number }> } }>(`/api/v1/admin/mailboxes/${u.id}`);
      if (json()) { printJson(detail); return; }
      process.stdout.write([
        `ID:        ${detail.id}`, `Email:     ${detail.email}`, `Name:      ${detail.displayName}`, `Role:      ${detail.role}`,
        `Active:    ${detail.active ? 'yes' : 'no'}`, `Used:      ${formatBytes(detail.usedBytes)} of ${formatBytes(detail.quotaBytes)}`,
        `Created:   ${formatDate(detail.createdAt)}`, '',
      ].join('\n'));
      if (detail.mailbox?.folders?.length) {
        printTable(detail.mailbox.folders.map((f) => ({ name: f.displayName || f.name, total: f.totalCount, unread: f.unreadCount })),
          [{ key: 'name', label: 'Folder' }, { key: 'total', label: 'Messages' }, { key: 'unread', label: 'Unread' }]);
      }
    });

  user.command('create <email>').description('Create a user with a mailbox')
    .requiredOption('--name <displayName>', 'display name')
    .option('--password <password>', 'password (min. 8 characters); prompted interactively when omitted')
    .option('--domain <name|id>', 'domain (default: domain part of the email address)')
    .option('--role <role>', `role (${ROLES.join(', ')})`, 'USER')
    .option('--quota <size>', 'storage quota, e.g. 5GB', '5GB')
    .action(async (email: string, opts: { name: string; password?: string; domain?: string; role: string; quota: string }) => {
      if (!ROLES.includes(opts.role)) fail(`Invalid role: ${opts.role}`);
      const domainRef = opts.domain ?? email.split('@')[1] ?? '';
      const domain = await resolveDomain(api(), domainRef);
      let password = opts.password ?? process.env['COREMAIL_NEW_PASSWORD'];
      if (!password) {
        password = await promptHidden('Password: ');
        const again = await promptHidden('Repeat password: ');
        if (password !== again) fail('Passwords do not match');
      }
      if (password.length < 8) fail('Password must have at least 8 characters');
      const created = await api().post<UserRow>('/api/v1/admin/mailboxes', {
        email, displayName: opts.name, password, domainId: domain.id, role: opts.role, quotaBytes: parseBytes(opts.quota),
      });
      if (json()) { printJson(created); return; }
      process.stdout.write(`User created: ${created.email} (${created.id}), role ${created.role}\n`);
    });

  user.command('update <email|id>').description('Update a user (name, role, quota, enable/disable)')
    .option('--name <displayName>').option('--role <role>').option('--quota <size>')
    .option('--enable', 'enable the account').option('--disable', 'disable the account')
    .action(async (ref: string, opts: { name?: string; role?: string; quota?: string; enable?: boolean; disable?: boolean }) => {
      const u = await resolveUser(api(), ref);
      if (opts.role && !ROLES.includes(opts.role)) fail(`Invalid role: ${opts.role}`);
      const body: Record<string, unknown> = {};
      if (opts.name) body['displayName'] = opts.name;
      if (opts.role) body['role'] = opts.role;
      if (opts.quota) body['quotaBytes'] = parseBytes(opts.quota);
      if (opts.enable) body['active'] = true;
      if (opts.disable) body['active'] = false;
      if (!Object.keys(body).length) fail('Nothing to change — pass an option (--name, --role, --quota, --enable, --disable)');
      const r = await api().put(`/api/v1/admin/mailboxes/${u.id}`, body);
      if (json()) { printJson(r); return; }
      process.stdout.write(`User updated: ${u.email}\n`);
    });

  user.command('set-password <email|id>').description('Set a new password')
    .option('--password <password>', 'new password (prompted when omitted)')
    .action(async (ref: string, opts: { password?: string }) => {
      const u = await resolveUser(api(), ref);
      let password = opts.password ?? process.env['COREMAIL_NEW_PASSWORD'];
      if (!password) {
        password = await promptHidden('New password: ');
        if (password !== await promptHidden('Repeat password: ')) fail('Passwords do not match');
      }
      if (password.length < 8) fail('Password must have at least 8 characters');
      await api().put(`/api/v1/admin/mailboxes/${u.id}`, { password });
      process.stdout.write(`Password set for ${u.email}\n`);
    });

  user.command('delete <email|id>').alias('rm').description('Delete a user including the mailbox (irreversible)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (ref: string, opts: { yes?: boolean }) => {
      const u = await resolveUser(api(), ref);
      if (!await confirm(`Permanently delete user ${u.email} and all mail?`, !!opts.yes)) { process.stdout.write('Aborted.\n'); return; }
      await api().delete(`/api/v1/admin/mailboxes/${u.id}`);
      process.stdout.write(`User deleted: ${u.email}\n`);
    });
}
