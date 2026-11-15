/**
 * The single web/API login service (v7.0.0) — used by POST /auth/login and
 * POST /auth/mfa/verify in the api-gateway and (delegated) the auth-service.
 *
 * Steps: first factor (local password, then registered external
 * authenticators such as LDAP/OIDC) → active check → maintenance mode
 * (admins exempt) → MFA decision (challenge) → session issue.
 *
 * Extension point: `registerAuthenticator()` adds an external first-factor step
 * (LDAP, SSO, …). Steps run in registration order after the local password
 * check failed (or the user has no local password). A step returns the CoreMail
 * userId it authenticated, or null.
 */
import { createLogger, hashPassword, verifyPassword } from '@coremail/core';
import { prisma } from '../prisma/index.js';
import { maintenanceBlock } from './policy.js';
import { issueSession, type ClientInfo, type TokenPair } from './sessions.js';
import {
  consumeMfaChallenge, createMfaChallenge, getMfaChallenge, isMfaIpBlocked, registerMfaFailure, registerMfaIpFailure,
  type MfaChallengeData, type MfaMethod,
} from './mfa-challenge.js';
import { verifyUserTotp } from './totp.js';
import { consumeBackupCode } from './backup-codes.js';

const log = createLogger('auth:login');

// ── Extension point ───────────────────────────────────────────────────────────

export interface AuthenticatorUser {
  id: string;
  email: string;
  authSource: string;
  active: boolean;
  hasLocalPassword: boolean;
}

export interface ExternalAuthenticator {
  /** Unique name, also used as the `source` of the login (e.g. 'ldap', 'oidc'). */
  name: string;
  /**
   * Verify the credentials. `user` is the CoreMail user with that email, if
   * any (a step may provision users itself). Return the authenticated userId
   * or null. Throwing counts as "not authenticated".
   */
  authenticate(email: string, password: string, user: AuthenticatorUser | null): Promise<{ userId: string } | null>;
}

const authenticators: ExternalAuthenticator[] = [];

export function registerAuthenticator(a: ExternalAuthenticator): void {
  const idx = authenticators.findIndex((x) => x.name === a.name);
  if (idx >= 0) authenticators[idx] = a;
  else authenticators.push(a);
}

export function unregisterAuthenticator(name: string): void {
  const idx = authenticators.findIndex((x) => x.name === name);
  if (idx >= 0) authenticators.splice(idx, 1);
}

export function listAuthenticators(): string[] {
  return authenticators.map((a) => a.name);
}

// ── First factor ──────────────────────────────────────────────────────────────

let dummyHash: Promise<string> | null = null;
/** Burns the same bcrypt work for unknown users / users without a local password. */
async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword(`dummy-${Math.random()}`);
  await verifyPassword(password, await dummyHash).catch(() => false);
}

const userSelect = {
  id: true, email: true, role: true, domainId: true, active: true, passwordHash: true, authSource: true,
} as const;

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  domainId: string;
  source: string;
}

/**
 * Verifies email + password against the local hash and the registered
 * authenticators. Returns the active user or null (never reveals why).
 */
export async function authenticatePassword(email: string, password: string): Promise<AuthenticatedUser | null> {
  const normalized = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalized }, select: userSelect });

  if (user?.passwordHash) {
    const ok = await verifyPassword(password, user.passwordHash).catch(() => false);
    if (ok) {
      if (!user.active) return null;
      return { id: user.id, email: user.email, role: user.role, domainId: user.domainId, source: 'local' };
    }
  } else {
    await dummyVerify(password);
  }

  if (user && !user.active) return null;
  for (const step of authenticators) {
    let r: { userId: string } | null = null;
    try {
      r = await step.authenticate(normalized, password, user
        ? { id: user.id, email: user.email, authSource: user.authSource, active: user.active, hasLocalPassword: !!user.passwordHash }
        : null);
    } catch (err) {
      log.warn({ err, step: step.name }, 'Authenticator step failed');
    }
    if (!r) continue;
    const u = await prisma.user.findUnique({ where: { id: r.userId }, select: userSelect });
    if (u?.active) return { id: u.id, email: u.email, role: u.role, domainId: u.domainId, source: step.name };
    return null;
  }
  return null;
}

// ── MFA decision ──────────────────────────────────────────────────────────────

export interface MfaState {
  enabled: boolean;
  totp: boolean;
  webauthn: boolean;
  backupCodes: number;
}

export async function getMfaState(userId: string): Promise<MfaState> {
  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  const webauthn = Array.isArray(mfa?.webAuthnCredentials) && (mfa!.webAuthnCredentials as unknown[]).length > 0;
  const totp = mfa?.totpEnabled === true;
  return { enabled: totp || webauthn, totp, webauthn, backupCodes: mfa?.backupCodes.length ?? 0 };
}

// ── Outcomes ──────────────────────────────────────────────────────────────────

export type LoginOutcome =
  | { kind: 'tokens'; tokens: TokenPair; userId: string; source: string }
  | { kind: 'mfa'; challengeToken: string; method: MfaChallengeData['method']; methods: MfaMethod[]; userId: string }
  | { kind: 'invalid' }
  | { kind: 'maintenance'; message: string }
  | { kind: 'mfa_failed'; exhausted: boolean }
  | { kind: 'mfa_ip_blocked' };

