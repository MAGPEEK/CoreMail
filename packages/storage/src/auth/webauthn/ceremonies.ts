/**
 * 10.6: the WebAuthn ceremonies (W3C WebAuthn Level 3) — passkey registration,
 * usernameless passkey sign-in, passkey re-authentication, recovery, and the
 * security key as second factor after a password. Library:
 * @simplewebauthn/server 14.1.0 (pinned); attestation "none" (fmt and AAGUID
 * stored for display only), algorithms EdDSA / ES256 / RS256.
 *
 * User verification: passkey sign-in, registration and re-authentication
 * `required`; the second factor after a password `discouraged` and not
 * required (G1 — keys without PIN work).
 *
 * Every assertion (verifyAssertion): no cross-origin responses; the configured
 * origins and RP ID only (rp.ts); BE must equal the stored value (§6.1.3; a
 * migrated key adopts it on first use), BS is updated; signature counter
 * regression fails closed with audit `passkey.counter_regression` and a
 * security notice (both 0 = synced passkey, skipped); the counter is updated
 * conditionally (a concurrent use of the same counter fails).
 */
import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { cose, decodeClientDataJSON, decodeCredentialPublicKey, isoBase64URL } from '@simplewebauthn/server/helpers';
import { createLogger } from '@coremail/core';
import { prisma } from '../../prisma/index.js';
import { publishUserAuthChange } from '../invalidation.js';
import { notifySecurityEvent } from '../notify.js';
import { writeAuthAudit } from '../auth-audit.js';
import { cleanCredentialName, consumePasskeyRecoveryToken, peekPasskeyRecoveryToken, publicCredential, type PublicCredential } from '../passkeys.js';
import { loadPasskeyServerPolicy, passkeysAllowedFor } from '../passkey-policy.js';
import { maintenanceBlock } from '../policy.js';
import { protocolDisabledBody, webLoginBlocked, type WebSurface } from '../web-access.js';
import { issueSession, revokeAllSessions, type ClientInfo, type TokenPair } from '../sessions.js';
import { sharedLoginLockout } from '../../mail-auth.js';
import { connectGuard } from '../../connect-guard.js';
import { freezeRpId, getRpConfig, type RpConfig } from './rp.js';
import { newFlowId, storeChallenge, takeChallenge, type ChallengePurpose } from './challenges.js';

const log = createLogger('auth:webauthn');

/** EdDSA (RFC 9864 / 8812), ES256, RS256. */
export const SUPPORTED_ALGORITHMS: readonly number[] = [-8, -7, -257];
/** §7.1 step 25: credential ids longer than 1023 bytes are refused. */
export const MAX_CREDENTIAL_ID_BYTES = 1023;
const CEREMONY_TIMEOUT_MS = 120_000;
const KNOWN_TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

export type PasskeyErrorCode =
  | 'PASSKEY_CHALLENGE_EXPIRED' | 'PASSKEY_UNKNOWN' | 'PASSKEY_NOT_ELIGIBLE' | 'PASSKEY_INVALID'
  | 'PASSKEY_DUPLICATE' | 'PASSKEY_ID_TOO_LONG' | 'PASSKEY_COUNTER' | 'PASSKEYS_DISABLED'
  | 'PASSKEY_RECOVERY_INVALID';

// ── Request shapes ────────────────────────────────────────────────────────────

const b64u = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);

/** An AuthenticationResponseJSON from the browser, or null (size-limited, strings only). */
export function asAuthenticationResponse(x: unknown): AuthenticationResponseJSON | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  const resp = r['response'] as Record<string, unknown> | undefined;
  if (!b64u(r['id'], 1400) || !b64u(r['rawId'], 1400) || r['type'] !== 'public-key' || !resp || typeof resp !== 'object') return null;
  if (!b64u(resp['clientDataJSON'], 16_384) || !b64u(resp['authenticatorData'], 16_384) || !b64u(resp['signature'], 4096)) return null;
  const uh = resp['userHandle'];
  if (uh !== undefined && uh !== null && !b64u(uh, 200)) return null;
  const att = r['authenticatorAttachment'];
  return {
    id: r['id'] as string,
    rawId: r['rawId'] as string,
    type: 'public-key',
    response: {
      clientDataJSON: resp['clientDataJSON'] as string,
      authenticatorData: resp['authenticatorData'] as string,
      signature: resp['signature'] as string,
      ...(typeof uh === 'string' ? { userHandle: uh } : {}),
    },
    clientExtensionResults: {},
    ...(att === 'platform' || att === 'cross-platform' ? { authenticatorAttachment: att } : {}),
  };
}

