/**
 * `coremail connector …` — Protokoll-Konnektoren:
 *   smtp (Empfang 25/465/587), smtp-send (Submission 587), imap (143/993), pop3 (110/995)
 *   → Listener aus BCP → Dienste (Port, Adresse, TLS, aktiv)
 *   jmap, mapi → Schalter in ServerSettings (jmapEnabled, mapiHttpEnabled — MAPI/HTTP + EWS)
 */
import { Command } from 'commander';
import type { CoreMailClient } from '../client.js';
import { fail, printJson, printTable } from '../output.js';

const LISTENER_SERVICES: Record<string, { slug: string; label: string }> = {
  smtp: { slug: 'smtp-receive', label: 'SMTP (Empfang)' },
  'smtp-receive': { slug: 'smtp-receive', label: 'SMTP (Empfang)' },
  'smtp-send': { slug: 'smtp-send', label: 'SMTP (Submission)' },
  imap: { slug: 'imap', label: 'IMAP' },
  pop3: { slug: 'pop3', label: 'POP3' },
  pop: { slug: 'pop3', label: 'POP3' },
};
const FLAG_SERVICES: Record<string, { field: 'jmapEnabled' | 'mapiHttpEnabled'; label: string }> = {
  jmap: { field: 'jmapEnabled', label: 'JMAP (/jmap, /.well-known/jmap)' },
  mapi: { field: 'mapiHttpEnabled', label: 'MAPI over HTTP + EWS (/mapi, /EWS — Outlook „Exchange-Konto")' },
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
  if (/^(true|1|ja|yes|on|an)$/i.test(s)) return true;
  if (/^(false|0|nein|no|off|aus)$/i.test(s)) return false;
  throw new Error(`Ungültiger Wahrheitswert: ${s}`);
}

