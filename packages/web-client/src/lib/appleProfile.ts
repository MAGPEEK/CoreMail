/**
 * Apple configuration profile download (v8.1) — path + suggested file name.
 * The download itself goes through fetchBlob() (Authorization header, never a token
 * in the URL). No imports — unit-tested with `node --test`.
 */
export type AppleProfileKind = 'imap' | 'eas';

/** API path (relative to /api/v1) of the profile for the signed-in user. */
export function appleProfilePath(kind: AppleProfileKind): string {
  return kind === 'eas' ? '/user/apple-profile?type=eas' : '/user/apple-profile';
}

/** Suggested file name — same rule as the server's Content-Disposition. */
export function appleProfileFileName(email: string, kind: AppleProfileKind): string {
  const domain = (email.split('@')[1] ?? '').replace(/[^A-Za-z0-9.-]/g, '_') || 'coremail';
  return `${domain}${kind === 'eas' ? '-activesync' : ''}.mobileconfig`;
}