/** A RegistrationResponseJSON from the browser, or null. */
export function asRegistrationResponse(x: unknown): RegistrationResponseJSON | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  const resp = r['response'] as Record<string, unknown> | undefined;
  if (!b64u(r['id'], 1400) || !b64u(r['rawId'], 1400) || r['type'] !== 'public-key' || !resp || typeof resp !== 'object') return null;
  if (!b64u(resp['clientDataJSON'], 16_384) || !b64u(resp['attestationObject'], 262_144)) return null;
  const transports = Array.isArray(resp['transports'])
    ? (resp['transports'] as unknown[]).filter((t): t is string => typeof t === 'string' && KNOWN_TRANSPORTS.has(t))
    : undefined;
  const ext = (r['clientExtensionResults'] ?? {}) as Record<string, unknown>;
  const credProps = ext['credProps'] as { rk?: unknown } | undefined;
  const att = r['authenticatorAttachment'];
  return {
    id: r['id'] as string,
    rawId: r['rawId'] as string,
    type: 'public-key',
    response: {
      clientDataJSON: resp['clientDataJSON'] as string,
      attestationObject: resp['attestationObject'] as string,
      ...(transports ? { transports: transports as NonNullable<RegistrationResponseJSON['response']['transports']> } : {}),
    },
    clientExtensionResults: credProps && typeof credProps.rk === 'boolean' ? { credProps: { rk: credProps.rk } } : {},
    ...(att === 'platform' || att === 'cross-platform' ? { authenticatorAttachment: att } : {}),
  };
}

function credentialIdBytes(id: string): number {
  try { return isoBase64URL.toBuffer(id).length; } catch { return Number.POSITIVE_INFINITY; }
}

/** clientDataJSON.crossOrigin === true (an iframe on another origin) — always refused. */
function isCrossOrigin(clientDataJSON: string): boolean {
  try { return decodeClientDataJSON(clientDataJSON).crossOrigin === true; } catch { return true; }
}

// ── User handle ───────────────────────────────────────────────────────────────

/** The user's stable random WebAuthn user handle (64 bytes, base64url) — created once. */
export async function ensureUserHandle(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { webauthnUserId: true } });
  if (u?.webauthnUserId) return u.webauthnUserId;
  const handle = randomBytes(64).toString('base64url');
  await prisma.user.updateMany({ where: { id: userId, webauthnUserId: null }, data: { webauthnUserId: handle } });
  const again = await prisma.user.findUnique({ where: { id: userId }, select: { webauthnUserId: true } });
  return again?.webauthnUserId ?? handle;
}

// ── Registration ──────────────────────────────────────────────────────────────

interface RegisterUser { id: string; email: string; displayName?: string | null }

async function excludeList(userId: string): Promise<Array<{ id: string; transports?: string[] }>> {
  const rows = await prisma.webAuthnCredential.findMany({ where: { userId }, select: { credentialId: true, transports: true } });
  return rows.map((r) => ({ id: r.credentialId, ...(r.transports.length ? { transports: r.transports } : {}) }));
}

export interface CeremonyOptions<T> { flowId: string; publicKey: T }

/**
 * Passkey registration options: discoverable credential required, user
 * verification required, credProps requested, attestation none.
 */
export async function passkeyRegistrationOptions(
  user: RegisterUser,
  ctx: { purpose: 'register' | 'recovery'; sessionId?: string | undefined; tokenId?: string | undefined },
): Promise<CeremonyOptions<PublicKeyCredentialCreationOptionsJSON>> {
  const rp = await getRpConfig();
  const handle = await ensureUserHandle(user.id);
  const publicKey = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.email,
    userID: isoBase64URL.toBuffer(handle),
    userDisplayName: user.displayName || user.email,
    timeout: CEREMONY_TIMEOUT_MS,
    attestationType: 'none',
    excludeCredentials: await excludeList(user.id),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    extensions: { credProps: true },
    supportedAlgorithmIDs: [...SUPPORTED_ALGORITHMS],
  });
  const flowId = newFlowId();
  await storeChallenge(flowId, {
    challenge: publicKey.challenge, purpose: ctx.purpose, rpId: rp.rpID, userId: user.id,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.tokenId ? { tokenId: ctx.tokenId } : {}),
  });
  return { flowId, publicKey };
}

