/** `coremail smtp …` — SMTP-Einstellungen, derzeit Banner. */
import { Command } from 'commander';
import type { CoreMailClient } from '../client.js';
import { printJson } from '../output.js';

interface SmtpSettings { bannerOverride: boolean; bannerText: string; [k: string]: unknown }

export function registerSmtp(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const smtp = program.command('smtp').description('SMTP-Einstellungen (Banner)');
  const banner = smtp.command('banner').description('SMTP-Begrüßungs-Banner anzeigen/setzen/zurücksetzen');

  banner.command('show', { isDefault: true }).description('Aktuelles Banner')
    .action(async () => {
      const s = await api().get<SmtpSettings>('/api/v1/admin/smtp-config/settings');
      if (json()) { printJson({ bannerOverride: s.bannerOverride, bannerText: s.bannerText }); return; }
      process.stdout.write(s.bannerOverride
        ? `Banner (überschrieben): ${s.bannerText}\n`
        : 'Banner: Standard (220 <publicHostname> ESMTP CoreMail) — kein Override gesetzt\n');
    });

  banner.command('set <text>').description('Banner-Text setzen (max. 255 Zeichen), z. B. "mail.example.de ESMTP"')
    .action(async (text: string) => {
      if (text.length > 255) throw new Error('Banner darf höchstens 255 Zeichen haben');
      await api().put('/api/v1/admin/smtp-config/settings', { bannerOverride: true, bannerText: text });
      process.stdout.write(`SMTP-Banner gesetzt: ${text}\n`);
    });

  banner.command('reset').description('Banner auf Standard zurücksetzen')
    .action(async () => {
      await api().put('/api/v1/admin/smtp-config/settings', { bannerOverride: false });
      process.stdout.write('SMTP-Banner auf Standard zurückgesetzt\n');
    });
}
