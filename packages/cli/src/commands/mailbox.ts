/** `coremail mailbox …` — mailbox view (usage, folders, quota) of user accounts. */
import { Command } from 'commander';
import { listUsers, resolveUser, type CoreMailClient, type UserRow } from '../client.js';
import { fail, formatBytes, parseBytes, printJson, printTable } from '../output.js';

export function registerMailbox(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const mb = program.command('mailbox').description('Mailboxes: usage, quota, folders (user mailboxes; team mailboxes: `shared`)');

  mb.command('list').alias('ls').description('All mailboxes with usage')
    .option('--sort <field>', 'sort by: used | quota | email', 'used')
    .action(async (opts: { sort: string }) => {
      const users = await listUsers(api());
      const key = opts.sort === 'quota' ? 'quotaBytes' : opts.sort === 'email' ? 'email' : 'usedBytes';
      users.sort((a, b) => key === 'email' ? a.email.localeCompare(b.email) : Number(b[key]) - Number(a[key]));
      if (json()) { printJson(users.map((u) => ({ id: u.id, email: u.email, usedBytes: Number(u.usedBytes), quotaBytes: Number(u.quotaBytes), active: u.active }))); return; }
      printTable(users.map((u) => ({
        email: u.email, used: formatBytes(u.usedBytes), quota: formatBytes(u.quotaBytes),
        pct: Number(u.quotaBytes) > 0 ? `${Math.round(Number(u.usedBytes) / Number(u.quotaBytes) * 100)} %` : '—', active: u.active,
      })), [
        { key: 'email', label: 'Mailbox' }, { key: 'used', label: 'Used' }, { key: 'quota', label: 'Quota' }, { key: 'pct', label: 'Usage' }, { key: 'active', label: 'Active' },
      ]);
    });

  mb.command('show <email|id>').description('Folders and counters of a mailbox')
    .action(async (ref: string) => {
      const u = await resolveUser(api(), ref);
      const detail = await api().get<UserRow & { mailbox?: { folders?: Array<{ id: string; name: string; displayName: string; totalCount: number; unreadCount: number }> } }>(`/api/v1/admin/mailboxes/${u.id}`);
      if (json()) { printJson(detail); return; }
      process.stdout.write(`${detail.email}: ${formatBytes(detail.usedBytes)} of ${formatBytes(detail.quotaBytes)} used\n\n`);
      printTable((detail.mailbox?.folders ?? []).map((f) => ({ id: f.id, name: f.displayName || f.name, total: f.totalCount, unread: f.unreadCount })),
        [{ key: 'name', label: 'Folder' }, { key: 'total', label: 'Messages' }, { key: 'unread', label: 'Unread' }, { key: 'id', label: 'ID' }]);
    });

  mb.command('quota <email|id> <size>').description('Set the storage quota, e.g. 10GB')
    .action(async (ref: string, size: string) => {
      const u = await resolveUser(api(), ref);
      const bytes = parseBytes(size);
      if (bytes <= 0) fail('Quota must be greater than 0');
      await api().put(`/api/v1/admin/mailboxes/${u.id}`, { quotaBytes: bytes });
      process.stdout.write(`Quota for ${u.email}: ${formatBytes(bytes)}\n`);
    });

  mb.command('recalculate [email|id]').description('Recalculate usage (one mailbox or all)')
    .action(async (ref?: string) => {
      if (ref) {
        const u = await resolveUser(api(), ref);
        const r = await api().post(`/api/v1/admin/mailboxes/${u.id}/recalculate-quota`);
        if (json()) { printJson(r); return; }
        process.stdout.write(`Usage recalculated: ${u.email}\n`);
      } else {
        const r = await api().post('/api/v1/admin/mailboxes/recalculate-all-quotas');
        if (json()) { printJson(r); return; }
        process.stdout.write('Usage of all mailboxes recalculated\n');
      }
    });

  mb.command('create <email>').description('Alias for `user create` (creates user + mailbox)')
    .allowUnknownOption(true)
    .action(() => fail('Use `coremail user create <email> --name … [--password …]`'));
  mb.command('delete <email|id>').description('Alias for `user delete`')
    .allowUnknownOption(true)
    .action(() => fail('Use `coremail user delete <email|id>`'));
}
