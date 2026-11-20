/**
 * 9.4: which parts of Settings → External clients are shown — only protocols
 * switched on for the account (GET /user/client-config → `protocols`).
 */
import type { AppleProfileKind } from './appleProfile.ts';

/** `protocols` of GET /user/client-config (missing: an older server, everything on). */
export interface ClientProtocols {
  imap: boolean;
  pop3: boolean;
  smtp: boolean;
  activesync: boolean;
  dav: boolean;
}

export interface ExternalClientSections {
  /** The e-mail card (IMAP / SMTP / POP3 rows inside follow their own switch). */
  mail: boolean;
  /** CalDAV + CardDAV cards, the desktop-client calendar hint and the CalDav Synchronizer guide. */
  dav: boolean;
  /** Apple profile variants that have something to set up (same rule as the server). */
  profiles: AppleProfileKind[];
  /** Anything to show at all. */
  any: boolean;
}

const ALL_ON: ClientProtocols = { imap: true, pop3: true, smtp: true, activesync: true, dav: true };

export function externalClientSections(protocols: ClientProtocols | undefined): ExternalClientSections {
  const p = protocols ?? ALL_ON;
  const mail = p.imap || p.pop3 || p.smtp;
  const profiles: AppleProfileKind[] = [
    ...(p.imap || p.pop3 || p.dav ? ['imap' as const] : []),
    ...(p.activesync ? ['eas' as const] : []),
  ];
  return { mail, dav: p.dav, profiles, any: mail || p.dav || profiles.length > 0 };
}
