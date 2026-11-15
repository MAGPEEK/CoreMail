/**
 * Apple configuration profile download (v8.1) — path + suggested file name.
 * Desktop: the download goes through fetchBlob() (Authorization header, never a token
 * in the URL). 9.1 iOS / iPadOS: Safari hands a .mobileconfig to its profile installer
 * only on a plain navigation, so the MWA fetches a single-use ticket
 * (POST /user/apple-profile/ticket, 60 s) and navigates to appleProfileTicketUrl().
 * No imports — unit-tested with `node --test`.
 */
export type AppleProfileKind = 'imap' | 'eas';

/** API path (relative to /api/v1) of the profile for the signed-in user. */
export function appleProfilePath(kind: AppleProfileKind): string {
  return kind === 'eas' ? '/user/apple-profile?type=eas' : '/user/apple-profile';
}

/** API path (relative to /api/v1) that issues the single-use download ticket. */
export const APPLE_PROFILE_TICKET_PATH = '/user/apple-profile/ticket';

/** Absolute-path URL Safari navigates to (ticket instead of a token). */
export function appleProfileTicketUrl(kind: AppleProfileKind, ticket: string, apiBase = '/api/v1'): string {
  const q = new URLSearchParams();
  if (kind === 'eas') q.set('type', 'eas');
  q.set('ticket', ticket);
  return `${apiBase}/user/apple-profile?${q.toString()}`;
}

/**
 * iPhone / iPod / iPad, including iPadOS 13+ which reports a desktop Mac user agent
 * ("Macintosh") but has a touch screen. A real Mac has maxTouchPoints 0 and keeps the
 * blob download (macOS opens downloaded profiles from System Settings).
 */
export function isAppleMobileDevice(userAgent: string, maxTouchPoints = 0): boolean {
  if (/\b(iPhone|iPad|iPod)\b/i.test(userAgent)) return true;
  return /\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1;
}

/** Suggested file name — same rule as the server's Content-Disposition. */
export function appleProfileFileName(email: string, kind: AppleProfileKind): string {
  const domain = (email.split('@')[1] ?? '').replace(/[^A-Za-z0-9.-]/g, '_') || 'coremail';
  return `${domain}${kind === 'eas' ? '-activesync' : ''}.mobileconfig`;
}
