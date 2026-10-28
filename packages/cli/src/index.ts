#!/usr/bin/env node
/**
 * coremail — admin CLI for CoreMail
 *
 * Runs inside the app container (`docker exec coremail coremail …`) or anywhere the
 * Admin API is reachable (`--server https://mail.example.com`). Uses the same REST
 * Admin API as the BCP → same permission checks, same audit log.
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
  .description('CoreMail admin CLI — users, mailboxes, shared mailboxes, connectors, SMTP banner, certificates')
  .version(pkg.version, '-V, --version', 'show version')
  .option('-s, --server <url>', 'base URL of the Admin API (default: COREMAIL_API_URL or http://localhost:3000)')
  .option('--json', 'output as JSON')
  .showHelpAfterError('(--help for help)')
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
Examples:
  coremail login -u admin@example.com
  coremail user list --domain example.com
  coremail user create max@example.com --name "Max Muster" --quota 10GB
  coremail shared create team@example.com --name "Team" && coremail shared grant team@example.com max@example.com FULL_ACCESS SEND_AS
  coremail connector status
  coremail connector disable pop3 && coremail connector enable jmap
  coremail connector listener set <id> --port 1143 --ssl false
  coremail smtp banner set "mail.example.com ESMTP"
  coremail cert letsencrypt --domains mail.example.com,autodiscover.example.com --email admin@example.com --services SMTP,IMAP,POP3
  coremail cert activate mail.example.com --https --protocol

Environment:
  COREMAIL_API_URL  COREMAIL_TOKEN  COREMAIL_ADMIN_EMAIL  COREMAIL_ADMIN_PASSWORD  COREMAIL_ADMIN_TOTP  COREMAIL_CLI_CREDENTIALS
`);

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof ApiError) process.stderr.write(`Error (HTTP ${err.status}): ${err.message}\n`);
  else process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
