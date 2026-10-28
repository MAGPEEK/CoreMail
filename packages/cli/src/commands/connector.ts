/**
 * `coremail connector …` — protocol connectors:
 *   smtp (receive 25/465/587), smtp-send (submission 587), imap (143/993), pop3 (110/995)
 *   → listeners from BCP → Services (port, address, TLS, active)
 *   jmap, mapi → switches in ServerSettings (jmapEnabled, mapiHttpEnabled — MAPI/HTTP + EWS)
 */
import { Command } from 'commander';
import type { CoreMailClient } from '../client.js';
import { fail, printJson, printTable } from '../output.js';

const LISTENER_SERVICES: Record<string, { slug: string; label: string }> = {
  smtp: { slug: 'smtp-receive', label: 'SMTP (receive)' },
  'smtp-receive': { slug: 'smtp-receive', label: 'SMTP (receive)' },
  'smtp-send': { slug: 'smtp-send', label: 'SMTP (submission)' },
  imap: { slug: 'imap', label: 'IMAP' },
  pop3: { slug: 'pop3', label: 'POP3' },
  pop: { slug: 'pop3', label: 'POP3' },
};
const FLAG_SERVICES: Record<string, { field: 'jmapEnabled' | 'mapiHttpEnabled'; label: string }> = {
  jmap: { field: 'jmapEnabled', label: 'JMAP (/jmap, /.well-known/jmap)' },
  mapi: { field: 'mapiHttpEnabled', label: 'MAPI over HTTP + EWS (/mapi, /EWS — Outlook "Exchange account")' },
};

interface Listener { id: string; service: string; address: string; port: number; ssl: boolean; active: boolean }
type ServerSettings = Record<string, unknown> & { jmapEnabled?: boolean; mapiHttpEnabled?: boolean };

async function listeners(api: CoreMailClient, slug: string): Promise<Listener[]> {
  return api.get<Listener[]>(`/api/v1/admin/services/listeners/${slug}`);
}

async function setFlag(api: CoreMailClient, field: 'jmapEnabled' | 'mapiHttpEnabled', value: boolean): Promise<void> {
  const settings = await api.get<ServerSettings>('/api/v1/admin/servers/settings');
  await api.put('/api/v1/admin/servers/settings', { ...settings, [field]: value });
}

function parseBool(s: string): boolean {
  if (/^(true|1|yes|on|ja|an)$/i.test(s)) return true;
  if (/^(false|0|no|off|nein|aus)$/i.test(s)) return false;
  throw new Error(`Invalid boolean: ${s}`);
}

