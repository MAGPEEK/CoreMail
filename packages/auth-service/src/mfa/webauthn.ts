/**
 * Security keys as second factor — 10.6: thin delegates to the shared WebAuthn
 * ceremonies in @coremail/storage/auth/webauthn (which also implement the
 * passkeys). Credentials live in the WebAuthnCredential table (the deprecated
 * UserMfa.webAuthnCredentials JSON is only read by the startup backfill).
 *
 * Fixed in 10.6: user verification is not required for a second factor (G1),
 * credential ids are unique across users and ≤ 1023 bytes (G3), the expected
 * origin includes the external HTTPS port (G6), every challenge is single use
 * (G7, Redis `auth:passkey:chal:*`).
 */
import {
  securityKeyRegistrationOptions, verifySecurityKeyRegistration, secondFactorOptions, verifySecondFactor,
  type RegistrationResult,
} from '@coremail/storage/auth/webauthn';

/** DEPRECATED endpoint /auth/mfa/webauthn/register/start — options of a second-factor security key. */
export async function startWebAuthnRegistration(userId: string, email: string, displayName?: string): Promise<unknown> {
  return securityKeyRegistrationOptions({ id: userId, email, displayName: displayName ?? null });
}

/** DEPRECATED endpoint /auth/mfa/webauthn/register/finish. */
export async function finishWebAuthnRegistration(userId: string, response: unknown, keyName: string, ip?: string): Promise<RegistrationResult> {
  return verifySecurityKeyRegistration({ userId, response, name: keyName, ip });
}

/** Options for the second factor of a pending MFA login challenge (null: no credentials). */
export async function startWebAuthnAuthentication(userId: string, mfaChallengeToken: string): Promise<unknown> {
  return secondFactorOptions(userId, mfaChallengeToken);
}

/** The verifier of completeMfaLogin(). */
export async function finishWebAuthnAuthentication(userId: string, response: unknown, mfaChallengeToken: string, ip?: string): Promise<boolean> {
  return verifySecondFactor(userId, response, mfaChallengeToken, ip);
}
