/** `coremail cert …` — TLS-Zertifikate: anzeigen, Self-Signed, Let's Encrypt, aktivieren, erneuern, löschen. */
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
  if (!c) throw new Error(`Zertifikat nicht gefunden: ${ref}`);
  return c;
}

export function registerCert(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const cert = program.command('cert').alias('certificate').description('TLS-Zertifikate anzeigen, erstellen, aktivieren, erneuern, löschen');

  cert.command('list').alias('ls').description('Alle Zertifikate')
    .action(async () => {
      const certs = await api().get<Cert[]>('/api/v1/admin/certificates');
      if (json()) { printJson(certs); return; }
      printTable(certs.map((c) => ({
        name: c.name, type: c.type, status: c.status, domains: c.domains.join(' '), expires: formatDate(c.expiresAt),
        https: c.isActiveHttps, proto: c.isActiveProtocol, services: c.services.join(' '), id: c.id,
      })), [
        { key: 'name', label: 'Name' }, { key: 'type', label: 'Typ' }, { key: 'status', label: 'Status' }, { key: 'domains', label: 'Domains' },
        { key: 'expires', label: 'Läuft ab' }, { key: 'https', label: 'HTTPS' }, { key: 'proto', label: 'SMTP/IMAP/POP3' }, { key: 'services', label: 'Dienste' }, { key: 'id', label: 'ID' },
      ]);
    });

  cert.command('show <id|name|domain>').description('Details eines Zertifikats')
    .action(async (ref: string) => {
      const c = await resolveCert(api(), ref);
      if (json()) { printJson(c); return; }
      process.stdout.write([
        `ID:            ${c.id}`, `Name:          ${c.name}`, `Typ:           ${c.type}`, `Status:        ${c.status}`,
        `Domains:       ${c.domains.join(', ')}`, `Dienste:       ${c.services.join(', ') || '—'}`,
        `Ausgestellt:   ${formatDate(c.issuedAt)}`, `Läuft ab:      ${formatDate(c.expiresAt)}`,
        `Auto-Renew:    ${c.autoRenew ? 'ja' : 'nein'}`, `HTTPS-Proxy:   ${c.isActiveHttps ? 'aktiv' : '—'}`, `Protokoll-TLS: ${c.isActiveProtocol ? 'aktiv (SMTP/IMAP/POP3)' : '—'}`,
        ...(c.acmeEmail ? [`ACME-E-Mail:   ${c.acmeEmail}`] : []), ...(c.lastError ? [`Letzter Fehler: ${c.lastError}`] : []), '',
      ].join('\n'));
    });

  cert.command('create-self-signed').alias('self-signed').description('Selbstsigniertes Zertifikat erzeugen')
    .requiredOption('--domains <list>', 'Hostnames, kommagetrennt (erster = CN)')
    .option('--name <name>', 'Anzeigename (Default: erster Hostname)')
    .option('--services <list>', `Dienste zuordnen, kommagetrennt (${SERVICES.join(', ')})`)
    .option('--days <n>', 'Gültigkeit in Tagen', '365')
    .action(async (opts: { domains: string; name?: string; services?: string; days: string }) => {
      const domains = splitList(opts.domains);
      if (!domains.length) fail('--domains erforderlich');
      const r = await api().post<Cert>('/api/v1/admin/certificates/self-signed', {
        name: opts.name ?? domains[0], domains, services: splitList(opts.services).map((s) => s.toUpperCase()), days: parseInt(opts.days, 10),
      });
      if (json()) { printJson(r); return; }
      process.stdout.write(`Self-Signed-Zertifikat erstellt: ${r.name} (${r.id}), läuft ab ${formatDate(r.expiresAt)}\n`);
    });

  cert.command('letsencrypt').alias('acme').description("Let's-Encrypt-Zertifikat anfordern (HTTP-01 — Port 80 muss auf CoreMail zeigen)")
    .requiredOption('--domains <list>', 'Hostnames, kommagetrennt (max. 10)')
    .requiredOption('--email <email>', 'Kontakt-E-Mail für ACME')
    .option('--name <name>', 'Anzeigename (Default: erster Hostname)')
    .option('--services <list>', `Dienste zuordnen (${SERVICES.join(', ')})`)
    .option('--no-auto-renew', 'nicht automatisch erneuern')
    .option('--staging', "Let's Encrypt Staging (Test, nicht vertrauenswürdig)")
    .action(async (opts: { domains: string; email: string; name?: string; services?: string; autoRenew: boolean; staging?: boolean }) => {
      const domains = splitList(opts.domains);
      const r = await api().post<Cert>('/api/v1/admin/certificates/letsencrypt', {
        name: opts.name ?? domains[0], domains, email: opts.email, services: splitList(opts.services).map((s) => s.toUpperCase()),
        autoRenew: opts.autoRenew, staging: !!opts.staging,
      });
      if (json()) { printJson(r); return; }
      process.stdout.write(`ACME-Anforderung gestartet: ${r.name} (${r.id}), Status ${r.status}. Fortschritt: coremail cert show ${r.id}\n`);
    });

  cert.command('activate <id|name|domain>').description('Zertifikat aktivieren: --https (Proxy Port 443) und/oder --protocol (SMTP/IMAP/POP3)')
    .option('--https', 'für den integrierten HTTPS-Proxy').option('--protocol', 'für SMTP/IMAP/POP3')
    .action(async (ref: string, opts: { https?: boolean; protocol?: boolean }) => {
      if (!opts.https && !opts.protocol) fail('--https und/oder --protocol angeben');
      const c = await resolveCert(api(), ref);
      if (opts.https) { await api().post(`/api/v1/admin/certificates/${c.id}/activate-https`); process.stdout.write(`${c.name}: für HTTPS-Proxy aktiviert\n`); }
      if (opts.protocol) { await api().post(`/api/v1/admin/certificates/${c.id}/activate-protocol`); process.stdout.write(`${c.name}: für SMTP/IMAP/POP3 aktiviert\n`); }
    });

  cert.command('deactivate-https <id|name|domain>').description('HTTPS-Proxy-Aktivierung aufheben')
    .action(async (ref: string) => {
      const c = await resolveCert(api(), ref);
      await api().delete(`/api/v1/admin/certificates/${c.id}/activate-https`);
      process.stdout.write(`${c.name}: HTTPS-Aktivierung aufgehoben\n`);
    });

  cert.command('renew <id|name|domain>').description("Let's-Encrypt-Zertifikat jetzt erneuern")
    .action(async (ref: string) => {
      const c = await resolveCert(api(), ref);
      const r = await api().post<Cert>(`/api/v1/admin/certificates/${c.id}/renew`);
      if (json()) { printJson(r); return; }
      process.stdout.write(`Erneuerung gestartet: ${c.name} (Status ${r.status ?? 'RENEWING'})\n`);
    });

  cert.command('delete <id|name|domain>').alias('rm').description('Zertifikat löschen (aktive Protokoll-Bindung fällt auf Self-Signed zurück)')
    .option('-y, --yes', 'ohne Rückfrage')
    .action(async (ref: string, opts: { yes?: boolean }) => {
      const c = await resolveCert(api(), ref);
      if (!await confirm(`Zertifikat ${c.name} (${c.domains.join(', ')}) löschen?`, !!opts.yes)) { process.stdout.write('Abgebrochen.\n'); return; }
      await api().delete(`/api/v1/admin/certificates/${c.id}`);
      process.stdout.write(`Zertifikat gelöscht: ${c.name}\n`);
    });
}