interface PreparedCredential {
  credentialId: string;
  publicKey: Buffer;
  algorithm: number;
  signCount: bigint;
  transports: string[];
  rpId: string;
  discoverable: boolean | null;
  uvInitialized: boolean;
  backupEligible: boolean;
  backupState: boolean;
  aaguid: string;
  attestationFmt: string;
}

type RegistrationCheck = { ok: true; cred: PreparedCredential } | { ok: false; code: PasskeyErrorCode };

/** Verifies an attestation response (no database write). */
async function checkRegistration(
  rawResponse: unknown, expectedChallenge: string, rp: RpConfig, requireUserVerification: boolean,
): Promise<RegistrationCheck> {
  const response = asRegistrationResponse(rawResponse);
  if (!response) return { ok: false, code: 'PASSKEY_INVALID' };
  if (credentialIdBytes(response.id) > MAX_CREDENTIAL_ID_BYTES) return { ok: false, code: 'PASSKEY_ID_TOO_LONG' };
  if (isCrossOrigin(response.response.clientDataJSON)) return { ok: false, code: 'PASSKEY_INVALID' };
  let info;
  try {
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification,
      supportedAlgorithmIDs: [...SUPPORTED_ALGORITHMS],
    });
    if (!v.verified) return { ok: false, code: 'PASSKEY_INVALID' };
    info = v.registrationInfo;
  } catch (err) {
    log.info({ err: (err as Error).message }, 'WebAuthn registration response refused');
    return { ok: false, code: 'PASSKEY_INVALID' };
  }
  const credentialId = info.credential.id;
  if (credentialIdBytes(credentialId) > MAX_CREDENTIAL_ID_BYTES) return { ok: false, code: 'PASSKEY_ID_TOO_LONG' };
  const alg = decodeCredentialPublicKey(info.credential.publicKey).get(cose.COSEKEYS.alg);
  if (typeof alg !== 'number') return { ok: false, code: 'PASSKEY_INVALID' };
  const rk = response.clientExtensionResults.credProps?.rk;
  return {
    ok: true,
    cred: {
      credentialId,
      publicKey: Buffer.from(info.credential.publicKey),
      algorithm: alg,
      signCount: BigInt(info.credential.counter),
      transports: (response.response.transports ?? []).filter((t) => KNOWN_TRANSPORTS.has(t)),
      rpId: rp.rpID,
      discoverable: typeof rk === 'boolean' ? rk : null,
      uvInitialized: info.userVerified,
      backupEligible: info.credentialDeviceType === 'multiDevice',
      backupState: info.credentialBackedUp,
      aaguid: info.aaguid,
      attestationFmt: String(info.fmt),
    },
  };
}

/** Stores a verified credential; a credential id that exists (any user, §7.1 step 26) is refused. */
async function storeCredential(
  userId: string, cred: PreparedCredential, kind: 'passkey' | 'security_key', name: string, userHandle: string | null,
): Promise<{ ok: true; row: PublicCredential } | { ok: false; code: PasskeyErrorCode }> {
  const existing = await prisma.webAuthnCredential.findUnique({ where: { credentialId: cred.credentialId }, select: { id: true } });
  if (existing) return { ok: false, code: 'PASSKEY_DUPLICATE' };
  try {
    const row = await prisma.webAuthnCredential.create({
      data: { userId, kind, name, userHandle, ...cred },
    });
    return { ok: true, row: publicCredential(row) };
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return { ok: false, code: 'PASSKEY_DUPLICATE' };
    throw err;
  }
}

async function afterRegistration(
  userId: string, row: PublicCredential, ctx: { ip?: string | undefined; email?: string | undefined; recovery?: boolean },
): Promise<void> {
  await publishUserAuthChange(userId, 'mfa-change');
  await writeAuthAudit({
    action: ctx.recovery ? 'passkey.recovery_register' : row.kind === 'passkey' ? 'passkey.register' : 'passkey.security_key_register',
    actorId: userId, actorEmail: ctx.email, ipAddress: ctx.ip,
    targetType: 'mailbox', targetId: userId, targetName: ctx.email,
    changes: { credential: row.id, kind: row.kind, name: row.name, synced: row.synced, aaguid: row.aaguid },
  });
  const what = row.kind === 'passkey' ? 'passkey' : 'security key';
  void notifySecurityEvent({
    userId,
    subject: `Security notice: a new ${what} was added`,
    bodyText:
      `A new ${what} "${row.name}" was added to your account on ${new Date().toUTCString()}${ctx.ip ? ` (IP ${ctx.ip})` : ''}` +
      `${ctx.recovery ? ' with a recovery link from your administrator; every other session was signed out' : ''}.\n\n` +
      'Mail programs (IMAP, POP3, SMTP, ActiveSync, CalDAV/CardDAV, JMAP) need an app password while a second factor ' +
      'is set up.\n\nIf you did not add it, remove it under Settings → Security, change your password and inform your administrator.',
  });
}

