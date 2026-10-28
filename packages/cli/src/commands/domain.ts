/** `coremail domain list` — domains (for --domain options). */
import { Command } from 'commander';
import { listDomains, type CoreMailClient } from '../client.js';
import { printJson, printTable } from '../output.js';

export function registerDomain(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const d = program.command('domain').description('Show mail domains');
  d.command('list', { isDefault: true }).alias('ls').description('All domains')
    .action(async () => {
      const domains = await listDomains(api());
      if (json()) { printJson(domains); return; }
      printTable(domains.map((x) => ({ name: x.name, primary: x.primary, active: x.active, id: x.id })),
        [{ key: 'name', label: 'Domain' }, { key: 'primary', label: 'Primary' }, { key: 'active', label: 'Active' }, { key: 'id', label: 'ID' }]);
    });
}
