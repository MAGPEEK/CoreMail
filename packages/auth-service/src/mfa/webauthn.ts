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
import { getPrisma } from '@coremail/storage';
import { getRedis, CHANNEL_PREFIX } from '@coremail/core';
import { createLogger } from '@coremail/core';
import { randomBytes } from 'node:crypto';

const log = createLogger('auth:webauthn');

const RP_NAME = process.env['WEBAUTHN_RP_NAME'] ?? 'CoreMail';
const RP_ID = process.env['WEBAUTHN_RP_ID'] ?? 'localhost';
const ORIGIN = process.env['WEBAUTHN_ORIGIN'] ?? 'http://localhost:4000';
const CHALLENGE_TTL = 5 * 60; // 5 minutes

function challengeKey(userId: string): string {
  return `${CHANNEL_PREFIX}webauthn:challenge:${userId}`;
}

export async function startWebAuthnRegistration(userId: string, email: string) {
  const prisma = getPrisma();
  const redis = getRedis();

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
  const prisma = getPrisma();
  const redis = getRedis();

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

    const { credential } = verification.registrationInfo;

    const mfa = await prisma.userMfa.findUnique({ where: { userId } });
    const existing: unknown[] = (mfa?.webAuthnCredentials as unknown[]) ?? [];

    await prisma.userMfa.upsert({
      where: { userId },
      create: {
        userId,
        webAuthnCredentials: [
          ...existing,
          {
            id: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString('base64'),
            counter: credential.counter,
            name: keyName,
            createdAt: new Date().toISOString(),
          },
        ],
      },
      update: {
        webAuthnCredentials: [
          ...existing,
          {
            id: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString('base64'),
            counter: credential.counter,
            name: keyName,
            createdAt: new Date().toISOString(),
          },
        ],
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

export async function startWebAuthnAuthentication(userId: string) {
  const prisma = getPrisma();
  const redis = getRedis();

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
  const prisma = getPrisma();
  const redis = getRedis();

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
    const verification = await verifyAuthenticationResponse({
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
