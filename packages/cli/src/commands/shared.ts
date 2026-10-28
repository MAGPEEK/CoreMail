/** `coremail shared …` — shared mailboxes (team mailboxes) and permissions. */
import { Command } from 'commander';
import { listShared, resolveDomain, resolveShared, resolveUser, type CoreMailClient, type SharedRow } from '../client.js';
import { confirm, fail, formatBytes, formatDate, parseBytes, printJson, printTable } from '../output.js';

const PERMS = ['FULL_ACCESS', 'SEND_AS', 'SEND_ON_BEHALF', 'READ_ONLY'];

export function registerShared(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const sh = program.command('shared').description('Show, create, grant and delete shared mailboxes (team mailboxes)');

  sh.command('list').alias('ls').description('All shared mailboxes')
    .action(async () => {
      const list = await listShared(api());
      if (json()) { printJson(list); return; }
      printTable(list.map((s) => ({
        email: s.email, name: s.displayName, active: s.active, used: formatBytes(s.usedBytes), quota: formatBytes(s.quotaBytes),
        members: (s.permissions ?? []).map((p) => `${p.user?.email ?? p.userId}:${p.permission}`).join(' '), created: formatDate(s.createdAt),
      })), [
        { key: 'email', label: 'Email' }, { key: 'name', label: 'Name' }, { key: 'active', label: 'Active' }, { key: 'used', label: 'Used' },
        { key: 'quota', label: 'Quota' }, { key: 'members', label: 'Permissions' }, { key: 'created', label: 'Created' },
      ]);
    });

  sh.command('show <email|id>').description('Details and permissions')
    .action(async (ref: string) => {
      const s = await resolveShared(api(), ref);
      const perms = await api().get<Array<{ userId: string; permission: string; grantedAt: string; user?: { email: string; displayName: string } }>>(`/api/v1/admin/shared-mailboxes/${s.id}/permissions`);
      if (json()) { printJson({ ...s, permissions: perms }); return; }
      process.stdout.write(`${s.email} (${s.displayName}) — ${formatBytes(s.usedBytes)} of ${formatBytes(s.quotaBytes)}, ${s.active ? 'active' : 'inactive'}\n\n`);
      printTable(perms.map((p) => ({ user: p.user?.email ?? p.userId, perm: p.permission, since: formatDate(p.grantedAt) })),
        [{ key: 'user', label: 'User' }, { key: 'perm', label: 'Permission' }, { key: 'since', label: 'Since' }]);
    });

  sh.command('create <email>').description('Create a shared mailbox (folders are provisioned)')
    .requiredOption('--name <displayName>', 'display name')
    .option('--domain <name|id>', 'domain (default: domain part of the address)')
    .option('--quota <size>', 'storage quota, e.g. 10GB')
    .action(async (email: string, opts: { name: string; domain?: string; quota?: string }) => {
      const domain = await resolveDomain(api(), opts.domain ?? email.split('@')[1] ?? '');
      const created = await api().post<SharedRow>('/api/v1/admin/shared-mailboxes', {
        email, displayName: opts.name, domainId: domain.id, ...(opts.quota ? { quotaBytes: parseBytes(opts.quota) } : {}),
      });
      if (json()) { printJson(created); return; }
      process.stdout.write(`Shared mailbox created: ${created.email} (${created.id})\n`);
    });

  sh.command('grant <shared> <user> <permissions...>').description(`Set permissions (${PERMS.join(', ')}) — replaces the user's existing ones`)
    .action(async (sharedRef: string, userRef: string, permissions: string[]) => {
      const perms = permissions.map((p) => p.toUpperCase());
      const bad = perms.filter((p) => !PERMS.includes(p));
      if (bad.length) fail(`Invalid permission: ${bad.join(', ')}`);
      const s = await resolveShared(api(), sharedRef);
      const u = await resolveUser(api(), userRef);
      const r = await api().post(`/api/v1/admin/shared-mailboxes/${s.id}/permissions`, { userId: u.id, permissions: perms });
      if (json()) { printJson(r); return; }
      process.stdout.write(`${u.email} → ${s.email}: ${perms.join(', ')}\n`);
    });

  sh.command('revoke <shared> <user>').description("Remove all of a user's permissions")
    .action(async (sharedRef: string, userRef: string) => {
      const s = await resolveShared(api(), sharedRef);
      const u = await resolveUser(api(), userRef);
      await api().delete(`/api/v1/admin/shared-mailboxes/${s.id}/permissions/${u.id}`);
      process.stdout.write(`Permissions removed: ${u.email} on ${s.email}\n`);
    });

  sh.command('delete <email|id>').alias('rm').description('Delete a shared mailbox including its contents')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (ref: string, opts: { yes?: boolean }) => {
      const s = await resolveShared(api(), ref);
      if (!await confirm(`Permanently delete shared mailbox ${s.email}?`, !!opts.yes)) { process.stdout.write('Aborted.\n'); return; }
      await api().delete(`/api/v1/admin/shared-mailboxes/${s.id}`);
      process.stdout.write(`Shared mailbox deleted: ${s.email}\n`);
    });
}
