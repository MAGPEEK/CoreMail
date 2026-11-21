/**
 * Re-authentication for security-sensitive account changes (MFA setup/disable,
 * backup-code regeneration, WebAuthn registration): the request must carry the
 * current password, a fresh MFA code (TOTP or backup code) or — 10.6 — a
 * passkey assertion (`webauthnFlowId` from POST /auth/passkeys/reauth/options
 * + `webauthnResponse`, user verification required).
 * Failed attempts are limited per user (REAUTH_MAX_FAILURES per window).
 */
import { prisma } from '../prisma/index.js';
import { authenticatePassword } from './login-service.js';
import { verifyUserTotp } from './totp.js';
import { consumeBackupCode } from './backup-codes.js';
import { authRedis, incrWithTtl } from './redis.js';

const FAIL_PREFIX = 'auth:reauth:fail:';
export const REAUTH_MAX_FAILURES = 10;
const WINDOW = 15 * 60;

export interface ReauthInput {
  currentPassword?: unknown;
  mfaCode?: unknown;
  /** 10.6: passkey re-authentication. */
  webauthnFlowId?: unknown;
  webauthnResponse?: unknown;
}

export type ReauthResult = 'ok' | 'missing' | 'invalid' | 'locked';

/** 10.6: (userId, flowId, response) → valid passkey assertion of this user. */
export type ReauthWebAuthnVerifier = (userId: string, flowId: unknown, response: unknown) => Promise<boolean>;
let webauthnVerifier: ReauthWebAuthnVerifier | null = null;

/**
 * Registered by @coremail/storage/auth/webauthn on import — services that do
 * not load the WebAuthn library refuse passkey re-authentication ('invalid').
 */
export function registerReauthWebAuthnVerifier(fn: ReauthWebAuthnVerifier | null): void {
  webauthnVerifier = fn;
}

export async function verifyReauth(userId: string, input: ReauthInput): Promise<ReauthResult> {
  const password = typeof input.currentPassword === 'string' ? input.currentPassword : '';
  const code = typeof input.mfaCode === 'string' ? input.mfaCode.trim() : '';
  const withPasskey = input.webauthnResponse !== undefined && input.webauthnResponse !== null;
  if (!password && !code && !withPasskey) return 'missing';

  const failKey = `${FAIL_PREFIX}${userId}`;
  if (Number((await authRedis().get(failKey)) ?? 0) >= REAUTH_MAX_FAILURES) return 'locked';

  let ok = false;
  if (withPasskey) {
    ok = webauthnVerifier ? await webauthnVerifier(userId, input.webauthnFlowId, input.webauthnResponse).catch(() => false) : false;
  } else if (password) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, passwordLoginDisabled: true } });
    // 10.6: a passkey-only account cannot confirm with its (disabled) password
    if (user && user.passwordLoginDisabled !== true) ok = (await authenticatePassword(user.email, password))?.id === userId;
  } else if (/^\d{6}$/.test(code)) {
    ok = await verifyUserTotp(userId, code);
  } else {
    ok = await consumeBackupCode(userId, code);
  }

  if (!ok) {
    await incrWithTtl(failKey, WINDOW);
    return 'invalid';
  }
  return 'ok';
}

/**
 * HTTP mapping of a failed re-auth. 403, never 401: the caller's session is
 * valid, only the confirmation was missing or wrong. A 401 made the frontends
 * refresh the token, re-send the request (a second counted failure) and log out.
 */
export function reauthErrorBody(r: Exclude<ReauthResult, 'ok'>): { status: number; body: Record<string, unknown> } {
  switch (r) {
    case 'missing': return { status: 403, body: { error: 'Re-authentication required (currentPassword, mfaCode or a passkey)', code: 'REAUTH_REQUIRED' } };
    case 'invalid': return { status: 403, body: { error: 'Re-authentication failed', code: 'REAUTH_FAILED' } };
    case 'locked': return { status: 429, body: { error: 'Too many failed re-authentication attempts', code: 'REAUTH_LOCKED' } };
  }
}
