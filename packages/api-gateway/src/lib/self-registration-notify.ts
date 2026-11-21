/**
 * 10.6: admin notice for self-registrations waiting for approval
 * (docs/self-registration.md). Reuses the admin-notice mail path of the attack
 * protection: the same recipients (BCP → Angriffsschutz → Benachrichtigung,
 * else ServerSettings.adminEmail, else the Organization Management admins) and
 * the same delivery (a local recipient gets it straight into the INBOX, any
 * other address through the outbound queue).
 *
 * At most one notice per NOTICE_INTERVAL_SEC — a burst of registrations never
 * becomes a burst of mails; the BCP list always shows every pending account.
 * Never throws (fire-and-forget).
 */
import { createLogger } from '@coremail/core';
import { attackNoticeRecipients, loadAttackProtectionSettings, prisma, getProductName, brandDisplayName } from '@coremail/storage';
import { authRedis } from '@coremail/storage/auth';

const log = createLogger('self-registration');

export const NOTICE_GATE_KEY = 'selfreg:notify:gate';
export const NOTICE_INTERVAL_SEC = 15 * 60;

export interface PendingNotice { email: string; domain: string }

export type RegistrationNotifier = (n: PendingNotice) => Promise<void>;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Pure: the German notice text (like the other admin notices). */
export function buildPendingNotice(n: PendingNotice, opts: { host: string; product: string }): { subject: string; text: string; html: string } {
  const link = `https://${opts.host}/bcp/authentication/self-registration`;
  const subject = `[${opts.product}] Neue Registrierung wartet auf Freigabe`;
  const lines = [
    `Auf ${opts.host} wurde ein Konto über die Selbstregistrierung angelegt und wartet auf Freigabe:`,
    '',
    `  ${n.email} (Domain ${n.domain})`,
    '',
    'Weitere Registrierungen der nächsten 15 Minuten werden nicht einzeln gemeldet.',
    `Freigeben oder ablehnen: BCP → Authentifizierung → Selbstregistrierung — ${link}`,
    '',
  ];
  const html = [
    `<p>${esc(lines[0]!)}</p>`,
    `<p><strong>${esc(n.email)}</strong> (Domain ${esc(n.domain)})</p>`,
    `<p style="font-size:12px">${esc(lines[4]!)}<br>${esc(lines[5]!)}</p>`,
  ].join('\n');
  return { subject, text: lines.join('\n'), html };
}

async function defaultNotifier(n: PendingNotice): Promise<void> {
  const settings = await loadAttackProtectionSettings();
  const recipients = [...new Set((await attackNoticeRecipients(settings)).map((r) => r.trim().toLowerCase()).filter(Boolean))];
  if (recipients.length === 0) { log.warn('registration notice dropped — no recipient'); return; }
  const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true, orgName: true } });
  const notice = buildPendingNotice(n, {
    host: s?.publicHostname || 'mail.local',
    product: brandDisplayName(await getProductName(), s?.orgName),
  });
  const { deliverAttackNotice } = await import('./attack-protection-worker.js');
  for (const rcpt of recipients) {
    await deliverAttackNotice(rcpt, notice).catch((err: unknown) => log.warn({ err, rcpt }, 'registration notice could not be delivered'));
  }
}

let notifier: RegistrationNotifier = defaultNotifier;

/** Test seam: replaces the delivery (null = the production path). */
export function setRegistrationNotifier(fn: RegistrationNotifier | null): void {
  notifier = fn ?? defaultNotifier;
}

/** Sends the notice unless one went out within NOTICE_INTERVAL_SEC. Never throws. */
export async function notifyPendingRegistration(n: PendingNotice): Promise<boolean> {
  try {
    const redis = authRedis();
    const count = await redis.incr(NOTICE_GATE_KEY);
    if (count === 1) await redis.expire(NOTICE_GATE_KEY, NOTICE_INTERVAL_SEC);
    if (count !== 1) return false;
    await notifier(n);
    return true;
  } catch (err) {
    log.warn({ err }, 'registration notice failed');
    return false;
  }
}
