#!/usr/bin/env node
/**
 * coremail — Admin-CLI für CoreMail (v5.8.0)
 *
 * Läuft im App-Container (`docker exec coremail coremail …`) oder überall, wo die
 * Admin-API erreichbar ist (`--server https://mail.example.de`). Nutzt dieselbe
 * REST-Admin-API wie das BCP → gleiche Rechteprüfung, gleiches Audit-Log.
 */
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { ApiError, CoreMailClient } from './client.js';
import { registerAuth } from './commands/auth.js';
import { registerUser } from './commands/user.js';
import { registerMailbox } from './commands/mailbox.js';
import { registerShared } from './commands/shared.js';
import { registerDomain } from './commands/domain.js';
import { registerConnector } from './commands/connector.js';
import { registerSmtp } from './commands/smtp.js';
import { registerCert } from './commands/cert.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();
program
  .name('coremail')
  .description('CoreMail Admin-CLI — Benutzer, Postfächer, Shared Mailboxes, Konnektoren, SMTP-Banner, Zertifikate')
  .version(pkg.version, '-V, --version', 'Version anzeigen')
  .option('-s, --server <url>', 'Basis-URL der Admin-API (Default: COREMAIL_API_URL oder http://localhost:3000)')
  .option('--json', 'Ausgabe als JSON')
  .showHelpAfterError('(--help für Hilfe)')
  .configureHelp({ sortSubcommands: true });

let client: CoreMailClient | null = null;
const api = (): CoreMailClient => {
  if (!client) client = new CoreMailClient(CoreMailClient.resolveServer(program.opts<{ server?: string }>().server));
  return client;
};
const json = (): boolean => program.opts<{ json?: boolean }>().json === true;

registerAuth(program, api, json);
registerUser(program, api, json);
registerMailbox(program, api, json);
registerShared(program, api, json);
registerDomain(program, api, json);
registerConnector(program, api, json);
registerSmtp(program, api, json);
registerCert(program, api, json);

program.addHelpText('after', `
Beispiele:
  coremail login -u admin@example.de
  coremail user list --domain example.de
  coremail user create max@example.de --name "Max Muster" --quota 10GB
  coremail shared create team@example.de --name "Team" && coremail shared grant team@example.de max@example.de FULL_ACCESS SEND_AS
  coremail connector status
  coremail connector disable pop3 && coremail connector enable jmap
  coremail connector listener set <id> --port 1143 --ssl false
  coremail smtp banner set "mail.example.de ESMTP"
  coremail cert letsencrypt --domains mail.example.de,autodiscover.example.de --email admin@example.de --services SMTP,IMAP,POP3
  coremail cert activate mail.example.de --https --protocol

Umgebung:
  COREMAIL_API_URL  COREMAIL_TOKEN  COREMAIL_ADMIN_EMAIL  COREMAIL_ADMIN_PASSWORD  COREMAIL_ADMIN_TOTP  COREMAIL_CLI_CREDENTIALS
`);

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof ApiError) process.stderr.write(`Fehler (HTTP ${err.status}): ${err.message}\n`);
  else process.stderr.write(`Fehler: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