export type RegistrationResult = { ok: true; credential: PublicCredential } | { ok: false; code: PasskeyErrorCode };

/** Completes a passkey registration of a signed-in user (`register` flow). */
export async function verifyPasskeyRegistration(input: {
  userId: string; flowId: unknown; response: unknown; name: unknown; ip?: string | undefined;
}): Promise<RegistrationResult> {
  const data = await takeChallenge(input.flowId);
  const rp = await getRpConfig();
  if (!data || data.purpose !== 'register' || data.userId !== input.userId || data.rpId !== rp.rpID) {
    return { ok: false, code: 'PASSKEY_CHALLENGE_EXPIRED' };
  }
  const checked = await checkRegistration(input.response, data.challenge, rp, true);
  if (!checked.ok) return checked;
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true, webauthnUserId: true } });
  if (!user?.webauthnUserId) return { ok: false, code: 'PASSKEY_CHALLENGE_EXPIRED' };
  const stored = await storeCredential(input.userId, checked.cred, 'passkey', cleanCredentialName(input.name, 'Passkey'), user.webauthnUserId);
  if (!stored.ok) return stored;
  await freezeRpId(rp.rpID);
  await afterRegistration(input.userId, stored.row, { ip: input.ip, email: user.email });
  log.info({ userId: input.userId, credential: stored.row.id, synced: stored.row.synced }, 'Passkey registered');
  return { ok: true, credential: stored.row };
}

// ── Security key as second factor (deprecated /auth/mfa/webauthn/register/*) ──

const securityKeyFlow = (userId: string) => `security-key-registration:${userId}`;

/** Options of the deprecated security-key registration (second factor only, UV discouraged — G1). */
export async function securityKeyRegistrationOptions(user: RegisterUser): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const rp = await getRpConfig();
  const handle = await ensureUserHandle(user.id);
  const publicKey = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.email,
    userID: isoBase64URL.toBuffer(handle),
    userDisplayName: user.displayName || user.email,
    timeout: CEREMONY_TIMEOUT_MS,
    attestationType: 'none',
    excludeCredentials: await excludeList(user.id),
    authenticatorSelection: { residentKey: 'discouraged', userVerification: 'discouraged' },
    supportedAlgorithmIDs: [...SUPPORTED_ALGORITHMS],
  });
  await storeChallenge(securityKeyFlow(user.id), {
    challenge: publicKey.challenge, purpose: 'security_key_register', rpId: rp.rpID, userId: user.id,
  });
  return publicKey;
}

export async function verifySecurityKeyRegistration(input: {
  userId: string; response: unknown; name: unknown; ip?: string | undefined;
}): Promise<RegistrationResult> {
  const data = await takeChallenge(securityKeyFlow(input.userId));
  const rp = await getRpConfig();
  if (!data || data.purpose !== 'security_key_register' || data.userId !== input.userId || data.rpId !== rp.rpID) {
    return { ok: false, code: 'PASSKEY_CHALLENGE_EXPIRED' };
  }
  const checked = await checkRegistration(input.response, data.challenge, rp, false);
  if (!checked.ok) return checked;
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true, webauthnUserId: true } });
  const stored = await storeCredential(
    input.userId, checked.cred, 'security_key', cleanCredentialName(input.name, 'Security key'), user?.webauthnUserId ?? null,
  );
  if (!stored.ok) return stored;
  await freezeRpId(rp.rpID);
  await afterRegistration(input.userId, stored.row, { ip: input.ip, email: user?.email });
  log.info({ userId: input.userId, credential: stored.row.id }, 'Security key registered (second factor)');
  return { ok: true, credential: stored.row };
}

// ── Assertions ────────────────────────────────────────────────────────────────

interface CredentialRecord {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  signCount: bigint;
  transports: string[];
  rpId: string;
  userHandle: string | null;
  kind: string;
  backupEligible: boolean | null;
  name: string;
}

