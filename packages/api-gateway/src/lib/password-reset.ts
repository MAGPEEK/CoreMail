/**
 * 10.6: self-service password reset — the work behind POST /auth/forgot-password
 * and the mails of the reset and of the recovery address (docs/password-reset.md).
 *
 * The route answers `{ ok: true }` BEFORE any lookup and runs
 * requestPasswordReset() afterwards, so neither the body nor the response time
 * depends on the account (no enumeration). The decision itself lives in
 * storage auth/sspr.ts; this module adds:
 *   - attack protection: blocked or locked client IPs are ignored silently;
 *     rate-limit hits are recorded as security events (attack dashboard)
 *   - delivery: the confirmed recovery address by SMTP submission; the own
 *     mailbox by a direct INBOX write (no rules / forwarding can pass the link on)
 *   - audit rows `auth.password-reset.*` / `auth.recovery-email.*` (always logged)
 *
 * Test seam: setResetMailer(fn) replaces the SMTP delivery.
 */
import { createTransport } from 'nodemailer';
import { prisma, getProductName, brandDisplayName, connectGuard, recordSecurityEvent } from '@coremail/storage';
import {
  authRedis,
  createPasswordResetToken,
  loadSsprPolicy,
  notifySecurityEvent,
  planPasswordReset,
  RESET_TOKEN_TTL,
  RECOVERY_CONFIRM_TTL,
  getRecoveryEmailState,
  type ResetChannel,
} from '@coremail/storage/auth';
import { createLogger } from '@coremail/core';
import { audit } from './audit.js';

const log = createLogger('api:password-reset');

/** INCR + TTL on the first hit (the auth Redis — injectable in tests). */
async function incrWithTtlForReset(key: string, ttl: number): Promise<number> {
  const r = authRedis();
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, ttl);
  return n;
}

// Rate limit: 3 requests per IP and per e-mail address per hour (unchanged since 7.0).
export const RESET_RATE_LIMIT = 3;
const RESET_RATE_WINDOW = 3600;
const RESET_RATE_PREFIX = 'pwreset:rate:';

export interface ResetMail { to: string; subject: string; text: string; html: string }
type ResetMailer = (m: ResetMail) => Promise<void>;
let mailerOverride: ResetMailer | null = null;

