/** `coremail mailbox …` — Postfach-Sicht (Belegung, Ordner, Quota) auf Benutzerkonten. */
import { Command } from 'commander';
import { listUsers, resolveUser, type CoreMailClient, type UserRow } from '../client.js';
import { fail, formatBytes, parseBytes, printJson, printTable } from '../output.js';

export function registerMailbox(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const mb = program.command('mailbox').description('Postfächer: Belegung, Quota, Ordner (Benutzerpostfächer; Team-Postfächer: `shared`)');

  mb.command('list').alias('ls').description('Alle Postfächer mit Belegung')
    .option('--sort <field>', 'Sortierung: used | quota | email', 'used')
    .action(async (opts: { sort: string }) => {
      const users = await listUsers(api());
      const key = opts.sort === 'quota' ? 'quotaBytes' : opts.sort === 'email' ? 'email' : 'usedBytes';
      users.sort((a, b) => key === 'email' ? a.email.localeCompare(b.email) : Number(b[key]) - Number(a[key]));
      if (json()) { printJson(users.map((u) => ({ id: u.id, email: u.email, usedBytes: Number(u.usedBytes), quotaBytes: Number(u.quotaBytes), active: u.active }))); return; }
      printTable(users.map((u) => ({
        email: u.email, used: formatBytes(u.usedBytes), quota: formatBytes(u.quotaBytes),
        pct: Number(u.quotaBytes) > 0 ? `${Math.round(Number(u.usedBytes) / Number(u.quotaBytes) * 100)} %` : '—', active: u.active,
      })), [
        { key: 'email', label: 'Postfach' }, { key: 'used', label: 'Belegt' }, { key: 'quota', label: 'Quota' }, { key: 'pct', label: 'Auslastung' }, { key: 'active', label: 'Aktiv' },
      ]);
    });

  mb.command('show <email|id>').description('Ordner und Zähler eines Postfachs')
    .action(async (ref: string) => {
      const u = await resolveUser(api(), ref);
      const detail = await api().get<UserRow & { mailbox?: { folders?: Array<{ id: string; name: string; displayName: string; totalCount: number; unreadCount: number }> } }>(`/api/v1/admin/mailboxes/${u.id}`);
      if (json()) { printJson(detail); return; }
      process.stdout.write(`${detail.email}: ${formatBytes(detail.usedBytes)} von ${formatBytes(detail.quotaBytes)} belegt\n\n`);
      printTable((detail.mailbox?.folders ?? []).map((f) => ({ id: f.id, name: f.displayName || f.name, total: f.totalCount, unread: f.unreadCount })),
        [{ key: 'name', label: 'Ordner' }, { key: 'total', label: 'Nachrichten' }, { key: 'unread', label: 'Ungelesen' }, { key: 'id', label: 'ID' }]);
    });

  mb.command('quota <email|id> <size>').description('Speicherkontingent setzen, z. B. 10GB')
    .action(async (ref: string, size: string) => {
      const u = await resolveUser(api(), ref);
      const bytes = parseBytes(size);
      if (bytes <= 0) fail('Quota muss größer als 0 sein');
      await api().put(`/api/v1/admin/mailboxes/${u.id}`, { quotaBytes: bytes });
      process.stdout.write(`Quota für ${u.email}: ${formatBytes(bytes)}\n`);
    });

  mb.command('recalculate [email|id]').description('Belegung neu berechnen (ein Postfach oder alle)')
    .action(async (ref?: string) => {
      if (ref) {
        const u = await resolveUser(api(), ref);
        const r = await api().post(`/api/v1/admin/mailboxes/${u.id}/recalculate-quota`);
        if (json()) { printJson(r); return; }
        process.stdout.write(`Belegung neu berechnet: ${u.email}\n`);
      } else {
        const r = await api().post('/api/v1/admin/mailboxes/recalculate-all-quotas');
        if (json()) { printJson(r); return; }
        process.stdout.write('Belegung aller Postfächer neu berechnet\n');
      }
    });

  mb.command('create <email>').description('Alias für `user create` (legt Benutzer + Postfach an)')
    .allowUnknownOption(true)
    .action(() => fail('Bitte `coremail user create <email> --name … [--password …]` verwenden'));
  mb.command('delete <email|id>').description('Alias für `user delete`')
    .allowUnknownOption(true)
    .action(() => fail('Bitte `coremail user delete <email|id>` verwenden'));
}
