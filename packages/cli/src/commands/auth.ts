/** `coremail login|logout|whoami` — Sitzung der CLI. */
import { Command } from 'commander';
import { clearCredentials, credentialsPath, loadCredentials, type CoreMailClient } from '../client.js';
import { fail, printJson, prompt, promptHidden } from '../output.js';

export function registerAuth(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  program.command('login').description('Als Admin anmelden und Sitzung speichern')
    .option('-u, --user <email>', 'Admin-E-Mail').option('-p, --password <password>', 'Passwort (besser: interaktiv oder COREMAIL_ADMIN_PASSWORD)')
    .option('--totp <code>', 'MFA-Code (TOTP oder Backup-Code)')
    .action(async (opts: { user?: string; password?: string; totp?: string }) => {
      const email = opts.user ?? process.env['COREMAIL_ADMIN_EMAIL'] ?? (process.stdin.isTTY ? await prompt('Admin-E-Mail: ') : '');
      if (!email) fail('--user erforderlich');
      const password = opts.password ?? process.env['COREMAIL_ADMIN_PASSWORD'] ?? await promptHidden('Passwort: ');
      const c = await api().login(email, password, opts.totp);
      if (json()) { printJson({ server: c.server, email: c.email, expiresAt: new Date(c.expiresAt).toISOString() }); return; }
      process.stdout.write(`Angemeldet als ${email} an ${c.server} — Sitzung in ${credentialsPath()}\n`);
    });

  program.command('logout').description('Gespeicherte Sitzung löschen')
    .action(() => { process.stdout.write(clearCredentials() ? 'Sitzung gelöscht.\n' : 'Keine gespeicherte Sitzung.\n'); });

  program.command('whoami').description('Aktuelle Sitzung anzeigen')
    .action(() => {
      const c = loadCredentials();
      if (process.env['COREMAIL_TOKEN']) { process.stdout.write('Authentifizierung über COREMAIL_TOKEN\n'); return; }
      if (!c) { process.stdout.write('Nicht angemeldet.\n'); return; }
      if (json()) { printJson({ server: c.server, email: c.email, expiresAt: new Date(c.expiresAt).toISOString(), expired: c.expiresAt < Date.now() }); return; }
      process.stdout.write(`${c.email ?? '?'} @ ${c.server} — Token ${c.expiresAt < Date.now() ? 'abgelaufen (wird per Refresh erneuert)' : `gültig bis ${new Date(c.expiresAt).toLocaleString()}`}\n`);
    });
}