const RECORD_SELECT = {
  id: true, userId: true, credentialId: true, publicKey: true, signCount: true, transports: true, rpId: true,
  userHandle: true, kind: true, backupEligible: true, name: true,
} as const;

async function credentialById(credentialId: string): Promise<CredentialRecord | null> {
  if (credentialIdBytes(credentialId) > MAX_CREDENTIAL_ID_BYTES) return null;
  return (await prisma.webAuthnCredential.findUnique({ where: { credentialId }, select: RECORD_SELECT })) as CredentialRecord | null;
}

type AssertionResult = { ok: true } | { ok: false; code: 'PASSKEY_INVALID' | 'PASSKEY_COUNTER' };

/** Pure §7.2 step 22 rule: a counter that does not grow (unless both are 0) is a regression. */
export function isCounterRegression(stored: number, received: number): boolean {
  return (received > 0 || stored > 0) && received <= stored;
}

/**
 * Verifies an assertion against a stored credential and updates its counter,
 * backup state and last use. The library's own counter check is bypassed
 * (counter 0) so a regression is only reported for a valid signature.
 */
async function verifyAssertion(
  row: CredentialRecord, response: AuthenticationResponseJSON, expectedChallenge: string, rp: RpConfig,
  requireUserVerification: boolean, ip: string | undefined,
): Promise<AssertionResult> {
  if (isCrossOrigin(response.response.clientDataJSON)) return { ok: false, code: 'PASSKEY_INVALID' };
  let info;
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification,
      credential: { id: row.credentialId, publicKey: new Uint8Array(row.publicKey), counter: 0, transports: row.transports },
    });
    if (!v.verified) return { ok: false, code: 'PASSKEY_INVALID' };
    info = v.authenticationInfo;
  } catch (err) {
    log.info({ err: (err as Error).message, credential: row.id }, 'WebAuthn assertion refused');
    return { ok: false, code: 'PASSKEY_INVALID' };
  }
  const be = info.credentialDeviceType === 'multiDevice';
  const bs = info.credentialBackedUp;
  if (row.backupEligible !== null && row.backupEligible !== be) {
    // §6.1.3: BE is fixed for a credential's lifetime — a change means another authenticator
    log.warn({ userId: row.userId, credential: row.id }, 'WebAuthn assertion refused — backup eligibility changed');
    await writeAuthAudit({
      action: 'passkey.backup_eligibility_changed', actorId: row.userId, ipAddress: ip,
      targetType: 'mailbox', targetId: row.userId, changes: { credential: row.id, stored: row.backupEligible, received: be },
      success: false,
    });
    return { ok: false, code: 'PASSKEY_INVALID' };
  }
  const stored = Number(row.signCount);
  const received = info.newCounter;
  if (isCounterRegression(stored, received)) {
    log.warn({ userId: row.userId, credential: row.id, stored, received }, 'WebAuthn signature counter regression — possible cloned authenticator');
    await writeAuthAudit({
      action: 'passkey.counter_regression', actorId: row.userId, ipAddress: ip,
      targetType: 'mailbox', targetId: row.userId, changes: { credential: row.id, name: row.name, stored, received },
      success: false, errorMsg: 'signature counter did not increase',
    });
    void notifySecurityEvent({
      userId: row.userId,
      subject: 'Security notice: a sign-in with a possibly copied passkey or security key was refused',
      bodyText:
        `A sign-in with "${row.name}" was refused on ${new Date().toUTCString()}${ip ? ` (IP ${ip})` : ''}: its signature counter ` +
        'did not increase, which can mean the key was copied.\n\nIf you did not try to sign in, remove this key under ' +
        'Settings → Security and inform your administrator.',
    });
    return { ok: false, code: 'PASSKEY_COUNTER' };
  }
  const updated = await prisma.webAuthnCredential.updateMany({
    where: { id: row.id, signCount: row.signCount },
    data: {
      signCount: BigInt(received),
      backupState: bs,
      ...(row.backupEligible === null ? { backupEligible: be } : {}),
      lastUsedAt: new Date(),
      ...(ip ? { lastUsedIp: ip.slice(0, 64) } : {}),
    },
  });
  if (updated.count !== 1) return { ok: false, code: 'PASSKEY_INVALID' }; // concurrent use with the same counter
  return { ok: true };
}

// ── Second factor after the password (MFA challenge) ──────────────────────────

