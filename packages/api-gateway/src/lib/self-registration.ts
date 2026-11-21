/**
 * 10.6: self-registration (docs/self-registration.md) — settings, address
 * rules, invite codes and the signed form token. Pure helpers plus the
 * settings / invite reads; the HTTP side lives in routes/self-registration.ts
 * (public) and routes/admin/self-registration.ts (BCP).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '@coremail/storage';

export const SELF_REGISTRATION_MODES = ['approval', 'immediate'] as const;
export type SelfRegistrationMode = typeof SELF_REGISTRATION_MODES[number];

export interface SelfRegistrationSettings {
  enabled: boolean;
  /** Hosted domains open for registration (empty = registration impossible). */
  domainIds: string[];
  mode: SelfRegistrationMode;
  inviteOnly: boolean;
}

export const DEFAULT_SELF_REGISTRATION: Readonly<SelfRegistrationSettings> = Object.freeze({
  enabled: false, domainIds: [], mode: 'approval', inviteOnly: false,
});

/** Settings from the ServerSettings row (unknown mode → approval, the safe default). */
export function settingsFromRow(row: {
  allowSelfRegistration?: boolean | null;
  selfRegistrationDomainIds?: string[] | null;
  selfRegistrationMode?: string | null;
  selfRegistrationInviteOnly?: boolean | null;
} | null | undefined): SelfRegistrationSettings {
  if (!row) return { ...DEFAULT_SELF_REGISTRATION, domainIds: [] };
  return {
    enabled: row.allowSelfRegistration === true,
    domainIds: Array.isArray(row.selfRegistrationDomainIds) ? [...new Set(row.selfRegistrationDomainIds)] : [],
    mode: row.selfRegistrationMode === 'immediate' ? 'immediate' : 'approval',
    inviteOnly: row.selfRegistrationInviteOnly === true,
  };
}

export async function loadSelfRegistrationSettings(): Promise<SelfRegistrationSettings & { maintenanceMode: boolean; minPasswordLength: number }> {
  const row = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: {
      allowSelfRegistration: true, selfRegistrationDomainIds: true, selfRegistrationMode: true, selfRegistrationInviteOnly: true,
      maintenanceMode: true, minPasswordLength: true,
    },
  });
  return {
    ...settingsFromRow(row),
    maintenanceMode: row?.maintenanceMode === true,
    minPasswordLength: typeof row?.minPasswordLength === 'number' ? row.minPasswordLength : 8,
  };
}

/** The allowed domains that exist and are active, sorted by name. */
export async function openDomains(domainIds: readonly string[]): Promise<Array<{ id: string; name: string }>> {
  if (domainIds.length === 0) return [];
  const rows = await prisma.domain.findMany({
    where: { id: { in: [...domainIds] }, active: true },
    select: { id: true, name: true },
  });
  return rows.map((d) => ({ id: d.id, name: d.name })).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Address rules ────────────────────────────────────────────────────────────

/**
 * Names nobody may register (RFC 2142 role addresses and common service
 * names). Compared after lower-casing and, additionally, with the separators
 * . - _ removed (`no.reply`, `post-master`).
 */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'postmaster', 'abuse', 'admin', 'administrator', 'root', 'hostmaster', 'webmaster',
  'noreply', 'no-reply', 'mailer-daemon', 'mailerdaemon', 'security', 'support', 'info',
]);

/** Lower-case letters, digits and . - _ ; starts and ends with a letter or digit; no doubled separators; 1–64 characters. */
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** The normalised local part, or null when its syntax is not allowed. */
export function normalizeLocalPart(raw: string): string | null {
  const lp = raw.trim().toLowerCase();
  if (!LOCAL_PART_RE.test(lp)) return null;
  if (/[._-]{2}/.test(lp)) return null;
  return lp;
}

export function isReservedLocalPart(localPart: string): boolean {
  const lp = localPart.toLowerCase();
  return RESERVED_LOCAL_PARTS.has(lp) || RESERVED_LOCAL_PARTS.has(lp.replace(/[._-]/g, ''));
}

/** Display name: trimmed, no control characters, 1–100 characters. */
export function normalizeDisplayName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (name.length < 1 || name.length > 100 || /[\u0000-\u001f\u007f<>]/.test(name)) return null;
  return name;
}

// ── Invite codes ─────────────────────────────────────────────────────────────

/** Crockford base32 (no I, L, O, U — nothing to confuse when typed). */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A new invite code: 16 characters (80 bits) in groups of four, e.g. `7KQ2-…`. */
export function generateInviteCode(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += CODE_ALPHABET[bytes[i]! % 32];
  }
  return out;
}

/** Upper-case, without spaces and dashes; empty for anything that cannot be a code. */
export function normalizeInviteCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  return /^[0-9A-Z]{8,64}$/.test(s) ? s : '';
}

export function hashInviteCode(code: string): string {
  return createHash('sha256').update(`coremail-invite:${normalizeInviteCode(code)}`).digest('hex');
}

export interface InviteRow {
  id: string;
  expiresAt: Date | null;
  maxUses: number;
  uses: number;
  revokedAt: Date | null;
}

export type InviteStatus = 'active' | 'expired' | 'used' | 'revoked';

export function inviteStatus(inv: InviteRow, now = new Date()): InviteStatus {
  if (inv.revokedAt) return 'revoked';
  if (inv.expiresAt && inv.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (inv.uses >= inv.maxUses) return 'used';
  return 'active';
}

// ── Form token (minimum fill time) ───────────────────────────────────────────

/** A form submitted faster than this is treated as automated. */
export const MIN_FILL_MS = 3_000;
/** A form token is accepted this long after it was issued. */
export const FORM_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function formKey(): Buffer {
  const secret = process.env['JWT_SECRET'] ?? '';
  return createHash('sha256').update(`coremail-self-registration-form|${secret}`).digest();
}

/** Signed issue time of a registration form (handed out by GET /auth/register/config). */
export function issueFormToken(now = Date.now()): string {
  const nonce = randomBytes(8).toString('hex');
  const payload = `${now.toString(36)}.${nonce}`;
  const sig = createHmac('sha256', formKey()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export type FormTokenVerdict = 'ok' | 'invalid' | 'too-fast' | 'expired';

export function checkFormToken(token: unknown, now = Date.now()): FormTokenVerdict {
  if (typeof token !== 'string' || token.length > 200) return 'invalid';
  const parts = token.split('.');
  if (parts.length !== 3) return 'invalid';
  const [ts, nonce, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', formKey()).update(`${ts}.${nonce}`).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, 'base64url'); } catch { return 'invalid'; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
  const issued = parseInt(ts, 36);
  if (!Number.isFinite(issued)) return 'invalid';
  const age = now - issued;
  if (age < MIN_FILL_MS) return 'too-fast';
  if (age > FORM_TOKEN_TTL_MS) return 'expired';
  return 'ok';
}
