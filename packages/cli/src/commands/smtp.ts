/** `coremail smtp …` — SMTP settings, currently the banner. */
import { Command } from 'commander';
import type { CoreMailClient } from '../client.js';
import { printJson } from '../output.js';

interface SmtpSettings { bannerOverride: boolean; bannerText: string; [k: string]: unknown }

export function registerSmtp(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const smtp = program.command('smtp').description('SMTP settings (banner)');
  const banner = smtp.command('banner').description('Show, set or reset the SMTP greeting banner');

  banner.command('show', { isDefault: true }).description('Current banner')
    .action(async () => {
      const s = await api().get<SmtpSettings>('/api/v1/admin/smtp-config/settings');
      if (json()) { printJson({ bannerOverride: s.bannerOverride, bannerText: s.bannerText }); return; }
      process.stdout.write(s.bannerOverride
        ? `Banner (override): ${s.bannerText}\n`
        : 'Banner: default (220 <publicHostname> ESMTP CoreMail) — no override set\n');
    });

  banner.command('set <text>').description('Set the banner text (max. 255 characters), e.g. "mail.example.com ESMTP"')
    .action(async (text: string) => {
      if (text.length > 255) throw new Error('Banner may have at most 255 characters');
      await api().put('/api/v1/admin/smtp-config/settings', { bannerOverride: true, bannerText: text });
      process.stdout.write(`SMTP banner set: ${text}\n`);
    });

  banner.command('reset').description('Reset the banner to the default')
    .action(async () => {
      await api().put('/api/v1/admin/smtp-config/settings', { bannerOverride: false });
      process.stdout.write('SMTP banner reset to default\n');
    });
}