export function registerConnector(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const c = program.command('connector').alias('conn').description('Connectors SMTP/IMAP/POP3/JMAP/MAPI: status, on/off, ports, TLS');

  c.command('status').description('All connectors with ports, TLS and state')
    .action(async () => {
      const [settings, ...lists] = await Promise.all([
        api().get<ServerSettings>('/api/v1/admin/servers/settings'),
        ...['smtp-receive', 'smtp-send', 'imap', 'pop3'].map((slug) => listeners(api(), slug)),
      ]);
      const rows: Array<Record<string, unknown>> = [];
      for (const l of lists.flat()) {
        rows.push({ service: l.service, id: l.id, endpoint: `${l.address}:${l.port}`, tls: l.ssl ? 'implicit' : 'STARTTLS/plain', active: l.active });
      }
      rows.push({ service: 'JMAP', id: 'jmapEnabled', endpoint: '/jmap · /.well-known/jmap · ws /jmap/ws', tls: 'HTTPS (proxy)', active: settings.jmapEnabled ?? true });
      rows.push({ service: 'MAPI_EWS', id: 'mapiHttpEnabled', endpoint: '/mapi/emsmdb · /mapi/nspi · /EWS/Exchange.asmx', tls: 'HTTPS (proxy)', active: settings.mapiHttpEnabled ?? false });
      if (json()) { printJson(rows); return; }
      printTable(rows, [
        { key: 'service', label: 'Service' }, { key: 'endpoint', label: 'Endpoint' }, { key: 'tls', label: 'TLS' }, { key: 'active', label: 'Active' }, { key: 'id', label: 'Listener ID' },
      ]);
    });

  const toggle = (desired: boolean) => async (service: string, opts: { port?: string }) => {
    const key = service.toLowerCase();
    if (FLAG_SERVICES[key]) {
      await setFlag(api(), FLAG_SERVICES[key]!.field, desired);
      process.stdout.write(`${FLAG_SERVICES[key]!.label}: ${desired ? 'enabled' : 'disabled'} (takes effect without restart)\n`);
      return;
    }
    const svc = LISTENER_SERVICES[key];
    if (!svc) fail(`Unknown connector: ${service} (smtp, smtp-send, imap, pop3, jmap, mapi)`);
    let ls = await listeners(api(), svc.slug);
    if (opts.port) ls = ls.filter((l) => l.port === parseInt(opts.port!, 10));
    if (!ls.length) fail(`No listener for ${svc.label}${opts.port ? ` on port ${opts.port}` : ''}`);
    let changed = 0;
    for (const l of ls) {
      if (l.active === desired) continue;
      await api().patch(`/api/v1/admin/services/listeners/${l.id}/toggle`);
      changed++;
    }
    process.stdout.write(`${svc.label}: ${changed} listener(s) ${desired ? 'enabled' : 'disabled'}${ls.length - changed ? ` (${ls.length - changed} already ${desired ? 'active' : 'inactive'})` : ''}\n`);
  };
  c.command('enable <service>').description('Enable a connector (all listeners or --port)').option('--port <n>').action(toggle(true));
  c.command('disable <service>').description('Disable a connector (all listeners or --port)').option('--port <n>').action(toggle(false));

  const l = c.command('listener').description('Manage listeners (port/address/TLS)');

  l.command('list [service]').description('List listeners')
    .action(async (service?: string) => {
      const slugs = service ? [LISTENER_SERVICES[service.toLowerCase()]?.slug ?? fail(`Unknown service: ${service}`)] : ['smtp-receive', 'smtp-send', 'imap', 'pop3'];
      const rows = (await Promise.all(slugs.map((s) => listeners(api(), s)))).flat();
      if (json()) { printJson(rows); return; }
      printTable(rows.map((x) => ({ id: x.id, service: x.service, address: x.address, port: x.port, ssl: x.ssl, active: x.active })), [
        { key: 'id', label: 'ID' }, { key: 'service', label: 'Service' }, { key: 'address', label: 'Address' }, { key: 'port', label: 'Port' }, { key: 'ssl', label: 'Implicit TLS' }, { key: 'active', label: 'Active' },
      ]);
    });

  l.command('add <service>').description('Add a listener')
    .requiredOption('--port <n>', 'port').option('--address <ip>', 'bind address', '0.0.0.0')
    .option('--ssl <bool>', 'implicit TLS (true/false)', 'false').option('--inactive', 'create disabled')
    .action(async (service: string, opts: { port: string; address: string; ssl: string; inactive?: boolean }) => {
      const svc = LISTENER_SERVICES[service.toLowerCase()] ?? fail(`Unknown service: ${service}`);
      const r = await api().post<Listener>(`/api/v1/admin/services/listeners/${svc.slug}`, {
        address: opts.address, port: parseInt(opts.port, 10), ssl: parseBool(opts.ssl), active: !opts.inactive,
      });
      if (json()) { printJson(r); return; }
      process.stdout.write(`Listener created: ${r.service} ${r.address}:${r.port} (${r.id})\n`);
    });

  l.command('set <id>').description('Change a listener (port, address, TLS, active)')
    .option('--port <n>').option('--address <ip>').option('--ssl <bool>').option('--active <bool>')
    .action(async (id: string, opts: { port?: string; address?: string; ssl?: string; active?: string }) => {
      const all = (await Promise.all(['smtp-receive', 'smtp-send', 'imap', 'pop3'].map((s) => listeners(api(), s)))).flat();
      const cur = all.find((x) => x.id === id) ?? fail(`Listener not found: ${id}`);
      const body = {
        address: opts.address ?? cur.address,
        port: opts.port ? parseInt(opts.port, 10) : cur.port,
        ssl: opts.ssl !== undefined ? parseBool(opts.ssl) : cur.ssl,
        active: opts.active !== undefined ? parseBool(opts.active) : cur.active,
      };
      const r = await api().put<Listener>(`/api/v1/admin/services/listeners/${id}`, body);
      if (json()) { printJson(r); return; }
      process.stdout.write(`Listener updated: ${r.service} ${r.address}:${r.port} TLS=${r.ssl} active=${r.active}\n`);
    });

  l.command('delete <id>').alias('rm').description('Delete a listener')
    .action(async (id: string) => {
      await api().delete(`/api/v1/admin/services/listeners/${id}`);
      process.stdout.write(`Listener deleted: ${id}\n`);
    });

  l.command('restore-defaults <service>').description("Restore a service's default ports")
    .action(async (service: string) => {
      const svc = LISTENER_SERVICES[service.toLowerCase()] ?? fail(`Unknown service: ${service}`);
      const r = await api().post(`/api/v1/admin/services/listeners/${svc.slug}/restore-defaults`);
      if (json()) { printJson(r); return; }
      process.stdout.write(`Default listeners for ${svc.label} restored\n`);
    });
}