/** HTTP mapping shared by every router that exposes the login service. */
export function loginOutcomeToHttp(o: LoginOutcome): { status: number; body: Record<string, unknown> } {
  switch (o.kind) {
    case 'tokens': return { status: 200, body: { ...o.tokens } };
    case 'mfa': return { status: 200, body: { mfaRequired: true, challengeToken: o.challengeToken, method: o.method, methods: o.methods } };
    case 'invalid': return { status: 401, body: { error: 'Invalid credentials' } };
    case 'maintenance': return { status: 503, body: { error: 'maintenance', message: o.message } };
    case 'mfa_failed': return o.exhausted
      ? { status: 401, body: { error: 'Too many failed attempts — please log in again', code: 'MFA_CHALLENGE_EXHAUSTED' } }
      : { status: 401, body: { error: 'MFA verification failed', code: 'MFA_INVALID_CODE' } };
    case 'mfa_ip_blocked': return { status: 429, body: { error: 'Too many failed MFA attempts. Please try again later.' } };
  }
}

/** POST /auth/login */
export async function login(email: string, password: string, client: ClientInfo): Promise<LoginOutcome> {
  const user = await authenticatePassword(email, password);
  if (!user) {
    log.warn({ email, ip: client.ip }, 'Login failed');
    return { kind: 'invalid' };
  }

  const blocked = await maintenanceBlock(user.role);
  if (blocked) {
    log.info({ userId: user.id }, 'Login blocked — maintenance mode active');
    return { kind: 'maintenance', message: blocked };
  }

  const mfa = await getMfaState(user.id);
  if (mfa.enabled) {
    const method = mfa.webauthn ? 'webauthn' : 'totp';
    const methods: MfaMethod[] = [];
    if (mfa.webauthn) methods.push('webauthn');
    if (mfa.totp) methods.push('totp');
    if (mfa.backupCodes > 0) methods.push('backup_code');
    const challengeToken = await createMfaChallenge(user.id, method, methods);
    log.info({ userId: user.id, method }, 'MFA challenge issued');
    return { kind: 'mfa', challengeToken, method, methods, userId: user.id };
  }

  const tokens = await issueSession(user, { ...client, mfaVerified: false });
  log.info({ userId: user.id, source: user.source }, 'Login successful');
  return { kind: 'tokens', tokens, userId: user.id, source: user.source };
}

export interface MfaVerifyInput {
  challengeToken: string;
  /** 6-digit TOTP code or a backup code (XXXX-XXXX / XXXXXXXX). */
  code?: string;
  /** Deprecated alias of `code` for backup codes. */
  backupCode?: string;
  webauthnResponse?: unknown;
}

export type WebAuthnVerifier = (userId: string, response: unknown, challengeToken: string) => Promise<boolean>;

/** POST /auth/mfa/verify */
export async function completeMfaLogin(
  input: MfaVerifyInput,
  client: ClientInfo,
  opts: { verifyWebAuthn?: WebAuthnVerifier } = {},
): Promise<LoginOutcome> {
  if (await isMfaIpBlocked(client.ip)) {
    log.warn({ ip: client.ip }, 'MFA verify blocked — too many failures from this IP');
    return { kind: 'mfa_ip_blocked' };
  }
  const challenge = await getMfaChallenge(input.challengeToken);
  if (!challenge) {
    await registerMfaIpFailure(client.ip); // guessing challenge tokens counts too
    return { kind: 'mfa_failed', exhausted: false };
  }

  const code = (input.code ?? input.backupCode ?? '').trim();
  let verified = false;
  if (input.webauthnResponse !== undefined && input.webauthnResponse !== null) {
    if (opts.verifyWebAuthn && challenge.methods.includes('webauthn')) {
      verified = await opts.verifyWebAuthn(challenge.userId, input.webauthnResponse, input.challengeToken).catch(() => false);
    }
  } else if (/^\d{6}$/.test(code)) {
    verified = await verifyUserTotp(challenge.userId, code);
  } else if (code) {
    verified = await consumeBackupCode(challenge.userId, code);
    if (verified) log.warn({ userId: challenge.userId }, 'Backup code used for login');
  }

  if (!verified) {
    const exhausted = await registerMfaFailure(input.challengeToken, client.ip);
    log.warn({ userId: challenge.userId, ip: client.ip, exhausted }, 'MFA verification failed');
    return { kind: 'mfa_failed', exhausted };
  }
  if (!(await consumeMfaChallenge(input.challengeToken))) return { kind: 'mfa_failed', exhausted: false };

  const user = await prisma.user.findUnique({
    where: { id: challenge.userId },
    select: { id: true, email: true, role: true, domainId: true, active: true },
  });
  if (!user?.active) return { kind: 'invalid' };
  const blocked = await maintenanceBlock(user.role);
  if (blocked) return { kind: 'maintenance', message: blocked };

  const tokens = await issueSession(user, { ...client, mfaVerified: true });
  log.info({ userId: user.id }, 'MFA verified — login complete');
  return { kind: 'tokens', tokens, userId: user.id, source: 'mfa' };
}
