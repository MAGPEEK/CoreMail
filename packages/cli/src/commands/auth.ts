/** `coremail login|logout|whoami` — CLI session. */
import { Command } from 'commander';
import { clearCredentials, credentialsPath, loadCredentials, type CoreMailClient } from '../client.js';
import { fail, printJson, prompt, promptHidden } from '../output.js';

export function registerAuth(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  program.command('login').description('Log in as admin and save the session')
    .option('-u, --user <email>', 'admin email').option('-p, --password <password>', 'password (prefer the prompt or COREMAIL_ADMIN_PASSWORD)')
    .option('--totp <code>', 'MFA code (TOTP or backup code)')
    .action(async (opts: { user?: string; password?: string; totp?: string }) => {
      const email = opts.user ?? process.env['COREMAIL_ADMIN_EMAIL'] ?? (process.stdin.isTTY ? await prompt('Admin email: ') : '');
      if (!email) fail('--user required');
      const password = opts.password ?? process.env['COREMAIL_ADMIN_PASSWORD'] ?? await promptHidden('Password: ');
      const c = await api().login(email, password, opts.totp);
      if (json()) { printJson({ server: c.server, email: c.email, expiresAt: new Date(c.expiresAt).toISOString() }); return; }
      process.stdout.write(`Logged in as ${email} at ${c.server} — session saved in ${credentialsPath()}\n`);
    });

  program.command('logout').description('Delete the saved session')
    .action(() => { process.stdout.write(clearCredentials() ? 'Session deleted.\n' : 'No saved session.\n'); });

  program.command('whoami').description('Show the current session')
    .action(() => {
      const c = loadCredentials();
      if (process.env['COREMAIL_TOKEN']) { process.stdout.write('Authenticated via COREMAIL_TOKEN\n'); return; }
      if (!c) { process.stdout.write('Not logged in.\n'); return; }
      if (json()) { printJson({ server: c.server, email: c.email, expiresAt: new Date(c.expiresAt).toISOString(), expired: c.expiresAt < Date.now() }); return; }
      process.stdout.write(`${c.email ?? '?'} @ ${c.server} — token ${c.expiresAt < Date.now() ? 'expired (renewed via refresh on next call)' : `valid until ${new Date(c.expiresAt).toLocaleString()}`}\n`);
    });
}