const secondFactorFlow = (mfaChallengeToken: string) => `mfa:${mfaChallengeToken}`;

/** Options for the second factor of a pending MFA login: every credential of the user, UV discouraged (G1). */
export async function secondFactorOptions(userId: string, mfaChallengeToken: string): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
  const rows = await prisma.webAuthnCredential.findMany({ where: { userId }, select: { credentialId: true, transports: true } });
  if (rows.length === 0) return null;
  const rp = await getRpConfig();
  const publicKey = await generateAuthenticationOptions({
    rpID: rp.rpID,
    timeout: CEREMONY_TIMEOUT_MS,
    allowCredentials: rows.map((r) => ({ id: r.credentialId, ...(r.transports.length ? { transports: r.transports } : {}) })),
    userVerification: 'discouraged',
  });
  await storeChallenge(secondFactorFlow(mfaChallengeToken), { challenge: publicKey.challenge, purpose: 'second_factor', rpId: rp.rpID, userId });
  return publicKey;
}

/** The completeMfaLogin() verifier: single-use challenge (G7), user verification not required (G1). */
export async function verifySecondFactor(userId: string, rawResponse: unknown, mfaChallengeToken: string, ip?: string): Promise<boolean> {
  const data = await takeChallenge(secondFactorFlow(mfaChallengeToken));
  if (!data || data.purpose !== 'second_factor' || data.userId !== userId) return false;
  const response = asAuthenticationResponse(rawResponse);
  if (!response) return false;
  const row = await credentialById(response.id);
  if (!row || row.userId !== userId) return false;
  const rp = await getRpConfig();
  if (data.rpId !== rp.rpID) return false;
  return (await verifyAssertion(row, response, data.challenge, rp, false, ip)).ok;
}

// ── Usernameless passkey sign-in ──────────────────────────────────────────────

/** Options of the usernameless sign-in: no allowCredentials, user verification required. */
export async function passkeyLoginOptions(surface: WebSurface | undefined): Promise<CeremonyOptions<PublicKeyCredentialRequestOptionsJSON> | null> {
  const policy = await loadPasskeyServerPolicy();
  if (!policy.passwordless) return null;
  const rp = await getRpConfig();
  const publicKey = await generateAuthenticationOptions({ rpID: rp.rpID, timeout: CEREMONY_TIMEOUT_MS, userVerification: 'required' });
  const flowId = newFlowId();
  await storeChallenge(flowId, { challenge: publicKey.challenge, purpose: 'login', rpId: rp.rpID, surface: surface ?? 'admin' });
  return { flowId, publicKey };
}

export type PasskeyLoginOutcome =
  | { kind: 'tokens'; tokens: TokenPair; userId: string }
  | { kind: 'error'; status: number; body: Record<string, unknown>; headers?: Record<string, string> };

function loginError(status: number, code: string, error: string, extra: Record<string, unknown> = {}): PasskeyLoginOutcome {
  return { kind: 'error', status, body: { error, code, ...extra } };
}

/**
 * Usernameless passkey sign-in. Order: IP block list / IP lock (an ACCOUNT lock
 * does not apply — it protects passwords) → single-use challenge → credential
 * by id → kind passkey and the user handle of the response = the stored one =
 * User.webauthnUserId (§7.2) → signature, origin, RP ID, UV required, no
 * cross-origin → BE / counter → active, maintenance, Webmail switch, passkey
 * policy → session (mfaVerified, authMethod "passkey") → account counter reset.
 * Failures that are not policy decisions count against the client IP.
 *
 * Never uses or issues a "remember device" token (a passkey sign-in already is
 * the strongest factor; hook for that feature: none on this base).
 */
