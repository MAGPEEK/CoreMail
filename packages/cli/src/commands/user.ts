/** `coremail user …` — Benutzerkonten (jeder Benutzer hat genau ein Postfach). */
import { Command } from 'commander';
import { listUsers, resolveDomain, resolveUser, type CoreMailClient, type UserRow } from '../client.js';
import { confirm, fail, formatBytes, formatDate, parseBytes, printJson, printTable, promptHidden } from '../output.js';

const ROLES = ['USER', 'HELP_DESK', 'RECIPIENT_MANAGEMENT', 'COMPLIANCE_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'SERVER_MANAGEMENT', 'VIEW_ONLY_ORG', 'ORGANIZATION_MANAGEMENT'];

export function registerUser(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const user = program.command('user').description('Benutzerkonten anzeigen, anlegen, ändern, löschen');

  user.command('list').alias('ls').description('Alle Benutzer auflisten')
    .option('--domain <name>', 'nur Benutzer dieser Domain')
    .option('--inactive', 'nur deaktivierte Benutzer')
    .action(async (opts: { domain?: string; inactive?: boolean }) => {
      let users = await listUsers(api());
      if (opts.domain) users = users.filter((u) => u.email.toLowerCase().endsWith(`@${opts.domain!.toLowerCase()}`));
      if (opts.inactive) users = users.filter((u) => !u.active);
      if (json()) { printJson(users); return; }
      printTable(users.map((u) => ({
        email: u.email, name: u.displayName, role: u.role, active: u.active,
        used: formatBytes(u.usedBytes), quota: formatBytes(u.quotaBytes), created: formatDate(u.createdAt),
      })), [
        { key: 'email', label: 'E-Mail' }, { key: 'name', label: 'Name' }, { key: 'role', label: 'Rolle' },
        { key: 'active', label: 'Aktiv' }, { key: 'used', label: 'Belegt' }, { key: 'quota', label: 'Quota' }, { key: 'created', label: 'Erstellt' },
      ]);
    });

  user.command('show <email|id>').description('Details eines Benutzers')
    .action(async (ref: string) => {
      const u = await resolveUser(api(), ref);
      const detail = await api().get<UserRow & { mailbox?: { folders?: Array<{ name: string; displayName: string; totalCount: number; unreadCount: number }> } }>(`/api/v1/admin/mailboxes/${u.id}`);
      if (json()) { printJson(detail); return; }
      process.stdout.write([
        `ID:        ${detail.id}`, `E-Mail:    ${detail.email}`, `Name:      ${detail.displayName}`, `Rolle:     ${detail.role}`,
        `Aktiv:     ${detail.active ? 'ja' : 'nein'}`, `Belegt:    ${formatBytes(detail.usedBytes)} von ${formatBytes(detail.quotaBytes)}`,
        `Erstellt:  ${formatDate(detail.createdAt)}`, '',
      ].join('\n'));
      if (detail.mailbox?.folders?.length) {
        printTable(detail.mailbox.folders.map((f) => ({ name: f.displayName || f.name, total: f.totalCount, unread: f.unreadCount })),
          [{ key: 'name', label: 'Ordner' }, { key: 'total', label: 'Nachrichten' }, { key: 'unread', label: 'Ungelesen' }]);
      }
    });

  user.command('create <email>').description('Benutzer mit Postfach anlegen')
    .requiredOption('--name <displayName>', 'Anzeigename')
    .option('--password <password>', 'Passwort (min. 8 Zeichen); ohne Angabe wird interaktiv gefragt')
    .option('--domain <name|id>', 'Domain (Default: Domain-Teil der E-Mail-Adresse)')
    .option('--role <role>', `Rolle (${ROLES.join(', ')})`, 'USER')
    .option('--quota <size>', 'Speicherkontingent, z. B. 5GB', '5GB')
    .action(async (email: string, opts: { name: string; password?: string; domain?: string; role: string; quota: string }) => {
      if (!ROLES.includes(opts.role)) fail(`Ungültige Rolle: ${opts.role}`);
      const domainRef = opts.domain ?? email.split('@')[1] ?? '';
      const domain = await resolveDomain(api(), domainRef);
      let password = opts.password ?? process.env['COREMAIL_NEW_PASSWORD'];
      if (!password) {
        password = await promptHidden('Passwort: ');
        const again = await promptHidden('Passwort wiederholen: ');
        if (password !== again) fail('Passwörter stimmen nicht überein');
      }
      if (password.length < 8) fail('Passwort muss mindestens 8 Zeichen haben');
      const created = await api().post<UserRow>('/api/v1/admin/mailboxes', {
        email, displayName: opts.name, password, domainId: domain.id, role: opts.role, quotaBytes: parseBytes(opts.quota),
      });
      if (json()) { printJson(created); return; }
      process.stdout.write(`Benutzer angelegt: ${created.email} (${created.id}), Rolle ${created.role}\n`);
    });

  user.command('update <email|id>').description('Benutzer ändern (Name, Rolle, Quota, aktiv/inaktiv)')
    .option('--name <displayName>').option('--role <role>').option('--quota <size>')
    .option('--enable', 'Konto aktivieren').option('--disable', 'Konto deaktivieren')
    .action(async (ref: string, opts: { name?: string; role?: string; quota?: string; enable?: boolean; disable?: boolean }) => {
      const u = await resolveUser(api(), ref);
      if (opts.role && !ROLES.includes(opts.role)) fail(`Ungültige Rolle: ${opts.role}`);
      const body: Record<string, unknown> = {};
      if (opts.name) body['displayName'] = opts.name;
      if (opts.role) body['role'] = opts.role;
      if (opts.quota) body['quotaBytes'] = parseBytes(opts.quota);
      if (opts.enable) body['active'] = true;
      if (opts.disable) body['active'] = false;
      if (!Object.keys(body).length) fail('Nichts zu ändern — Option angeben (--name, --role, --quota, --enable, --disable)');
      const r = await api().put(`/api/v1/admin/mailboxes/${u.id}`, body);
      if (json()) { printJson(r); return; }
      process.stdout.write(`Benutzer aktualisiert: ${u.email}\n`);
    });

  user.command('set-password <email|id>').description('Passwort setzen')
    .option('--password <password>', 'neues Passwort (sonst interaktiv)')
    .action(async (ref: string, opts: { password?: string }) => {
      const u = await resolveUser(api(), ref);
      let password = opts.password ?? process.env['COREMAIL_NEW_PASSWORD'];
      if (!password) {
        password = await promptHidden('Neues Passwort: ');
        if (password !== await promptHidden('Passwort wiederholen: ')) fail('Passwörter stimmen nicht überein');
      }
      if (password.length < 8) fail('Passwort muss mindestens 8 Zeichen haben');
      await api().put(`/api/v1/admin/mailboxes/${u.id}`, { password });
      process.stdout.write(`Passwort gesetzt für ${u.email}\n`);
    });

  user.command('delete <email|id>').alias('rm').description('Benutzer samt Postfach löschen (unwiderruflich)')
    .option('-y, --yes', 'ohne Rückfrage')
    .action(async (ref: string, opts: { yes?: boolean }) => {
      const u = await resolveUser(api(), ref);
      if (!await confirm(`Benutzer ${u.email} und alle Mails endgültig löschen?`, !!opts.yes)) { process.stdout.write('Abgebrochen.\n'); return; }
      await api().delete(`/api/v1/admin/mailboxes/${u.id}`);
      process.stdout.write(`Benutzer gelöscht: ${u.email}\n`);
    });
}
