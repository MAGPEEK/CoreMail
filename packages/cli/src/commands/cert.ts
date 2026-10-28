/** `coremail cert …` — TLS certificates: list, self-signed, Let's Encrypt, activate, renew, delete. */
import { Command } from 'commander';
import type { CoreMailClient } from '../client.js';
import { confirm, fail, formatDate, printJson, printTable } from '../output.js';

interface Cert {
  id: string; name: string; domains: string[]; services: string[]; type: string; status: string;
  issuedAt: string | null; expiresAt: string | null; autoRenew: boolean; isActiveHttps: boolean; isActiveProtocol: boolean;
  acmeEmail: string | null; lastError: string | null; createdAt: string;
}

const SERVICES = ['SMTP', 'IMAP', 'POP3', 'OWA', 'ECP', 'EWS', 'DAV'];

function splitList(s?: string): string[] {
  return (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

async function resolveCert(api: CoreMailClient, ref: string): Promise<Cert> {
  const certs = await api.get<Cert[]>('/api/v1/admin/certificates');
  const c = certs.find((x) => x.id === ref || x.name === ref || x.domains.includes(ref));
  if (!c) throw new Error(`Certificate not found: ${ref}`);
  return c;
}

export function registerCert(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const cert = program.command('cert').alias('certificate').description('List, create, activate, renew and delete TLS certificates');

  cert.command('list').alias('ls').description('All certificates')
    .action(async () => {
      const certs = await api().get<Cert[]>('/api/v1/admin/certificates');
      if (json()) { printJson(certs); return; }
      printTable(certs.map((c) => ({
        name: c.name, type: c.type, status: c.status, domains: c.domains.join(' '), expires: formatDate(c.expiresAt),
        https: c.isActiveHttps, proto: c.isActiveProtocol, services: c.services.join(' '), id: c.id,
      })), [
        { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'domains', label: 'Domains' },
        { key: 'expires', label: 'Expires' }, { key: 'https', label: 'HTTPS' }, { key: 'proto', label: 'SMTP/IMAP/POP3' }, { key: 'services', label: 'Services' }, { key: 'id', label: 'ID' },
      ]);
    });

  cert.command('show <id|name|domain>').description('Details of a certificate')
    .action(async (ref: string) => {
      const c = await resolveCert(api(), ref);
      if (json()) { printJson(c); return; }
      process.stdout.write([
        `ID:            ${c.id}`, `Name:          ${c.name}`, `Type:          ${c.type}`, `Status:        ${c.status}`,
        `Domains:       ${c.domains.join(', ')}`, `Services:      ${c.services.join(', ') || '—'}`,
        `Issued:        ${formatDate(c.issuedAt)}`, `Expires:       ${formatDate(c.expiresAt)}`,
        `Auto-renew:    ${c.autoRenew ? 'yes' : 'no'}`, `HTTPS proxy:   ${c.isActiveHttps ? 'active' : '—'}`, `Protocol TLS:  ${c.isActiveProtocol ? 'active (SMTP/IMAP/POP3)' : '—'}`,
        ...(c.acmeEmail ? [`ACME email:    ${c.acmeEmail}`] : []), ...(c.lastError ? [`Last error:    ${c.lastError}`] : []), '',
      ].join('\n'));
    });

  cert.command('create-self-signed').alias('self-signed').description('Create a self-signed certificate')
    .requiredOption('--domains <list>', 'hostnames, comma-separated (first = CN)')
    .option('--name <name>', 'display name (default: first hostname)')
    .option('--services <list>', `assign services, comma-separated (${SERVICES.join(', ')})`)
    .option('--days <n>', 'validity in days', '365')
    .action(async (opts: { domains: string; name?: string; services?: string; days: string }) => {
      const domains = splitList(opts.domains);
      if (!domains.length) fail('--domains required');
      const r = await api().post<Cert>('/api/v1/admin/certificates/self-signed', {
        name: opts.name ?? domains[0], domains, services: splitList(opts.services).map((s) => s.toUpperCase()), days: parseInt(opts.days, 10),
      });
      if (json()) { printJson(r); return; }
      process.stdout.write(`Self-signed certificate created: ${r.name} (${r.id}), expires ${formatDate(r.expiresAt)}\n`);
    });

  cert.command('letsencrypt').alias('acme').description("Request a Let's Encrypt certificate (HTTP-01 — port 80 must point to CoreMail)")
    .requiredOption('--domains <list>', 'hostnames, comma-separated (max. 10)')
    .requiredOption('--email <email>', 'contact email for ACME')
    .option('--name <name>', 'display name (default: first hostname)')
    .option('--services <list>', `assign services (${SERVICES.join(', ')})`)
    .option('--no-auto-renew', 'do not renew automatically')
    .option('--staging', "Let's Encrypt staging (test, not trusted)")
    .action(async (opts: { domains: string; email: string; name?: string; services?: string; autoRenew: boolean; staging?: boolean }) => {
      const domains = splitList(opts.domains);
      const r = await api().post<Cert>('/api/v1/admin/certificates/letsencrypt', {
        name: opts.name ?? domains[0], domains, email: opts.email, services: splitList(opts.services).map((s) => s.toUpperCase()),
        autoRenew: opts.autoRenew, staging: !!opts.staging,
      });
      if (json()) { printJson(r); return; }
      process.stdout.write(`ACME request started: ${r.name} (${r.id}), status ${r.status}. Progress: coremail cert show ${r.id}\n`);
    });

  cert.command('activate <id|name|domain>').description('Activate a certificate: --https (proxy port 443) and/or --protocol (SMTP/IMAP/POP3)')
    .option('--https', 'for the integrated HTTPS proxy').option('--protocol', 'for SMTP/IMAP/POP3')
    .action(async (ref: string, opts: { https?: boolean; protocol?: boolean }) => {
      if (!opts.https && !opts.protocol) fail('pass --https and/or --protocol');
      const c = await resolveCert(api(), ref);
      if (opts.https) { await api().post(`/api/v1/admin/certificates/${c.id}/activate-https`); process.stdout.write(`${c.name}: activated for HTTPS proxy\n`); }
      if (opts.protocol) { await api().post(`/api/v1/admin/certificates/${c.id}/activate-protocol`); process.stdout.write(`${c.name}: activated for SMTP/IMAP/POP3\n`); }
    });

  cert.command('deactivate-https <id|name|domain>').description('Remove the HTTPS proxy activation')
    .action(async (ref: string) => {
      const c = await resolveCert(api(), ref);
      await api().delete(`/api/v1/admin/certificates/${c.id}/activate-https`);
      process.stdout.write(`${c.name}: HTTPS activation removed\n`);
    });

  cert.command('renew <id|name|domain>').description("Renew a Let's Encrypt certificate now")
    .action(async (ref: string) => {
      const c = await resolveCert(api(), ref);
      const r = await api().post<Cert>(`/api/v1/admin/certificates/${c.id}/renew`);
      if (json()) { printJson(r); return; }
      process.stdout.write(`Renewal started: ${c.name} (status ${r.status ?? 'RENEWING'})\n`);
    });

  cert.command('delete <id|name|domain>').alias('rm').description('Delete a certificate (an active protocol binding falls back to self-signed)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (ref: string, opts: { yes?: boolean }) => {
      const c = await resolveCert(api(), ref);
      if (!await confirm(`Delete certificate ${c.name} (${c.domains.join(', ')})?`, !!opts.yes)) { process.stdout.write('Aborted.\n'); return; }
      await api().delete(`/api/v1/admin/certificates/${c.id}`);
      process.stdout.write(`Certificate deleted: ${c.name}\n`);
    });
}
