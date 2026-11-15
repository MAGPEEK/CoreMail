import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { prisma } from '@coremail/storage';
import { encryptMfaSecret, publishUserAuthChange, verifyUserTotp } from '@coremail/storage/auth';
import { createLogger } from '@coremail/core';

const log = createLogger('auth:totp');

/**
 * Generates a new (pending, not yet enabled) TOTP secret. v7.0.0: the secret
 * is stored AES-256-GCM encrypted (see @coremail/storage/auth mfa-crypto).
 * Callers must refuse this while TOTP is enabled (no silent overwrite).
 */
export async function setupTotp(
  userId: string,
  issuer: string,
  accountName: string,
): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
  const totp = new OTPAuth.TOTP({
    issuer,
    label: accountName,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });

  const secret = totp.secret.base32;
  const otpauthUrl = totp.toString();
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

  const stored = encryptMfaSecret(secret);
  await prisma.userMfa.upsert({
    where: { userId },
    create: { userId, totpSecret: stored, totpEnabled: false, totpLastUsedStep: null },
    update: { totpSecret: stored, totpEnabled: false, totpLastUsedStep: null },
  });

  // No 'mfa-change' event here (8.0.0): a pending secret changes no credential —
  // the account password stays valid on the mail protocols until TOTP is
  // confirmed, and verifyUserTotp() publishes the event when it enables TOTP.
  // Publishing here ended every live mail connection of a user who merely
  // opened (and possibly cancelled) the setup dialog.
  log.info({ userId }, 'TOTP secret generated (not yet confirmed)');
  return { secret, otpauthUrl, qrCodeDataUrl };
}

/** Confirms the pending secret with a code from the authenticator app and enables TOTP. */
export async function confirmTotp(userId: string, code: string): Promise<boolean> {
  const ok = await verifyUserTotp(userId, code, { requireEnabled: false });
  if (ok) log.info({ userId }, 'TOTP confirmed and enabled');
  return ok;
}

/** Verifies a code of the enabled TOTP (with replay protection). */
export async function verifyTotp(userId: string, code: string): Promise<boolean> {
  return verifyUserTotp(userId, code);
}

export async function disableTotp(userId: string): Promise<void> {
  await prisma.userMfa.updateMany({
    where: { userId },
    data: { totpSecret: null, totpEnabled: false, totpLastUsedStep: null },
  });
  await publishUserAuthChange(userId, 'mfa-change');
}
