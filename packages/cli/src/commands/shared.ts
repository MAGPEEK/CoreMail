/** `coremail shared …` — Shared Mailboxes (Team-Postfächer) und Berechtigungen. */
import { Command } from 'commander';
import { listShared, resolveDomain, resolveShared, resolveUser, type CoreMailClient, type SharedRow } from '../client.js';
import { confirm, fail, formatBytes, formatDate, parseBytes, printJson, printTable } from '../output.js';

const PERMS = ['FULL_ACCESS', 'SEND_AS', 'SEND_ON_BEHALF', 'READ_ONLY'];

export function registerShared(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const sh = program.command('shared').description('Shared Mailboxes (Team-Postfächer) anzeigen, anlegen, berechtigen, löschen');

  sh.command('list').alias('ls').description('Alle Shared Mailboxes')
    .action(async () => {
      const list = await listShared(api());
      if (json()) { printJson(list); return; }
      printTable(list.map((s) => ({
        email: s.email, name: s.displayName, active: s.active, used: formatBytes(s.usedBytes), quota: formatBytes(s.quotaBytes),
        members: (s.permissions ?? []).map((p) => `${p.user?.email ?? p.userId}:${p.permission}`).join(' '), created: formatDate(s.createdAt),
      })), [
        { key: 'email', label: 'E-Mail' }, { key: 'name', label: 'Name' }, { key: 'active', label: 'Aktiv' }, { key: 'used', label: 'Belegt' },
        { key: 'quota', label: 'Quota' }, { key: 'members', label: 'Berechtigungen' }, { key: 'created', label: 'Erstellt' },
      ]);
    });

  sh.command('show <email|id>').description('Details und Berechtigungen')
    .action(async (ref: string) => {
      const s = await resolveShared(api(), ref);
      const perms = await api().get<Array<{ userId: string; permission: string; grantedAt: string; user?: { email: string; displayName: string } }>>(`/api/v1/admin/shared-mailboxes/${s.id}/permissions`);
      if (json()) { printJson({ ...s, permissions: perms }); return; }
      process.stdout.write(`${s.email} (${s.displayName}) — ${formatBytes(s.usedBytes)} von ${formatBytes(s.quotaBytes)}, ${s.active ? 'aktiv' : 'inaktiv'}\n\n`);
      printTable(perms.map((p) => ({ user: p.user?.email ?? p.userId, perm: p.permission, since: formatDate(p.grantedAt) })),
        [{ key: 'user', label: 'Benutzer' }, { key: 'perm', label: 'Berechtigung' }, { key: 'since', label: 'Seit' }]);
    });

  sh.command('create <email>').description('Shared Mailbox anlegen (Ordner werden provisioniert)')
    .requiredOption('--name <displayName>', 'Anzeigename')
    .option('--domain <name|id>', 'Domain (Default: Domain-Teil der Adresse)')
    .option('--quota <size>', 'Speicherkontingent, z. B. 10GB')
    .action(async (email: string, opts: { name: string; domain?: string; quota?: string }) => {
      const domain = await resolveDomain(api(), opts.domain ?? email.split('@')[1] ?? '');
      const created = await api().post<SharedRow>('/api/v1/admin/shared-mailboxes', {
        email, displayName: opts.name, domainId: domain.id, ...(opts.quota ? { quotaBytes: parseBytes(opts.quota) } : {}),
      });
      if (json()) { printJson(created); return; }
      process.stdout.write(`Shared Mailbox angelegt: ${created.email} (${created.id})\n`);
    });

  sh.command('grant <shared> <user> <permissions...>').description(`Berechtigungen setzen (${PERMS.join(', ')}) — ersetzt bestehende des Benutzers`)
    .action(async (sharedRef: string, userRef: string, permissions: string[]) => {
      const perms = permissions.map((p) => p.toUpperCase());
      const bad = perms.filter((p) => !PERMS.includes(p));
      if (bad.length) fail(`Ungültige Berechtigung: ${bad.join(', ')}`);
      const s = await resolveShared(api(), sharedRef);
      const u = await resolveUser(api(), userRef);
      const r = await api().post(`/api/v1/admin/shared-mailboxes/${s.id}/permissions`, { userId: u.id, permissions: perms });
      if (json()) { printJson(r); return; }
      process.stdout.write(`${u.email} → ${s.email}: ${perms.join(', ')}\n`);
    });

  sh.command('revoke <shared> <user>').description('Alle Berechtigungen eines Benutzers entfernen')
    .action(async (sharedRef: string, userRef: string) => {
      const s = await resolveShared(api(), sharedRef);
      const u = await resolveUser(api(), userRef);
      await api().delete(`/api/v1/admin/shared-mailboxes/${s.id}/permissions/${u.id}`);
      process.stdout.write(`Berechtigungen entfernt: ${u.email} auf ${s.email}\n`);
    });

  sh.command('delete <email|id>').alias('rm').description('Shared Mailbox samt Inhalt löschen')
    .option('-y, --yes', 'ohne Rückfrage')
    .action(async (ref: string, opts: { yes?: boolean }) => {
      const s = await resolveShared(api(), ref);
      if (!await confirm(`Shared Mailbox ${s.email} endgültig löschen?`, !!opts.yes)) { process.stdout.write('Abgebrochen.\n'); return; }
      await api().delete(`/api/v1/admin/shared-mailboxes/${s.id}`);
      process.stdout.write(`Shared Mailbox gelöscht: ${s.email}\n`);
    });
}
