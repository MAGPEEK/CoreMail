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
import { getRedisClient, createLogger } from '@coremail/core';

const log = createLogger('auth:webauthn');

const RP_NAME = process.env['WEBAUTHN_RP_NAME'] ?? 'CoreMail';
const RP_ID = process.env['WEBAUTHN_RP_ID'] ?? 'localhost';
const ORIGIN = process.env['WEBAUTHN_ORIGIN'] ?? 'http://localhost:4000';
const CHALLENGE_TTL = 5 * 60; // 5 minutes

function challengeKey(userId: string): string {
  return `coremail:webauthn:challenge:${userId}`;
}

export async function startWebAuthnRegistration(userId: string, email: string): Promise<unknown> {
  
  const redis = getRedisClient();

  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  const existingCredentials: { id: string }[] = [];
  if (mfa?.webAuthnCredentials) {
    const creds = mfa.webAuthnCredentials as { id: string }[];
    existingCredentials.push(...creds);
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: email,
    excludeCredentials: existingCredentials.map((c) => ({ id: c.id })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  await redis.setex(challengeKey(userId), CHALLENGE_TTL, options.challenge);
  return options;
}

export async function finishWebAuthnRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  keyName: string,
): Promise<boolean> {
  
  const redis = getRedisClient();

  const expectedChallenge = await redis.get(challengeKey(userId));
  if (!expectedChallenge) return false;

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) return false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { credential } = verification.registrationInfo as any;

    const mfa = await prisma.userMfa.findUnique({ where: { userId } });
    const existing = ((mfa?.webAuthnCredentials as object[]) ?? []) as object[];
    const newCred = {
      id: credential.id as string,
      publicKey: Buffer.from(credential.publicKey as Uint8Array).toString('base64'),
      counter: credential.counter as number,
      name: keyName,
      createdAt: new Date().toISOString(),
    };

    await prisma.userMfa.upsert({
      where: { userId },
      create: {
        userId,
        webAuthnCredentials: [...existing, newCred],
      },
      update: {
        webAuthnCredentials: [...existing, newCred],
      },
    });

    await redis.del(challengeKey(userId));
    log.info({ userId, keyName }, 'WebAuthn key registered');
    return true;
  } catch (err) {
    log.error({ err, userId }, 'WebAuthn registration verification failed');
    return false;
  }
}

export async function startWebAuthnAuthentication(userId: string): Promise<unknown> {
  
  const redis = getRedisClient();

  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  const creds = (mfa?.webAuthnCredentials as { id: string }[]) ?? [];
  if (creds.length === 0) return null;

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: creds.map((c) => ({ id: c.id })),
    userVerification: 'preferred',
  });

  await redis.setex(challengeKey(userId), CHALLENGE_TTL, options.challenge);
  return options;
}

export async function finishWebAuthnAuthentication(
  userId: string,
  response: AuthenticationResponseJSON,
): Promise<boolean> {
  
  const redis = getRedisClient();

  const expectedChallenge = await redis.get(challengeKey(userId));
  if (!expectedChallenge) return false;

  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  const creds = (mfa?.webAuthnCredentials as {
    id: string;
    publicKey: string;
    counter: number;
  }[]) ?? [];

  const credential = creds.find((c) => c.id === response.id);
  if (!credential) return false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verification = await (verifyAuthenticationResponse as any)({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
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

    await redis.del(challengeKey(userId));
    return true;
  } catch (err) {
    log.error({ err, userId }, 'WebAuthn authentication verification failed');
    return false;
  }
}
