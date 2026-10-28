/** `coremail domain list` — Domains (für --domain-Optionen). */
import { Command } from 'commander';
import { listDomains, type CoreMailClient } from '../client.js';
import { printJson, printTable } from '../output.js';

export function registerDomain(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const d = program.command('domain').description('Mail-Domains anzeigen');
  d.command('list', { isDefault: true }).alias('ls').description('Alle Domains')
    .action(async () => {
      const domains = await listDomains(api());
      if (json()) { printJson(domains); return; }
      printTable(domains.map((x) => ({ name: x.name, primary: x.primary, active: x.active, id: x.id })),
        [{ key: 'name', label: 'Domain' }, { key: 'primary', label: 'Primär' }, { key: 'active', label: 'Aktiv' }, { key: 'id', label: 'ID' }]);
    });
}
