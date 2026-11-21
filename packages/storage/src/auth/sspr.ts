/**
 * 10.6: self-service password reset (SSPR) policy — docs/password-reset.md.
 *
 * Decides WHETHER an account may reset its password by e-mail link and WHERE
 * the link goes. The HTTP layer (api-gateway routes/auth.ts) answers every
 * request identically; this module never leaks its decision to the caller.
 *
 *   policy      ServerSettings.selfServicePasswordReset (switch) +
 *               ssprRecoveryEmailEnabled / ssprOwnMailboxEnabled (methods) +
 *               ssprAllowAdmins (accounts with role ≠ USER; default off)
 *   accounts    active LOCAL accounts only (LDAP / OIDC accounts use their
 *               directory); admin roles only with ssprAllowAdmins; accounts
 *               whose only second factor cannot be proven on the reset page
 *               (security keys without TOTP / backup codes) get no link
 *   channels    the CONFIRMED external recovery address (auth/recovery-email.ts)
 *               and/or the account's own INBOX — the latter only while nobody
 *               else can read it (a delegate of the mailbox or a folder grant
 *               with the read right): a link in a mailbox a delegate reads is
 *               an account takeover by that delegate.
 *
 * Server level only (no per-domain override in 10.6).
 */
import { prisma } from '../prisma/index.js';

export interface SsprPolicy {
  /** Master switch (ServerSettings.selfServicePasswordReset). */
  enabled: boolean;
  /** Method "recovery address" (ServerSettings.ssprRecoveryEmailEnabled). */
  recoveryEmail: boolean;
  /** Method "own mailbox" (ServerSettings.ssprOwnMailboxEnabled). */
  ownMailbox: boolean;
  /** Accounts with an admin role take part (ServerSettings.ssprAllowAdmins). */
  allowAdmins: boolean;
}

/** Schema defaults (a never-written settings row). */
export const SSPR_DEFAULTS: Readonly<SsprPolicy> = Object.freeze({
  enabled: true, recoveryEmail: true, ownMailbox: true, allowAdmins: false,
});

/** The ServerSettings columns of the policy (admin API + tests). */
export const SSPR_SETTINGS_FIELDS = {
  enabled: 'selfServicePasswordReset',
  recoveryEmail: 'ssprRecoveryEmailEnabled',
  ownMailbox: 'ssprOwnMailboxEnabled',
  allowAdmins: 'ssprAllowAdmins',
} as const;

type SettingsRow = Partial<Record<(typeof SSPR_SETTINGS_FIELDS)[keyof typeof SSPR_SETTINGS_FIELDS], unknown>> | null | undefined;

/** Pure: the policy of a settings row (missing / non-boolean values → defaults). */
export function ssprPolicyOf(row: SettingsRow): SsprPolicy {
  const pick = (k: keyof SsprPolicy): boolean => {
    const v = row?.[SSPR_SETTINGS_FIELDS[k]];
    return typeof v === 'boolean' ? v : SSPR_DEFAULTS[k];
  };
  return { enabled: pick('enabled'), recoveryEmail: pick('recoveryEmail'), ownMailbox: pick('ownMailbox'), allowAdmins: pick('allowAdmins') };
}

/** The current policy. No cache: read once per reset request. A failed read → SSPR off (fail closed). */
export async function loadSsprPolicy(): Promise<SsprPolicy> {
  try {
    const row = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    return ssprPolicyOf(row as SettingsRow);
  } catch {
    return { ...SSPR_DEFAULTS, enabled: false };
  }
}

/** Pure: is a reset possible at all (switch on and at least one method)? */
export function ssprAvailable(p: SsprPolicy): boolean {
  return p.enabled && (p.recoveryEmail || p.ownMailbox);
}

/** Pure: may an account with `role` use SSPR? */
export function ssprRoleAllowed(role: string | null | undefined, p: SsprPolicy): boolean {
  return (role ?? 'USER') === 'USER' || p.allowAdmins;
}

// ── Second factors ───────────────────────────────────────────────────────────

export interface ResetFactors {
  totp: boolean;
  backupCodes: boolean;
  webauthn: boolean;
  /** Any second factor enrolled → the reset page needs a second proof. */
  any: boolean;
  /** A factor the reset page can verify (TOTP or a backup code). */
  provable: boolean;
}

/** Pure: factors of a UserMfa row (null = none). */
export function resetFactorsOf(mfa: { totpEnabled?: boolean | null; backupCodes?: unknown; webAuthnCredentials?: unknown } | null | undefined): ResetFactors {
  const totp = mfa?.totpEnabled === true;
  const backupCodes = Array.isArray(mfa?.backupCodes) && mfa.backupCodes.length > 0;
  const webauthn = Array.isArray(mfa?.webAuthnCredentials) && mfa.webAuthnCredentials.length > 0;
  return { totp, backupCodes, webauthn, any: totp || backupCodes || webauthn, provable: totp || backupCodes };
}