/** Tests: capture outgoing mails (null restores the SMTP delivery). */
export function setResetMailer(fn: ResetMailer | null): void {
  mailerOverride = fn;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface MailContext { fromAddr: string; orgName: string; base: string }

async function mailContext(): Promise<MailContext> {
  const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
  const base = settings?.useHttps
    ? `https://${settings.publicHostname}`
    : `http://${settings?.publicHostname ?? 'localhost'}:${settings?.httpPort ?? 3000}`;
  return {
    fromAddr: settings?.adminEmail?.trim() || `noreply@${settings?.publicHostname || 'mail.local'}`,
    // 9.3: the branded product name (unbranded: the organisation name)
    orgName: brandDisplayName(await getProductName(), settings?.orgName),
    base,
  };
}

/** Sends one mail to an external address via the internal SMTP submission (localhost:587). */
async function sendExternal(ctx: MailContext, m: ResetMail): Promise<void> {
  if (mailerOverride) { await mailerOverride(m); return; }
  const transport = createTransport({
    host: '127.0.0.1',
    port: 587,
    secure: false,
    ignoreTLS: true, // internal, no TLS needed
    tls: { rejectUnauthorized: false },
  });
  await transport.sendMail({ from: { name: ctx.orgName, address: ctx.fromAddr }, to: m.to, subject: m.subject, text: m.text, html: m.html });
}

function button(url: string, label: string): string {
  return `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">${escapeHtml(label)}</a></p>`;
}

function resetMail(ctx: MailContext, to: string, url: string, viaRecovery: boolean): ResetMail {
  const minutes = Math.round(RESET_TOKEN_TTL / 60);
  const org = escapeHtml(ctx.orgName);
  const why = viaRecovery
    ? 'Sie erhalten diese E-Mail, weil diese Adresse als Wiederherstellungsadresse für Ihr Konto hinterlegt ist.'
    : '';
  return {
    to,
    subject: `${ctx.orgName} — Passwort zurücksetzen`,
    text: `Guten Tag,\n\njemand (oder Sie selbst) hat eine Passwort-Zurücksetzung für Ihr Konto angefordert.${why ? `\n${why}` : ''}\n\nÖffnen Sie den folgenden Link, um ein neues Passwort zu setzen (gültig für ${minutes} Minuten):\n\n${url}\n\nFalls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren. Ihr Passwort bleibt unverändert.\n\n– ${ctx.orgName}`,
    html: `<p>Guten Tag,</p><p>jemand (oder Sie selbst) hat eine Passwort-Zurücksetzung für Ihr Konto angefordert.${why ? ` ${escapeHtml(why)}` : ''}</p>${button(url, 'Passwort zurücksetzen')}<p style="font-size:12px;color:#6b7280;">Dieser Link ist ${minutes} Minuten gültig. Falls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren. Ihr Passwort bleibt unverändert.</p><p>– ${org}</p>`,
  };
}

// ── Forgot password ──────────────────────────────────────────────────────────

export type ResetRequestOutcome =
  | 'invalid_input' | 'blocked_ip' | 'rate_limited' | 'disabled' | 'not_found'
  | 'refused' | 'sent' | 'error';

/**
 * The work of one forgot-password request (after the uniform answer). Never
 * throws. Returns the outcome for logs and tests only — never for the client.
 */
export async function requestPasswordReset(emailRaw: string, ip: string, userAgent = ''): Promise<ResetRequestOutcome> {
  const email = emailRaw.trim().toLowerCase();
  try {
    // Attack protection: block list (also refused by the HTTP guard) and the
    // shared lockout's IP lock — silently, the answer was already sent.
    if (connectGuard.isBlocked(ip) || (await connectGuard.lockedFor(ip)) > 0) {
      log.info({ ip }, 'Password reset ignored — client IP blocked or locked');
      return 'blocked_ip';
    }

    const [ipCount, emailCount] = await Promise.all([
      incrWithTtlForReset(`${RESET_RATE_PREFIX}ip:${ip}`, RESET_RATE_WINDOW),
      incrWithTtlForReset(`${RESET_RATE_PREFIX}email:${email}`, RESET_RATE_WINDOW),
    ]);
    if (ipCount > RESET_RATE_LIMIT || emailCount > RESET_RATE_LIMIT) {
      log.warn({ ip, ipCount, emailCount }, 'Password reset rate limit exceeded');
      recordSecurityEvent({ type: 'PASSWORD_RESET_RATE_LIMIT', ip, protocol: 'web', target: email, detail: { ipCount, emailCount } });
      return 'rate_limited';
    }

    const policy = await loadSsprPolicy();
    const plan = await planPasswordReset(email, policy);
    if (!plan.ok) {
      if (plan.reason === 'disabled') return 'disabled';
      if (plan.reason === 'not_found') return 'not_found';
      log.info({ userId: plan.userId, reason: plan.reason }, 'Password reset refused');
      audit({
        action: 'auth.password-reset.refused',
        targetType: 'user',
        ...(plan.userId ? { targetId: plan.userId } : {}),
        targetName: email,
        success: false,
        errorMsg: plan.reason,
        ipAddress: ip,
        userAgent,
      });
      return 'refused';
    }

    const token = await createPasswordResetToken(plan.user.id, ip);
    const ctx = await mailContext();
    const url = `${ctx.base}/reset-password?token=${token}`;
    await Promise.all(plan.channels.map((c) => deliverResetLink(ctx, plan.user.id, plan.user.email, c, url)));
    audit({
      action: 'auth.password-reset.request',
      targetType: 'user',
      targetId: plan.user.id,
      targetName: plan.user.email,
      changes: { channels: plan.channels.map((c) => c.kind).join(','), mfaRequired: String(plan.mfaRequired) },
      ipAddress: ip,
      userAgent,
    });
    log.info({ userId: plan.user.id, channels: plan.channels.map((c) => c.kind) }, 'Password reset link issued');
    return 'sent';
  } catch (err) {
    log.error({ err, ip }, 'forgot-password error');
    return 'error';
  }
}

async function deliverResetLink(ctx: MailContext, userId: string, email: string, c: ResetChannel, url: string): Promise<void> {
  try {
    if (c.kind === 'recovery') {
      await sendExternal(ctx, resetMail(ctx, c.address, url, true));
    } else {
      const m = resetMail(ctx, email, url, false);
      await notifySecurityEvent({ userId, subject: m.subject, bodyText: m.text, bodyHtml: m.html });
    }
  } catch (err) {
    log.error({ err, userId, channel: c.kind }, 'Failed to deliver password reset link');
  }
}

// ── After a reset ────────────────────────────────────────────────────────────

/** Notice after a successful reset: own mailbox AND the confirmed recovery address. Never throws. */
export async function notifyPasswordResetDone(userId: string, ip: string): Promise<void> {
  try {
    const ctx = await mailContext();
    const when = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const subject = `${ctx.orgName} — Ihr Passwort wurde zurückgesetzt`;
    const text = `Guten Tag,\n\ndas Passwort Ihres Kontos wurde am ${when} UTC über den Link „Passwort vergessen“ neu gesetzt (Anfrage von ${ip}).\nAlle Sitzungen und App-Passwörter wurden beendet; Mailprogramme brauchen ein neues App-Passwort bzw. das neue Passwort.\n\nWaren Sie das nicht, wenden Sie sich sofort an Ihren Administrator.\n\n– ${ctx.orgName}`;
    await notifySecurityEvent({ userId, subject, bodyText: text });
    const rec = await getRecoveryEmailState(userId);
    if (rec.address) {
      await sendExternal(ctx, { to: rec.address, subject, text, html: `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>` });
    }
  } catch (err) {
    log.error({ err, userId }, 'Failed to send the password reset notice');
  }
}

// ── Recovery address mails ───────────────────────────────────────────────────

/** Confirmation link to a newly entered recovery address. */
export async function sendRecoveryConfirmation(address: string, token: string, accountEmail: string): Promise<void> {
  const ctx = await mailContext();
  const url = `${ctx.base}/recovery-email/confirm?token=${token}`;
  const hours = Math.round(RECOVERY_CONFIRM_TTL / 3600);
  const text = `Guten Tag,\n\ndiese Adresse soll als Wiederherstellungsadresse für das Konto ${accountEmail} hinterlegt werden. Über sie kann das Passwort des Kontos zurückgesetzt werden.\n\nBestätigen Sie die Adresse mit diesem Link (gültig für ${hours} Stunden):\n\n${url}\n\nWenn Sie das nicht veranlasst haben, ignorieren Sie diese E-Mail — die Adresse wird dann nicht verwendet.\n\n– ${ctx.orgName}`;
  const html = `<p>Guten Tag,</p><p>diese Adresse soll als Wiederherstellungsadresse für das Konto <strong>${escapeHtml(accountEmail)}</strong> hinterlegt werden. Über sie kann das Passwort des Kontos zurückgesetzt werden.</p>${button(url, 'Adresse bestätigen')}<p style="font-size:12px;color:#6b7280;">Der Link ist ${hours} Stunden gültig. Wenn Sie das nicht veranlasst haben, ignorieren Sie diese E-Mail — die Adresse wird dann nicht verwendet.</p><p>– ${escapeHtml(ctx.orgName)}</p>`;
  await sendExternal(ctx, { to: address, subject: `${ctx.orgName} — Wiederherstellungsadresse bestätigen`, text, html });
}

export type RecoveryChange = 'requested' | 'confirmed' | 'removed';

/**
 * Notice about a change of the recovery address: always to the own mailbox, and
 * to the previously confirmed address (when there is one) — the owner learns of
 * a change made with a stolen session. Never throws.
 */
export async function notifyRecoveryChange(userId: string, kind: RecoveryChange, previous: string | null, next: string | null): Promise<void> {
  try {
    const ctx = await mailContext();
    const what = kind === 'requested'
      ? `Für Ihr Konto wurde eine neue Wiederherstellungsadresse eingetragen (${maskAddress(next)}). Sie gilt erst, wenn sie über den Link in der Bestätigungs-E-Mail bestätigt wird.`
      : kind === 'confirmed'
        ? `Die Wiederherstellungsadresse Ihres Kontos ist jetzt ${maskAddress(next)}.`
        : 'Die Wiederherstellungsadresse Ihres Kontos wurde entfernt.';
    const subject = `${ctx.orgName} — Wiederherstellungsadresse geändert`;
    const text = `Guten Tag,\n\n${what}\n\nWaren Sie das nicht, ändern Sie sofort Ihr Passwort und wenden Sie sich an Ihren Administrator.\n\n– ${ctx.orgName}`;
    await notifySecurityEvent({ userId, subject, bodyText: text });
    if (previous && previous !== next) {
      await sendExternal(ctx, { to: previous, subject, text, html: `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>` });
    }
  } catch (err) {
    log.error({ err, userId, kind }, 'Failed to send the recovery address notice');
  }
}

/** Pure: "a***@example.net" — notices never carry the full address of the other side. */
export function maskAddress(address: string | null): string {
  if (!address) return '–';
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${address[0]}***${address.slice(at)}`;
}