export function registerConnector(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const c = program.command('connector').alias('conn').description('Konnektoren SMTP/IMAP/POP3/JMAP/MAPI: Status, ein/aus, Ports, TLS');

  c.command('status').description('Alle Konnektoren mit Ports, TLS und Zustand')
    .action(async () => {
      const [settings, ...lists] = await Promise.all([
        api().get<ServerSettings>('/api/v1/admin/servers/settings'),
        ...['smtp-receive', 'smtp-send', 'imap', 'pop3'].map((slug) => listeners(api(), slug)),
      ]);
      const rows: Array<Record<string, unknown>> = [];
      for (const l of lists.flat()) {
        rows.push({ service: l.service, id: l.id, endpoint: `${l.address}:${l.port}`, tls: l.ssl ? 'implizit' : 'STARTTLS/klar', active: l.active });
      }
      rows.push({ service: 'JMAP', id: 'jmapEnabled', endpoint: '/jmap · /.well-known/jmap · ws /jmap/ws', tls: 'HTTPS (Proxy)', active: settings.jmapEnabled ?? true });
      rows.push({ service: 'MAPI_EWS', id: 'mapiHttpEnabled', endpoint: '/mapi/emsmdb · /mapi/nspi · /EWS/Exchange.asmx', tls: 'HTTPS (Proxy)', active: settings.mapiHttpEnabled ?? false });
      if (json()) { printJson(rows); return; }
      printTable(rows, [
        { key: 'service', label: 'Dienst' }, { key: 'endpoint', label: 'Endpunkt' }, { key: 'tls', label: 'TLS' }, { key: 'active', label: 'Aktiv' }, { key: 'id', label: 'Listener-ID' },
      ]);
    });

  const toggle = (desired: boolean) => async (service: string, opts: { port?: string }) => {
    const key = service.toLowerCase();
    if (FLAG_SERVICES[key]) {
      await setFlag(api(), FLAG_SERVICES[key]!.field, desired);
      process.stdout.write(`${FLAG_SERVICES[key]!.label}: ${desired ? 'aktiviert' : 'deaktiviert'} (greift ohne Neustart)\n`);
      return;
    }
    const svc = LISTENER_SERVICES[key];
    if (!svc) fail(`Unbekannter Konnektor: ${service} (smtp, smtp-send, imap, pop3, jmap, mapi)`);
    let ls = await listeners(api(), svc.slug);
    if (opts.port) ls = ls.filter((l) => l.port === parseInt(opts.port!, 10));
    if (!ls.length) fail(`Kein Listener für ${svc.label}${opts.port ? ` auf Port ${opts.port}` : ''}`);
    let changed = 0;
    for (const l of ls) {
      if (l.active === desired) continue;
      await api().patch(`/api/v1/admin/services/listeners/${l.id}/toggle`);
      changed++;
    }
    process.stdout.write(`${svc.label}: ${changed} Listener ${desired ? 'aktiviert' : 'deaktiviert'}${ls.length - changed ? ` (${ls.length - changed} bereits ${desired ? 'aktiv' : 'inaktiv'})` : ''}\n`);
  };
  c.command('enable <service>').description('Konnektor einschalten (alle Listener oder --port)').option('--port <n>').action(toggle(true));
  c.command('disable <service>').description('Konnektor ausschalten (alle Listener oder --port)').option('--port <n>').action(toggle(false));

  const l = c.command('listener').description('Listener (Port/Adresse/TLS) verwalten');

  l.command('list [service]').description('Listener auflisten')
    .action(async (service?: string) => {
      const slugs = service ? [LISTENER_SERVICES[service.toLowerCase()]?.slug ?? fail(`Unbekannter Dienst: ${service}`)] : ['smtp-receive', 'smtp-send', 'imap', 'pop3'];
      const rows = (await Promise.all(slugs.map((s) => listeners(api(), s)))).flat();
      if (json()) { printJson(rows); return; }
      printTable(rows.map((x) => ({ id: x.id, service: x.service, address: x.address, port: x.port, ssl: x.ssl, active: x.active })), [
        { key: 'id', label: 'ID' }, { key: 'service', label: 'Dienst' }, { key: 'address', label: 'Adresse' }, { key: 'port', label: 'Port' }, { key: 'ssl', label: 'Implizites TLS' }, { key: 'active', label: 'Aktiv' },
      ]);
    });

  l.command('add <service>').description('Listener hinzufügen')
    .requiredOption('--port <n>', 'Port').option('--address <ip>', 'Bind-Adresse', '0.0.0.0')
    .option('--ssl <bool>', 'implizites TLS (true/false)', 'false').option('--inactive', 'deaktiviert anlegen')
    .action(async (service: string, opts: { port: string; address: string; ssl: string; inactive?: boolean }) => {
      const svc = LISTENER_SERVICES[service.toLowerCase()] ?? fail(`Unbekannter Dienst: ${service}`);
      const r = await api().post<Listener>(`/api/v1/admin/services/listeners/${svc.slug}`, {
        address: opts.address, port: parseInt(opts.port, 10), ssl: parseBool(opts.ssl), active: !opts.inactive,
      });
      if (json()) { printJson(r); return; }
      process.stdout.write(`Listener angelegt: ${r.service} ${r.address}:${r.port} (${r.id})\n`);
    });

  l.command('set <id>').description('Listener ändern (Port, Adresse, TLS, aktiv)')
    .option('--port <n>').option('--address <ip>').option('--ssl <bool>').option('--active <bool>')
    .action(async (id: string, opts: { port?: string; address?: string; ssl?: string; active?: string }) => {
      const all = (await Promise.all(['smtp-receive', 'smtp-send', 'imap', 'pop3'].map((s) => listeners(api(), s)))).flat();
      const cur = all.find((x) => x.id === id) ?? fail(`Listener nicht gefunden: ${id}`);
      const body = {
        address: opts.address ?? cur.address,
        port: opts.port ? parseInt(opts.port, 10) : cur.port,
        ssl: opts.ssl !== undefined ? parseBool(opts.ssl) : cur.ssl,
        active: opts.active !== undefined ? parseBool(opts.active) : cur.active,
      };
      const r = await api().put<Listener>(`/api/v1/admin/services/listeners/${id}`, body);
      if (json()) { printJson(r); return; }
      process.stdout.write(`Listener aktualisiert: ${r.service} ${r.address}:${r.port} TLS=${r.ssl} aktiv=${r.active}\n`);
    });

  l.command('delete <id>').alias('rm').description('Listener löschen')
    .action(async (id: string) => {
      await api().delete(`/api/v1/admin/services/listeners/${id}`);
      process.stdout.write(`Listener gelöscht: ${id}\n`);
    });

  l.command('restore-defaults <service>').description('Standard-Ports eines Dienstes wiederherstellen')
    .action(async (service: string) => {
      const svc = LISTENER_SERVICES[service.toLowerCase()] ?? fail(`Unbekannter Dienst: ${service}`);
      const r = await api().post(`/api/v1/admin/services/listeners/${svc.slug}/restore-defaults`);
      if (json()) { printJson(r); return; }
      process.stdout.write(`Standard-Listener für ${svc.label} wiederhergestellt\n`);
    });
}