export async function completePasskeyLogin(flowId: unknown, rawResponse: unknown, client: ClientInfo): Promise<PasskeyLoginOutcome> {
  const lockout = sharedLoginLockout();
  const hints = { ipTrusted: client.ipTrusted !== false };
  if (connectGuard.isBlocked(client.ip)) {
    connectGuard.refused(client.ip, 'web', 'blocked', { stage: 'passkey-login' });
    return loginError(403, 'IP_BLOCKED', 'Access from this address is blocked');
  }
  const ipLock = await lockout.ipLockedFor(client.ip);
  if (ipLock > 0) {
    return {
      kind: 'error', status: 429,
      body: { error: 'Too many failed sign-in attempts from this address. Please try again later.', code: 'IP_LOCKED', retryAfter: ipLock },
      headers: { 'Retry-After': String(Math.max(1, ipLock)) },
    };
  }
  const fail = async (status: number, code: PasskeyErrorCode, error: string): Promise<PasskeyLoginOutcome> => {
    await lockout.failIp(client.ip, hints);
    return loginError(status, code, error);
  };

  const data = await takeChallenge(flowId);
  const rp = await getRpConfig();
  if (!data || data.purpose !== 'login' || data.rpId !== rp.rpID) {
    return loginError(401, 'PASSKEY_CHALLENGE_EXPIRED', 'The sign-in request expired — please try again');
  }
  const response = asAuthenticationResponse(rawResponse);
  if (!response) return fail(400, 'PASSKEY_INVALID', 'Invalid passkey response');
  const row = await credentialById(response.id);
  if (!row) return fail(401, 'PASSKEY_UNKNOWN', 'This passkey is not registered');
  if (row.kind !== 'passkey' || !row.userHandle) {
    return loginError(403, 'PASSKEY_NOT_ELIGIBLE', 'This security key can only be used as a second factor after the password');
  }
  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { id: true, email: true, role: true, domainId: true, active: true, webauthnUserId: true },
  });
  const handle = response.response.userHandle;
  if (!user || !handle || handle !== row.userHandle || user.webauthnUserId !== row.userHandle) {
    return fail(401, 'PASSKEY_INVALID', 'Passkey verification failed');
  }
  const checked = await verifyAssertion(row, response, data.challenge, rp, true, client.ip);
  if (!checked.ok) return fail(401, checked.code, 'Passkey verification failed');

  if (!user.active) return loginError(401, 'PASSKEY_INVALID', 'Passkey verification failed');
  const blocked = await maintenanceBlock(user.role);
  if (blocked) return { kind: 'error', status: 503, body: { error: 'maintenance', message: blocked } };
  // the surface of the request that receives the session (its cookie: cm_rt or cm_rt_bcp)
  if (await webLoginBlocked(user, client.surface)) return { kind: 'error', status: 403, body: protocolDisabledBody('webmail') };
  const policy = await loadPasskeyServerPolicy();
  if (!policy.passwordless || !(await passkeysAllowedFor(user))) {
    return loginError(403, 'PASSKEYS_DISABLED', 'Passkey sign-in is not enabled for this account');
  }

  // UV passkey sign-in = multi-factor (WebAuthn §6.2.3): MFA-verified session, no second factor.
  const tokens = await issueSession(user, { ...client, mfaVerified: true, authMethod: 'passkey' });
  await lockout.success(user.email.toLowerCase(), client.ip, { ...hints, admin: user.role !== 'USER' });
  log.info({ userId: user.id, credential: row.id }, 'Passkey sign-in successful');
  return { kind: 'tokens', tokens, userId: user.id };
}

// ── Re-authentication with a passkey ──────────────────────────────────────────

/** Re-auth options: the user's passkeys, UV required. Null without passkeys. */
export async function passkeyReauthOptions(userId: string, sessionId?: string | null): Promise<CeremonyOptions<PublicKeyCredentialRequestOptionsJSON> | null> {
  const rows = await prisma.webAuthnCredential.findMany({ where: { userId, kind: 'passkey' }, select: { credentialId: true, transports: true } });
  if (rows.length === 0) return null;
  const rp = await getRpConfig();
  const publicKey = await generateAuthenticationOptions({
    rpID: rp.rpID,
    timeout: CEREMONY_TIMEOUT_MS,
    allowCredentials: rows.map((r) => ({ id: r.credentialId, ...(r.transports.length ? { transports: r.transports } : {}) })),
    userVerification: 'required',
  });
  const flowId = newFlowId();
  await storeChallenge(flowId, { challenge: publicKey.challenge, purpose: 'reauth', rpId: rp.rpID, userId, ...(sessionId ? { sessionId } : {}) });
  return { flowId, publicKey };
}

/** verifyReauth() hook: a passkey assertion of this user for a `reauth` flow. */
export async function verifyPasskeyReauth(userId: string, flowId: unknown, rawResponse: unknown): Promise<boolean> {
  const data = await takeChallenge(flowId);
  if (!data || data.purpose !== 'reauth' || data.userId !== userId) return false;
  const response = asAuthenticationResponse(rawResponse);
  if (!response) return false;
  const row = await credentialById(response.id);
  if (!row || row.userId !== userId || row.kind !== 'passkey') return false;
  const rp = await getRpConfig();
  if (data.rpId !== rp.rpID) return false;
  return (await verifyAssertion(row, response, data.challenge, rp, true, undefined)).ok;
}