/**
 * The enrolled factors of a user.
 * TODO(passkeys): replace with the central factor helper `getAuthFactors(userId)`
 * of branch `passkeys` once it is merged (passkeys then count as `webauthn`).
 */
export async function loadResetFactors(userId: string): Promise<ResetFactors> {
  const mfa = await prisma.userMfa.findUnique({
    where: { userId },
    select: { totpEnabled: true, backupCodes: true, webAuthnCredentials: true },
  });
  return resetFactorsOf(mfa);
}

// ── Own mailbox ──────────────────────────────────────────────────────────────

/** FolderRight.ReadAny (folder-permissions.ts) — kept local so the auth module stays light. */
const FOLDER_READ_ANY = 0x1;

/**
 * Can anybody other than the owner read the user's mailbox? Any delegate row
 * (whatever its permission — conservative) or any folder grant with the read
 * right (a user or "Default"). A failed lookup counts as readable (fail closed:
 * the own-mailbox method is then skipped). No mailbox → false (nothing to deliver to).
 */
export async function mailboxReadableByOthers(userId: string): Promise<boolean> {
  try {
    const mailbox = await prisma.mailbox.findFirst({ where: { userId }, select: { id: true } });
    if (!mailbox) return false;
    const delegates = await prisma.mailboxDelegate.count({ where: { mailboxId: mailbox.id } });
    if (delegates > 0) return true;
    const grants = await prisma.folderPermission.findMany({ where: { mailboxId: mailbox.id }, select: { rights: true } });
    return grants.some((g) => (g.rights & FOLDER_READ_ANY) !== 0);
  } catch {
    return true;
  }
}

// ── Planning a reset ─────────────────────────────────────────────────────────

export type ResetChannel = { kind: 'recovery'; address: string } | { kind: 'mailbox' };

export type SsprRefusal =
  | 'disabled'               // switch off or no method on
  | 'not_found'              // no such account
  | 'inactive'
  | 'external_directory'     // LDAP / OIDC account
  | 'admin_excluded'
  | 'password_login_disabled'
  | 'mfa_unprovable'         // only security keys — the reset page cannot verify them
  | 'no_channel';            // no confirmed recovery address and the own mailbox is skipped

export interface SsprUser { id: string; email: string; role: string; displayName: string }

export type SsprPlan =
  | { ok: true; user: SsprUser; channels: ResetChannel[]; mfaRequired: boolean }
  | { ok: false; reason: SsprRefusal; userId?: string };

/**
 * Decides whether `email` gets a reset link and where it goes. Never throws for
 * an unknown account; the caller answers identically whatever the outcome.
 */
export async function planPasswordReset(email: string, policy: SsprPolicy): Promise<SsprPlan> {
  if (!ssprAvailable(policy)) return { ok: false, reason: 'disabled' };
  const user = await prisma.user.findFirst({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, email: true, role: true, active: true, authSource: true, displayName: true },
  });
  if (!user) return { ok: false, reason: 'not_found' };
  const id = user.id;
  if (!user.active) return { ok: false, reason: 'inactive', userId: id };
  if (user.authSource !== 'LOCAL') return { ok: false, reason: 'external_directory', userId: id };
  if (!ssprRoleAllowed(user.role, policy)) return { ok: false, reason: 'admin_excluded', userId: id };
  // TODO(passkeys): refuse accounts with User.passwordLoginDisabled (passkey-only
  // accounts get no mail reset) once branch `passkeys` adds the column:
  //   if (user.passwordLoginDisabled) return { ok: false, reason: 'password_login_disabled', userId: id };

  const factors = await loadResetFactors(id);
  if (factors.any && !factors.provable) return { ok: false, reason: 'mfa_unprovable', userId: id };

  const channels: ResetChannel[] = [];
  if (policy.recoveryEmail) {
    const rec = await prisma.recoveryEmail.findUnique({ where: { userId: id }, select: { address: true, verifiedAt: true } });
    if (rec?.address && rec.verifiedAt) channels.push({ kind: 'recovery', address: rec.address });
  }
  if (policy.ownMailbox) {
    const hasMailbox = (await prisma.mailbox.count({ where: { userId: id } })) > 0;
    if (hasMailbox && !(await mailboxReadableByOthers(id))) channels.push({ kind: 'mailbox' });
  }
  if (channels.length === 0) return { ok: false, reason: 'no_channel', userId: id };
  return {
    ok: true,
    user: { id, email: user.email, role: user.role, displayName: user.displayName ?? '' },
    channels,
    mfaRequired: factors.any,
  };
}
