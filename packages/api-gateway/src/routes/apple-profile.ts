/**
 * Apple configuration profile (.mobileconfig) for iPhone / iPad / Mac (v8.1).
 *
 *   GET /api/v1/user/apple-profile            → IMAP + SMTP (com.apple.mail.managed),
 *                                               CalDAV (com.apple.caldav.account),
 *                                               CardDAV (com.apple.carddav.account)
 *   GET /api/v1/user/apple-profile?type=eas   → Exchange ActiveSync (com.apple.eas.account):
 *                                               mail, calendar and contacts in one account
 *
 * Authenticated (MWA session, Bearer header — the MWA downloads it via fetch, never with
 * a token in the URL). The profile carries the account address but NO password: the
 * device asks for it on install. With MFA on, that must be an app password (mentioned in
 * the profile description). Payload UUIDs and identifiers are stable per user, so
 * installing a newer download replaces the earlier profile instead of adding a second
 * account. The profile is unsigned; signing it with the server certificate (CMS / PKCS#7)
 * is possible later and would only change how iOS labels it ("Verified").
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const appleProfileRouter: RouterType = Router();

// ── Minimal property-list (XML plist 1.0) writer ──────────────────────────────

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function plistEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

function plistNode(v: PlistValue, indent: string): string {
  const next = `${indent}\t`;
  if (typeof v === 'string') return `${indent}<string>${plistEscape(v)}</string>`;
  if (typeof v === 'boolean') return `${indent}<${v ? 'true' : 'false'}/>`;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('plist: only integers are supported');
    return `${indent}<integer>${v}</integer>`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return `${indent}<array/>`;
    return [`${indent}<array>`, ...v.map((x) => plistNode(x, next)), `${indent}</array>`].join('\n');
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return `${indent}<dict/>`;
  return [
    `${indent}<dict>`,
    ...keys.flatMap((k) => [`${next}<key>${plistEscape(k)}</key>`, plistNode(v[k]!, next)]),
    `${indent}</dict>`,
  ].join('\n');
}

export function toPlist(root: PlistValue): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistNode(root, ''),
    '</plist>',
    '',
  ].join('\n');
}

// ── Profile builder ───────────────────────────────────────────────────────────

/** Deterministic UUID (name-based, version 5 layout over SHA-256) — stable per user + payload. */
export function stableUuid(...parts: string[]): string {
  const h = createHash('sha256').update(`coremail-apple-profile\0${parts.join('\0')}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex').toUpperCase();
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export interface AppleProfileInput {
  userId: string;
  email: string;
  displayName: string;
  orgName: string;
  publicHostname: string;
  useHttps: boolean;
  httpPort: number;
  imap: { host: string; port: number; ssl: boolean };
  smtp: { host: string; port: number; tls: boolean };
  easUrl: string;
  requiresAppPassword: boolean;
}

export type AppleProfileType = 'imap' | 'eas';

/** Reverse-DNS prefix from the public hostname (mail.example.com → com.example.mail). */
function reverseDns(host: string): string {
  const labels = host.toLowerCase().split('.').map((l) => l.replace(/[^a-z0-9-]/g, '')).filter(Boolean);
  return labels.length ? labels.reverse().join('.') : 'local.coremail';
}

export function buildAppleProfile(p: AppleProfileInput, type: AppleProfileType = 'imap'): string {
  const idBase = `${reverseDns(p.publicHostname)}.coremail.${p.userId.replace(/[^A-Za-z0-9-]/g, '')}`;
  const org = p.orgName.trim() || 'CoreMail';
  const name = p.displayName.trim() || p.email;
  const davSsl = p.useHttps;
  const davPort = p.httpPort > 0 ? p.httpPort : (davSsl ? 443 : 80);
  const std = (davSsl && davPort === 443) || (!davSsl && davPort === 80);
  const webBase = `${davSsl ? 'https' : 'http'}://${p.publicHostname}${std ? '' : `:${davPort}`}`;
  const passwordHint = p.requiresAppPassword
    ? 'Multi-factor authentication is on for this account: when the device asks for a password, enter an app password (webmail → Settings → App passwords), not your login password.'
    : 'The device asks for your password when you install the profile. If you turn on multi-factor authentication later, use an app password instead.';

  const payload = (kind: string, type: string, display: string, body: Record<string, PlistValue>): Record<string, PlistValue> => ({
    PayloadType: type,
    PayloadVersion: 1,
    PayloadIdentifier: `${idBase}.${kind}`,
    PayloadUUID: stableUuid(p.userId, kind),
    PayloadDisplayName: display,
    PayloadDescription: `${display} for ${p.email}`,
    PayloadOrganization: org,
    ...body,
  });

  let content: Record<string, PlistValue>[];
  if (type === 'eas') {
    let host = p.publicHostname;
    let ssl = davSsl;
    try {
      const u = new URL(p.easUrl);
      host = u.host;
      ssl = u.protocol === 'https:';
    } catch { /* keep the public hostname */ }
    content = [payload('eas', 'com.apple.eas.account', `${org} (Exchange ActiveSync)`, {
      EmailAddress: p.email,
      UserName: p.email,
      Host: host,
      SSL: ssl,
      MailNumberOfPastDaysToSync: 30,
    })];
  } else {
    content = [
      payload('mail', 'com.apple.mail.managed', `${org} Mail`, {
        EmailAccountType: 'EmailTypeIMAP',
        EmailAccountDescription: `${org} (${p.email})`,
        EmailAccountName: name,
        EmailAddress: p.email,
        IncomingMailServerHostName: p.imap.host,
        IncomingMailServerPortNumber: p.imap.port,
        IncomingMailServerUseSSL: p.imap.ssl,
        IncomingMailServerAuthentication: 'EmailAuthPassword',
        IncomingMailServerUsername: p.email,
        OutgoingMailServerHostName: p.smtp.host,
        OutgoingMailServerPortNumber: p.smtp.port,
        // Apple: true = TLS (implicit on 465, STARTTLS otherwise)
        OutgoingMailServerUseSSL: p.smtp.tls || p.smtp.port === 465,
        OutgoingMailServerAuthentication: 'EmailAuthPassword',
        OutgoingMailServerUsername: p.email,
        OutgoingPasswordSameAsIncomingPassword: true,
      }),
      payload('caldav', 'com.apple.caldav.account', `${org} Calendar`, {
        CalDAVAccountDescription: `${org} Calendar`,
        CalDAVHostName: p.publicHostname,
        CalDAVPort: davPort,
        CalDAVUseSSL: davSsl,
        CalDAVPrincipalURL: `${webBase}/dav/principals/${encodeURIComponent(p.userId)}/`,
        CalDAVUsername: p.email,
      }),
      payload('carddav', 'com.apple.carddav.account', `${org} Contacts`, {
        CardDAVAccountDescription: `${org} Contacts`,
        CardDAVHostName: p.publicHostname,
        CardDAVPort: davPort,
        CardDAVUseSSL: davSsl,
        CardDAVPrincipalURL: `${webBase}/dav/principals/${encodeURIComponent(p.userId)}/`,
        CardDAVUsername: p.email,
      }),
    ];
  }

  const profileKind = type === 'eas' ? 'profile-eas' : 'profile';
  return toPlist({
    PayloadType: 'Configuration',
    PayloadVersion: 1,
    PayloadIdentifier: `${idBase}.${profileKind}`,
    PayloadUUID: stableUuid(p.userId, profileKind),
    PayloadDisplayName: type === 'eas' ? `${org} — ${p.email} (ActiveSync)` : `${org} — ${p.email}`,
    PayloadDescription: (type === 'eas'
      ? `Sets up ${p.email} with Exchange ActiveSync (mail, calendar, contacts). `
      : `Sets up ${p.email} for Mail (IMAP/SMTP), Calendar (CalDAV) and Contacts (CardDAV). `) + passwordHint,
    PayloadOrganization: org,
    PayloadRemovalDisallowed: false,
    PayloadContent: content,
  });
}

/** Safe file name for Content-Disposition. */
function fileName(email: string, type: AppleProfileType): string {
  const domain = (email.split('@')[1] ?? 'coremail').replace(/[^A-Za-z0-9.-]/g, '_') || 'coremail';
  return `${domain}${type === 'eas' ? '-activesync' : ''}.mobileconfig`;
}

// ── Route ─────────────────────────────────────────────────────────────────────

appleProfileRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const typeParam = req.query['type'];
  if (typeParam !== undefined && typeParam !== 'eas' && typeParam !== 'imap') {
    res.status(400).json({ error: 'type must be imap or eas' });
    return;
  }
  const type: AppleProfileType = typeParam === 'eas' ? 'eas' : 'imap';

  const [settings, user, mfa] = await Promise.all([
    prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: {
        publicHostname: true, useHttps: true, httpPort: true, orgName: true, easUrl: true,
        imapHost: true, imapPort: true, imapSsl: true,
        smtpHost: true, smtpPort: true, smtpTls: true,
      },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true } }),
    prisma.userMfa.findUnique({
      where: { userId },
      select: { totpEnabled: true, webAuthnCredentials: true },
    }).catch(() => null),
  ]);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  // Same rule as GET /user/client-config
  const requiresAppPassword = !!(mfa?.totpEnabled || (mfa?.webAuthnCredentials &&
    typeof mfa.webAuthnCredentials === 'string' && mfa.webAuthnCredentials.length > 2));
  const hostname = settings?.publicHostname ?? 'mail.local';
  const useHttps = settings ? settings.useHttps : true;

  const body = buildAppleProfile({
    userId,
    email: user.email,
    displayName: user.displayName,
    orgName: settings?.orgName ?? 'CoreMail',
    publicHostname: hostname,
    useHttps,
    httpPort: settings?.httpPort ?? (useHttps ? 443 : 80),
    imap: { host: settings?.imapHost ?? hostname, port: settings?.imapPort ?? 993, ssl: settings?.imapSsl ?? true },
    smtp: { host: settings?.smtpHost ?? hostname, port: settings?.smtpPort ?? 587, tls: settings?.smtpTls ?? true },
    easUrl: settings?.easUrl ?? `https://${hostname}/Microsoft-Server-ActiveSync`,
    requiresAppPassword,
  }, type);

  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `attachment; filename="${fileName(user.email, type)}"`);
  res.type('application/x-apple-aspen-config').send(body);
});