// ── Recovery link ─────────────────────────────────────────────────────────────

/** Registration options for a recovery link (no session). */
export async function recoveryRegistrationOptions(token: unknown): Promise<CeremonyOptions<PublicKeyCredentialCreationOptionsJSON> | { error: PasskeyErrorCode }> {
  const t = typeof token === 'string' ? await peekPasskeyRecoveryToken(token) : null;
  if (!t) return { error: 'PASSKEY_RECOVERY_INVALID' };
  const user = await prisma.user.findUnique({ where: { id: t.userId }, select: { id: true, email: true, displayName: true, domainId: true, active: true } });
  if (!user?.active) return { error: 'PASSKEY_RECOVERY_INVALID' };
  if (!(await passkeysAllowedFor(user))) return { error: 'PASSKEYS_DISABLED' };
  return passkeyRegistrationOptions(user, { purpose: 'recovery', tokenId: t.tokenId });
}

/**
 * Redeems a recovery link: the attestation is verified first, then the token
 * is claimed (single use), the passkey stored, every session revoked, a
 * security notice written and the event audited. No session is issued — the
 * user signs in with the new passkey.
 */
export async function completeRecovery(input: {
  token: unknown; flowId: unknown; response: unknown; name: unknown; ip?: string | undefined;
}): Promise<RegistrationResult> {
  const t = typeof input.token === 'string' ? await peekPasskeyRecoveryToken(input.token) : null;
  const data = await takeChallenge(input.flowId);
  if (!t) return { ok: false, code: 'PASSKEY_RECOVERY_INVALID' };
  const rp = await getRpConfig();
  if (!data || data.purpose !== 'recovery' || data.userId !== t.userId || data.tokenId !== t.tokenId || data.rpId !== rp.rpID) {
    return { ok: false, code: 'PASSKEY_CHALLENGE_EXPIRED' };
  }
  const user = await prisma.user.findUnique({ where: { id: t.userId }, select: { id: true, email: true, domainId: true, active: true, webauthnUserId: true } });
  if (!user?.active || !user.webauthnUserId) return { ok: false, code: 'PASSKEY_RECOVERY_INVALID' };
  if (!(await passkeysAllowedFor(user))) return { ok: false, code: 'PASSKEYS_DISABLED' };
  const checked = await checkRegistration(input.response, data.challenge, rp, true);
  if (!checked.ok) return checked;
  const dup = await prisma.webAuthnCredential.findUnique({ where: { credentialId: checked.cred.credentialId }, select: { id: true } });
  if (dup) return { ok: false, code: 'PASSKEY_DUPLICATE' };
  if (!(await consumePasskeyRecoveryToken(t.tokenId))) return { ok: false, code: 'PASSKEY_RECOVERY_INVALID' };
  const stored = await storeCredential(user.id, checked.cred, 'passkey', cleanCredentialName(input.name, 'Passkey'), user.webauthnUserId);
  if (!stored.ok) return stored;
  await freezeRpId(rp.rpID);
  await revokeAllSessions(user.id, { reason: 'passkey-recovery' });
  await afterRegistration(user.id, stored.row, { ip: input.ip, email: user.email, recovery: true });
  log.warn({ userId: user.id, credential: stored.row.id }, 'Passkey registered with a recovery link — all sessions revoked');
  return { ok: true, credential: stored.row };
}

// ── Signal API data ───────────────────────────────────────────────────────────

/** Data for PublicKeyCredential.signalAllAcceptedCredentials / signalCurrentUserDetails (§5.1.10). */
export async function passkeySignalData(userId: string): Promise<{
  rpId: string; userId: string | null; allAcceptedCredentialIds: string[]; name: string; displayName: string;
} | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true, webauthnUserId: true } });
  if (!user) return null;
  const rp = await getRpConfig();
  const rows = await prisma.webAuthnCredential.findMany({ where: { userId, kind: 'passkey' }, select: { credentialId: true } });
  return {
    rpId: rp.rpID,
    userId: user.webauthnUserId ?? null,
    allAcceptedCredentialIds: rows.map((r) => r.credentialId),
    name: user.email,
    displayName: user.displayName || user.email,
  };
}

export type { ChallengePurpose };
