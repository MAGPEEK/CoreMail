import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/types';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { authRedis } from '@coremail/storage/auth';

const log = createLogger('auth:webauthn');

const RP_NAME = process.env['WEBAUTHN_RP_NAME'] ?? 'CoreMail';
const CHALLENGE_TTL = 5 * 60; // 5 minutes

// v6.0.0: separate Redis keys for registration (per user) and authentication
// (per MFA login challenge) so one flow cannot overwrite/consume the other.
export function registrationChallengeKey(userId: string): string {
  return `coremail:webauthn:reg:${userId}`;
}
export function authenticationChallengeKey(mfaChallengeToken: string): string {
  return `coremail:webauthn:auth:${mfaChallengeToken}`;
}

export interface RpConfig { rpID: string; origin: string }
let rpCache: { value: RpConfig; expires: number } | null = null;

/**
 * v6.0.0: Relying party from ServerSettings.publicHostname (https://<host>);
 * WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN override. Cached for 60 s.
 */
export async function getRpConfig(): Promise<RpConfig> {
  const envId = process.env['WEBAUTHN_RP_ID']?.trim();
  const envOrigin = process.env['WEBAUTHN_ORIGIN']?.trim();
  if (envId && envOrigin) return { rpID: envId, origin: envOrigin };
  if (rpCache && rpCache.expires > Date.now()) return rpCache.value;
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { publicHostname: true },
  });
  const host = (s?.publicHostname || 'localhost').trim().toLowerCase();
  const value = { rpID: envId || host, origin: envOrigin || `https://${host}` };
  rpCache = { value, expires: Date.now() + 60_000 };
  return value;
}

export async function startWebAuthnRegistration(userId: string, email: string): Promise<unknown> {
  const redis = authRedis();
  const { rpID } = await getRpConfig();

  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  const existingCredentials = (Array.isArray(mfa?.webAuthnCredentials) ? mfa.webAuthnCredentials : []) as { id: string }[];

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: email,
    excludeCredentials: existingCredentials.map((c) => ({ id: c.id })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  await redis.setex(registrationChallengeKey(userId), CHALLENGE_TTL, options.challenge);
  return options;
}

export async function finishWebAuthnRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  keyName: string,
): Promise<boolean> {
  const redis = authRedis();
  const key = registrationChallengeKey(userId);
  const expectedChallenge = await redis.get(key);
  if (!expectedChallenge) return false;
  await redis.del(key); // single use, also on failure
  const { rpID, origin } = await getRpConfig();

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (!verification.verified || !verification.registrationInfo) return false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { credential } = verification.registrationInfo as any;

    const mfa = await prisma.userMfa.findUnique({ where: { userId } });
    const existing = (Array.isArray(mfa?.webAuthnCredentials) ? mfa.webAuthnCredentials : []) as object[];
    const newCred = {
      id: credential.id as string,
      publicKey: Buffer.from(credential.publicKey as Uint8Array).toString('base64'),
      counter: credential.counter as number,
      name: keyName,
      createdAt: new Date().toISOString(),
    };

    await prisma.userMfa.upsert({
      where: { userId },
      create: { userId, webAuthnCredentials: [...existing, newCred] },
      update: { webAuthnCredentials: [...existing, newCred] },
    });

    log.info({ userId, keyName }, 'WebAuthn key registered');
    return true;
  } catch (err) {
    log.error({ err, userId }, 'WebAuthn registration verification failed');
    return false;
  }
}

/** Options for the second factor of a pending MFA login challenge. */
export async function startWebAuthnAuthentication(userId: string, mfaChallengeToken: string): Promise<unknown> {
  const redis = authRedis();
  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  const creds = (Array.isArray(mfa?.webAuthnCredentials) ? mfa.webAuthnCredentials : []) as { id: string }[];
  if (creds.length === 0) return null;
  const { rpID } = await getRpConfig();

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: creds.map((c) => ({ id: c.id })),
    userVerification: 'preferred',
  });

  await redis.setex(authenticationChallengeKey(mfaChallengeToken), CHALLENGE_TTL, options.challenge);
  return options;
}

export async function finishWebAuthnAuthentication(
  userId: string,
  response: AuthenticationResponseJSON,
  mfaChallengeToken: string,
): Promise<boolean> {
  const redis = authRedis();
  const key = authenticationChallengeKey(mfaChallengeToken);
  const expectedChallenge = await redis.get(key);
  if (!expectedChallenge) return false;

  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  const creds = (Array.isArray(mfa?.webAuthnCredentials) ? mfa.webAuthnCredentials : []) as {
    id: string;
    publicKey: string;
    counter: number;
  }[];

  const credential = creds.find((c) => c.id === response?.id);
  if (!credential) return false;
  const { rpID, origin } = await getRpConfig();

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verification = await (verifyAuthenticationResponse as any)({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey, 'base64'),
        counter: credential.counter,
      },
    });

    if (!verification.verified) return false;

    const updatedCreds = creds.map((c) =>
      c.id === credential.id
        ? { ...c, counter: verification.authenticationInfo.newCounter }
        : c,
    );

    await prisma.userMfa.update({
      where: { userId },
      data: { webAuthnCredentials: updatedCreds },
    });

    await redis.del(key);
    return true;
  } catch (err) {
    log.error({ err, userId }, 'WebAuthn authentication verification failed');
    return false;
  }
}
